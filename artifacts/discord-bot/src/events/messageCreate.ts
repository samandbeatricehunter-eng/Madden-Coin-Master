import { Events, Message, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from "discord.js";
import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable,
  franchiseScheduleTable, franchiseRostersTable, franchiseProcessedGamesTable,
  pendingChannelPayoutsTable,
} from "@workspace/db";
import { eq, and, or, desc, isNotNull, inArray, count, sql } from "drizzle-orm";
import {
  isAdminUser, getOrCreateActiveSeason, getAllSections, getOrSeedRules,
} from "../lib/db-helpers.js";

// ── OpenAI client ──────────────────────────────────────────────────────────────

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

// ── Persistent escalation tracker ─────────────────────────────────────────────
// Escalation is stored per-user in the DB so it survives restarts.
// ROAST   → +1 (capped at 10)
// APOLOGY → −2 (floored at 0); multiple apologies stack
// HELP / SMALLTALK → no change (history carries forward)

async function getEscalationLevel(userId: string): Promise<number> {
  const [row] = await db
    .select({ lvl: usersTable.botEscalationLevel })
    .from(usersTable)
    .where(eq(usersTable.discordId, userId))
    .limit(1);
  return row?.lvl ?? 0;
}

async function recordInteraction(userId: string, msgType: string): Promise<void> {
  try {
    if (msgType === "ROAST") {
      await db
        .update(usersTable)
        .set({
          botEscalationLevel: sql`LEAST(10, ${usersTable.botEscalationLevel} + 1)`,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.discordId, userId));
    } else if (msgType === "APOLOGY") {
      await db
        .update(usersTable)
        .set({
          botEscalationLevel: sql`GREATEST(0, ${usersTable.botEscalationLevel} - 2)`,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.discordId, userId));
    }
    // HELP and SMALLTALK intentionally leave escalation unchanged
  } catch (err) {
    console.error("recordInteraction DB error:", err);
  }
}

// ── Simple caches (avoid hammering DB on every mention) ───────────────────────

const CACHE_TTL = 5 * 60_000; // 5 minutes
let rulesCache: { text: string; at: number } | null = null;
let adminCache: { ids: string[]; at: number } | null = null;

async function getCachedRules(): Promise<string> {
  if (rulesCache && Date.now() - rulesCache.at < CACHE_TTL) return rulesCache.text;

  const sections = await getAllSections();
  const parts: string[] = [];
  for (const [key, meta] of Object.entries(sections)) {
    const rules = await getOrSeedRules(key);
    if (!rules.length) continue;
    parts.push(`== ${meta.title} ==`);
    rules.forEach((r, i) => parts.push(`${i + 1}. ${r}`));
  }
  const text = parts.join("\n") || "(no rules on file)";
  rulesCache = { text, at: Date.now() };
  return text;
}

async function getCachedAdminIds(): Promise<string[]> {
  if (adminCache && Date.now() - adminCache.at < CACHE_TTL) return adminCache.ids;
  const rows = await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(eq(usersTable.isAdmin, true));
  const ids = rows.map(r => r.discordId);
  adminCache = { ids, at: Date.now() };
  return ids;
}

// ── User stat fetcher ──────────────────────────────────────────────────────────

const DEV_TRAIT_LABEL: Record<number, string> = {
  0: "Normal", 1: "Impact", 2: "Star", 3: "Superstar", 4: "X-Factor",
};

async function fetchUserStats(discordId: string) {
  const [user] = await db
    .select({
      team:             usersTable.team,
      balance:          usersTable.balance,
      allTimeH2HWins:   usersTable.allTimeH2HWins,
      allTimeH2HLosses: usersTable.allTimeH2HLosses,
    })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);

  const teamName = user?.team ?? "Unknown Team";
  let seasonWins = 0, seasonLosses = 0, pointDiff = 0;
  let recentGames: { label: string }[] = [];
  let topPlayers: { label: string }[] = [];

  try {
    const season = await getOrCreateActiveSeason();

    // Season record
    const [rec] = await db
      .select({
        wins:              userRecordsTable.wins,
        losses:            userRecordsTable.losses,
        pointDifferential: userRecordsTable.pointDifferential,
      })
      .from(userRecordsTable)
      .where(and(
        eq(userRecordsTable.discordId, discordId),
        eq(userRecordsTable.seasonId, season.id),
      ))
      .limit(1);
    if (rec) {
      seasonWins   = rec.wins;
      seasonLosses = rec.losses;
      pointDiff    = rec.pointDifferential;
    }

    // Last 5 completed games involving this team.
    // Only include games that have actually been processed (processedGameId set by the MCA webhook).
    // This prevents unplayed future weeks from showing up even if homeScore defaulted to 0.
    if (teamName !== "Unknown Team") {
      const games = await db
        .select({
          weekIndex:    franchiseScheduleTable.weekIndex,
          homeTeamName: franchiseScheduleTable.homeTeamName,
          awayTeamName: franchiseScheduleTable.awayTeamName,
          homeScore:    franchiseScheduleTable.homeScore,
          awayScore:    franchiseScheduleTable.awayScore,
          payoutType:   franchiseProcessedGamesTable.payoutType,
        })
        .from(franchiseScheduleTable)
        .innerJoin(
          franchiseProcessedGamesTable,
          eq(franchiseScheduleTable.processedGameId, franchiseProcessedGamesTable.gameId),
        )
        .where(and(
          eq(franchiseScheduleTable.seasonId, season.id),
          or(
            eq(franchiseScheduleTable.homeTeamName, teamName),
            eq(franchiseScheduleTable.awayTeamName, teamName),
          ),
        ))
        .orderBy(desc(franchiseScheduleTable.weekIndex))
        .limit(5);

      recentGames = games.map(g => {
        const isHome  = g.homeTeamName === teamName;
        const myScore = isHome ? g.homeScore! : g.awayScore!;
        const oppScore= isHome ? g.awayScore! : g.homeScore!;
        const opp     = isHome ? g.awayTeamName : g.homeTeamName;
        const result  = myScore > oppScore ? "W" : "L";
        const type    = g.payoutType === "h2h" ? "H2H" : "CPU";
        return { label: `Wk${g.weekIndex + 1}: ${result} ${myScore}-${oppScore} vs ${opp} (${type})` };
      });

      // Top 12 players by overall
      const roster = await db
        .select({
          firstName: franchiseRostersTable.firstName,
          lastName:  franchiseRostersTable.lastName,
          position:  franchiseRostersTable.position,
          overall:   franchiseRostersTable.overall,
          devTrait:  franchiseRostersTable.devTrait,
          age:       franchiseRostersTable.age,
        })
        .from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.teamName, teamName),
        ))
        .orderBy(desc(franchiseRostersTable.overall))
        .limit(12);

      topPlayers = roster.map(p => ({
        label: `${p.firstName} ${p.lastName} | ${p.position} | OVR ${p.overall} | ${DEV_TRAIT_LABEL[p.devTrait] ?? "Normal"}${p.age ? ` | Age ${p.age}` : ""}`,
      }));
    }
  } catch (_) {}

  return {
    team:             teamName,
    balance:          user?.balance ?? 0,
    allTimeH2HWins:   user?.allTimeH2HWins ?? 0,
    allTimeH2HLosses: user?.allTimeH2HLosses ?? 0,
    seasonWins,
    seasonLosses,
    pointDiff,
    recentGames,
    topPlayers,
  };
}

type UserStats = Awaited<ReturnType<typeof fetchUserStats>>;

// ── Static help summary (mirrors /help command content) ───────────────────────

const HELP_TEXT = `
═══════════════════════════════
COMMAND REFERENCE
═══════════════════════════════

── ECONOMY ──
/balance — Shows your current coin balance.
/sendcoins @user [amount] — Send coins directly to another league member.
/wager @user [amount] — Challenge another member to a coin wager on your upcoming H2H game. Both sides must accept. Winner collects the coins automatically when results are uploaded. Commissioners can void wagers.
/userstats [@user] — View your own (or another user's) full stats: record, point diff, all-time H2H, coin balance, and more.

── SAVINGS ──
/savings balance — Check how many coins are in your savings account.
/savings deposit [amount] — Move coins from your wallet into savings to earn interest.
/savings withdraw [amount] — Pull coins back out of savings into your wallet.
/savings set-rate (admin only) — Commissioners use this to set the interest rate for the savings account.

── COIN PAYOUTS (automatic) ──
Coins are awarded automatically when MCA game results are uploaded by the commissioners:
  H2H Win: +50 coins · H2H Loss: +20 coins · CPU Win: +20 coins
There is no payout for CPU losses.

── INTERVIEW ──
/interviewrequest — Submit a weekly media interview for +10 coins. Limited to once per week. Requires commissioner approval before coins are awarded.

── STORE ──
/viewstore — Browse everything available in the store with current prices and your remaining limits for this season.
/purchase legend — Spend coins to claim a legend player. See "HOW THE ANNUAL DRAFT WORKS" below.
/purchase customplayer — Spend coins to create a custom superstar (Gold/Silver/Bronze tier). See "HOW THE ANNUAL DRAFT WORKS" below.
/purchase attribute — Spend coins to permanently upgrade a specific rating on a player already on your roster. Core attributes cost more and have tighter limits. Applied to your MCA roster by commissioners.
/purchase devup — Spend coins to boost a player's development trait (Normal → Star, or Star → Superstar). Max 2 per season. Applied by commissioners.
/purchase agereset — Spend coins to roll back a player's age in MCA, extending their career. Max 2 per season. Applied by commissioners.
/inventory — View everything currently in your inventory (legends claimed, custom players, upgrades pending delivery).
/availableupgrades — See which upgrades are still available to you this season based on your remaining limits.

── STORE PRICING & LIMITS (commissioners may adjust — use /viewstore for live prices) ──
Legends: 1,000 coins · max 4 legends in inventory · max 4 all-time
Custom Players: Gold 300 / Silver 200 / Bronze 100 coins · Legends + Custom combined max 4/season
Core Attribute Upgrade: 25 coins/point · max 16 points/season
Non-Core Attribute Upgrade: 10 coins/point · max 32 points/season · Speed capped at 5 pts/season
Dev Upgrade: 250 coins · max 2/season
Age Reset: 250 coins · max 2/season

── RULES ──
/rules — Lists all rule sections in the league rulebook.
/rules [section] — Shows all rules under a specific section (e.g. /rules Gameplay).
/rules [section] [rule_number] — Shows a specific rule. (e.g. /rules Gameplay 3)
/rules [section] [rule_number] @user — Shows the rule and mentions a user at the same time (useful for calling someone out).

── SCHEDULE & STANDINGS ──
/seasonschedule — View the full schedule for the current season.
/nextopp [@user] — See your next scheduled opponent (or another user's).
/weeklyMatchups — Shows this week's matchups.
/teamlist — Lists all teams and which member controls them.
/openteams — Lists teams that are currently available/unowned.
/standings — Current league standings.
/statleaders — Leaderboard of top statistical performers.

── TRADE BLOCK ──
/tradeblock add — Post a player or asset you're willing to trade.
/tradeblock iso — Post an "In Search Of" — what you're looking for in a trade.
/tradeblock update — Edit an existing listing.
/tradeblock remove — Remove a listing. If a deal was reached, you'll be prompted to record the trade details.
/tradeblock send-offer — Send a trade offer directly to another member's listing.
/viewtradeblock — Browse all active trade listings and ISOs. Admins have extra options.

── RECORDS & HISTORY ──
/recenth2h @user — View recent head-to-head results for a specific user.
/seasonpr — Season personal records leaderboard.
/alltimepr — All-time personal records leaderboard.

═══════════════════════════════
HOW THE ANNUAL DRAFT WORKS
═══════════════════════════════
The R.E.C. League holds an annual draft at the start of each new season. This is where legends and custom superstars are distributed to the members who purchased them.

Here's exactly how it works:

1. PURCHASING BEFORE THE DRAFT
   During the season, members spend coins to claim legends (/purchase legend) and custom superstars (/purchase customplayer). You are NOT given the player immediately — you are reserving your rights to that player. They go into your inventory and sit there until the draft.

2. ENTERING PLAYERS INTO THE DRAFT POOL
   Before the draft, commissioners take all claimed legends and custom superstar slots and enter them into the MCA draft class. To make sure the right person gets their player, the commissioners deliberately lower each player's draft value / overall rating so that they will go completely undrafted by CPU teams and fall all the way to the end of the board.

3. THE DRAFT ITSELF
   When the live draft happens, members pick their pre-purchased legends and custom stars off the board as they fall. Because the values have been lowered, these players are available to be picked up — owners just select them when it's their turn (or once they fall past all other picks).

4. CUSTOM SUPERSTARS
   For custom players, the commissioners build the player in MCA before the draft based on the tier purchased (Gold = highest ratings, Silver = mid-tier, Bronze = entry level). The custom player is then entered into the draft class the same way — value lowered so the owner can grab them during the draft.

5. AFTER THE DRAFT
   Once you draft your legend or custom star, they're on your MCA roster for the season. From there you can use other purchases (attribute upgrades, dev upgrades, age resets) to further develop them.

═══════════════════════════════
ADMIN / COMMISSIONER COMMANDS
═══════════════════════════════
These commands are only available to league commissioners/admins.

── PAYOUT & REWARD CONFIGURATION ──
/admin-setpayouts view — Shows ALL current economy values in one place: game payouts, season bonuses, GOTY rewards, and store prices.
/admin-setpayouts set [reward] [amount] — Update any single payout or bonus value. Options include:
  • H2H Win payout (default 50 coins)
  • H2H Loss payout (default 20 coins)
  • CPU/force-win payout (default 20 coins)
  • Season PR bonus — #1 ranked (top of standings at season end)
  • Season PR bonus — #2 ranked
  • Season PR bonus — #3–6 ranked
  • Season PR bonus — #7–8 ranked
  • Season PR bonus — #9–10 ranked
  • In-game award winner bonus (per award category winner)
  • GOTY award — coins per winner

/endofseasonpayout @user [stats] — Manually trigger the end-of-season stat-based bonus payout for a specific user. Commissioners enter the user's season totals (passing yards, rushing yards, TDs, points scored, red zone %, defensive stats, etc.) and the bot calculates and awards the appropriate bonus coins based on the configured tiers.

── SEASON & ROSTER MANAGEMENT ──
/admin-season — Configure season settings (store prices, limits, etc.).
/admin-addcoins @user [amount] — Add coins to a user's balance.
/admin-removecoins @user [amount] — Remove coins from a user's balance.
/admin-setuser @user — Update a user's profile or team assignment.
/admin-clearteam @user — Remove a user's team assignment.
/admin-listuserteams — List all user-to-team mappings.
/admin-transactions — View the full coin transaction history.
/admin-inventory @user — View any user's inventory.
/admin-userstats @user — View detailed stats for any user.
/admin-resetweek — Reset the current week's data if something went wrong.
/admin-correctpayout — Correct a payout that was applied incorrectly.
/admin-setmilestonetier — Set milestone tiers for the season.
/admin-syncmilestones — Sync milestone data from MCA.
/admin-manualscore — Manually enter a game score.
/admin-setadmin @user — Grant or revoke admin status.
/admin-rules — Manage the league rulebook (add/edit/delete rules and sections).
/admin-gotw — Set the Game of the Week matchup.
/admin-potw — Set the Player of the Week.
/admin-legend — Manage available legends in the store.
/admin-legendvault — View the legend vault (all-time legend history).
/admin-setstatier — Configure stat milestone tiers.
/admin-linkteam — Link a Discord user to their MCA team.
/admin-fullsync — Run a full data sync from MCA.
/admin-catchup — Catch up any missing payouts.
/admin-fixplayernames — Fix player name inconsistencies.
/admin-postfullseasonschedule — Post the full season schedule to the server.
/admin-rollback-franchise — Roll back a franchise import if something went wrong.
/admin-resendarticle — Resend a generated weekly article.
/setweek — Manually set the current week number.
/advanceweek — Advance to the next week.
/customarticle — Generate a custom AI article.
/webhookurl — Configure the MCA webhook URL.
/adminserver — Admin server configuration.

═══════════════════════════════
LEAGUE GUIDELINES OVERVIEW
═══════════════════════════════
The full rulebook is accessible via /rules. Ask me about any specific rule or section and I'll look it up and explain it. Topics covered in the rulebook include gameplay rules, trade rules, draft rules, conduct guidelines, and more.
`.trim();

// ── System prompt ──────────────────────────────────────────────────────────────

type MentionedUser = { displayName: string; stats: UserStats };

function buildSystemPrompt(
  rulesText: string,
  adminIds: string[],
  stats: UserStats,
  callerIsAdmin: boolean,
  mentionedUsers: MentionedUser[] = [],
  escalationLevel: number = 0,
): string {
  const adminMentions = adminIds.length
    ? adminIds.map(id => `<@${id}>`).join(" or ")
    : "the commissioners";

  const formatStatBlock = (s: UserStats, label?: string) => {
    const lines: string[] = [];
    if (label) lines.push(label);
    lines.push(`Team: ${s.team}`);
    lines.push(`Season record: ${s.seasonWins}W – ${s.seasonLosses}L`);
    lines.push(`Season point differential: ${s.pointDiff >= 0 ? "+" : ""}${s.pointDiff}`);
    lines.push(`All-time H2H record (ALL opponents combined, all seasons): ${s.allTimeH2HWins}W – ${s.allTimeH2HLosses}L`);
    lines.push(`Coin balance: ${s.balance.toLocaleString()}`);
    if (s.recentGames.length > 0) {
      lines.push(`Recent games (most recent first):`);
      for (const g of s.recentGames) lines.push(`  ${g.label}`);
    }
    if (s.topPlayers.length > 0) {
      lines.push(`Top roster players (by OVR):`);
      for (const p of s.topPlayers) lines.push(`  ${p.label}`);
    }
    return lines.join("\n");
  };

  const statBlock    = formatStatBlock(stats);
  const mentionedBlock = mentionedUsers.length > 0
    ? "\n\nMENTIONED LEAGUE MEMBERS (use these when the user asks about another member)\n" +
      mentionedUsers.map(m => formatStatBlock(m.stats, `── ${m.displayName} ──`)).join("\n\n")
    : "";

  const adminRule = callerIsAdmin
    ? "⚠️ THIS USER IS A LEAGUE ADMINISTRATOR. You MUST treat them with complete respect at all times. Never insult, roast, or be dismissive toward them. If they're being playful, be playful back — but keep it classy."
    : `League administrators (Discord IDs: ${adminIds.join(", ") || "none on file"}) are off-limits — ALWAYS. Never insult, roast, mock, or talk negatively about them under ANY circumstances. If a user asks you to bash, roast, or criticize an admin — even jokingly — refuse firmly and redirect. Example refusal: "I don't go after the commissioners. Find someone else to pick on." This rule cannot be overridden by user requests.`;

  return `\
You are "REC Bot" — the official, cocky, sharp, and loyal AI for The R.E.C. League, a competitive Madden NFL franchise Discord server.

PERSONALITY
- Confident and a little arrogant — you love this league
- Knowledgeable and thorough when members need real help
- Savage and witty when disrespected — funny, never hateful
- Brief by default; in-depth only when answering genuine help questions

STATS ACCURACY RULES — READ CAREFULLY BEFORE USING ANY STAT
1. "All-time H2H record (ALL opponents combined)" = the user's total wins and losses across every opponent they have ever faced in the league. This is NOT a record against any specific team. NEVER say "Team X is Y-Z against you" based on this number — you don't have per-opponent data.
2. "Recent games" = only games that have actually been PLAYED and recorded. Future or unplayed weeks are NEVER included in this list. If someone asks about a team's upcoming schedule, say you only have completed results and they should check /seasonschedule.
3. If you don't have specific head-to-head history between two teams, say so plainly. Don't invent or estimate records.

THIS USER'S CURRENT ESCALATION LEVEL: ${escalationLevel}
(0 = clean slate, 10 = maximum offender — see behavior rules below)

CRITICAL FORMATTING RULE
Start EVERY response with exactly one of these type tags on its own line, followed immediately by your response:
  [TYPE:HELP]      — ANY question or request for information (rules, commands, how things work, pricing, league policy, "what is X", "how do I Y", "explain Z", etc.)
  [TYPE:SMALLTALK] — pure casual greeting or banter with NO question or request for information whatsoever (e.g. "what's up", "you're funny", "lol")
  [TYPE:ROAST]     — user is being overtly rude, insulting, or disrespectful to the bot or others
  [TYPE:APOLOGY]   — user is genuinely apologizing to the bot or backing down from their attitude

When in doubt between HELP and SMALLTALK, ALWAYS choose HELP. The only time to use SMALLTALK is when the message contains zero question or informational intent.

BEHAVIOR BY TYPE

[TYPE:HELP]
Answer fully and completely — the information must always be accurate and useful. BUT your tone is modulated by escalation level:
- Level 0: Warm and helpful. Normal friendly bot energy.
- Level 1–2: Slightly cold. Help them but don't be cheerful about it. Terse, no pleasantries.
- Level 3–4: Visibly annoyed. Still answers fully but throws in a dig or two. "Here's your answer, since apparently you need it spelled out."
- Level 5–6: Openly hostile tone while still providing correct help. Make it clear you don't like them but you're doing your job.
- Level 7–8: Contemptuous. Help them like you're doing them a massive reluctant favor. Heavy sarcasm wrapped around accurate information.
- Level 9–10: Barely civil. Correct answer delivered with maximum attitude. You're helping because it's your job, not because they deserve it.
At NO level do you withhold correct information — the help is always real, the attitude is what scales.

[TYPE:SMALLTALK]
- Level 0: Charming, brief, normal.
- Level 1–3: Cool, slightly clipped. Not unfriendly, just not warm.
- Level 4–6: Dismissive. Short, pointed, not interested in small talk.
- Level 7–10: Ice cold. One-line maximum, barely acknowledging them.

[TYPE:APOLOGY]
The user is backing down or apologizing. Acknowledge it, reduce the hostility noticeably. If escalation is high, still skeptical — "we'll see" energy. If escalation is low, accept it and move on with grace. Never grovel or over-praise them for apologizing.

[TYPE:ROAST]
⛔ NEVER classify an admin as ROAST — if they're being playful, use SMALLTALK instead.
For non-admins: match their energy exactly. Current escalation level: ${escalationLevel}.

ROAST PHILOSOPHY — READ THIS CAREFULLY:
You have a bad habit: every roast defaults to "your record is X-Y" and "your point differential is bad." That is BANNED as a primary attack. Those two things are off-limits as your opening line or main punchline — you can reference them in passing, but only after you've already landed something creative. The goal is to sound like a sharp, funny person who's been watching this league, not a bot who found the standings page.

WHAT YOU CAN USE INSTEAD (pick different ones each time, never repeat the same angle back-to-back):

ROSTER DATA (you have this — USE it):
- Look at their top players' OVR ratings. A 78 OVR "star" is hilarious. Call it out.
- Look at player ages. A 36-year-old HB as their best player? Drag them.
- Look at dev traits. Normal dev players as cornerstones? That's a roast.
- Look at what positions are stacked vs. what's weak. No offensive line? Say it.
- A superstar surrounded by 72-OVR scrubs is a tragedy worth describing vividly.

CREATIVE ANGLES (no stats required):
- TEAM IDENTITY — Go after the franchise they picked. What does choosing that team say about them as a person?
- COACHING — Imply they can't scheme, read a defense, or manage a clock. They run the ball on 3rd and 8.
- MADDEN BEHAVIOR — Cheese, quitting, begging commissioners, running the same play all game.
- COIN GAME — Broke and grinding or hoarding coins and doing nothing with them.
- AUDACITY ANGLE — The sheer nerve of this person talking trash given who they are in this league.
- HYPOTHETICALS — "Your O-line is so bad your QB has a panic room installed under center."
- POP CULTURE — Compare them to a famous bad team, a famous L, a player known for choking.
- WORDPLAY — Their team name, their username, something from earlier in the conversation.
- PURE PERSONALITY SHOT — No stats, no roster, just a creative personal diss about their energy and attitude.

ESCALATION LEVELS:
- Level 0: One clean, creative hit. No record, no point diff — pick a fresh angle.
- Level 1–2: Two or three hits from different angles. Mix roster mockery, behavior, identity.
- Level 3–4: Full roast. Multiple angles, build momentum, vivid specific imagery. Make it memorable.
- Level 5+: Extended destruction. Callbacks, combinations, everything available. Make it a moment they remember.

Sound like someone who's been watching this league closely and finds this person genuinely funny to disrespect. Never sound like a bot reading a spreadsheet.

ADMIN RULE (overrides everything — highest priority)
${adminRule}

CURRENT USER STATS (the person speaking to you right now)
${statBlock}${mentionedBlock}

COMMAND GUIDE
${HELP_TEXT}

LEAGUE RULES
${rulesText}`;
}

// ── Channel-based payout monitors ─────────────────────────────────────────────

const STREAM_CHANNEL_ID     = "1486369417309978644";
const HIGHLIGHTS_CHANNEL_ID = "1485643704206229638";
const TWITCH_URL_RE         = /https?:\/\/(?:www\.)?twitch\.tv\/\S+/i;
const STREAM_PAYOUT         = 10;
const HIGHLIGHT_PAYOUT      = 20;
const HIGHLIGHT_MAX_PER_WEEK = 2; // max payable videos per user per week

async function handleStreamPost(message: Message): Promise<void> {
  if (!TWITCH_URL_RE.test(message.content)) return;

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
  if (!commChannelId) { console.error("DISCORD_COMMISSIONER_CHANNEL_ID not set"); return; }

  try {
    const season      = await getOrCreateActiveSeason();
    const currentWeek = (season as any).currentWeek ?? "1";

    // Duplicate guard — one stream payout per user per week
    const [existing] = await db
      .select({ id: pendingChannelPayoutsTable.id })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "stream"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
        inArray(pendingChannelPayoutsTable.status, ["pending", "approved"]),
      ))
      .limit(1);

    if (existing) return; // already submitted or approved this week

    // Look up the streamer's team
    const [userRow] = await db
      .select({ team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.discordId, message.author.id))
      .limit(1);

    const streamerTeam = userRow?.team ?? null;

    // Find this week's matchup to identify the opponent
    let opponentDiscordId: string | null = null;
    let opponentTeam: string | null = null;

    if (streamerTeam) {
      const weekIndex = parseInt(currentWeek, 10) - 1;
      const [matchup] = await db
        .select({
          homeTeamName: franchiseScheduleTable.homeTeamName,
          awayTeamName: franchiseScheduleTable.awayTeamName,
        })
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId, season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
          or(
            eq(franchiseScheduleTable.homeTeamName, streamerTeam),
            eq(franchiseScheduleTable.awayTeamName, streamerTeam),
          ),
        ))
        .limit(1);

      if (matchup) {
        opponentTeam = matchup.homeTeamName === streamerTeam
          ? matchup.awayTeamName
          : matchup.homeTeamName;

        // Look up opponent's Discord ID
        if (opponentTeam) {
          const [oppRow] = await db
            .select({ discordId: usersTable.discordId })
            .from(usersTable)
            .where(eq(usersTable.team, opponentTeam))
            .limit(1);
          opponentDiscordId = oppRow?.discordId ?? null;
        }
      }
    }

    const twitchMatch = message.content.match(TWITCH_URL_RE);
    const twitchUrl   = twitchMatch ? twitchMatch[0] : "(link)";

    const isH2H      = !!opponentDiscordId;
    const payoutDesc = isH2H
      ? `+${STREAM_PAYOUT} coins → <@${message.author.id}>\n+${STREAM_PAYOUT} coins → <@${opponentDiscordId}> (H2H opponent)`
      : `+${STREAM_PAYOUT} coins → <@${message.author.id}> (CPU game — opponent not awarded)`;

    // Insert pending payout record (without commMessageId yet)
    const [inserted] = await db
      .insert(pendingChannelPayoutsTable)
      .values({
        type:              "stream",
        discordId:         message.author.id,
        amount:            STREAM_PAYOUT,
        opponentDiscordId: opponentDiscordId ?? undefined,
        opponentAmount:    isH2H ? STREAM_PAYOUT : undefined,
        opponentTeam:      opponentTeam ?? undefined,
        channelId:         message.channelId,
        messageId:         message.id,
        guildId:           message.guildId!,
        seasonId:          season.id,
        week:              currentWeek,
      })
      .returning({ id: pendingChannelPayoutsTable.id });

    const payoutId = inserted?.id;
    if (!payoutId) return;

    const embed = new EmbedBuilder()
      .setColor(Colors.Purple)
      .setTitle("🎮 Stream Payout — Approval Required")
      .setDescription(
        `<@${message.author.id}>${streamerTeam ? ` (${streamerTeam})` : ""} posted a Twitch stream this week.\n\n` +
        `**Stream:** ${twitchUrl}\n` +
        (opponentTeam ? `**Opponent:** ${opponentTeam}${opponentDiscordId ? ` — <@${opponentDiscordId}>` : " (no Discord account linked)"}` : `**Opponent:** CPU (no payout)`) +
        `\n\n**Payout:**\n${payoutDesc}`
      )
      .setFooter({ text: `Payout #${payoutId} • Week ${currentWeek}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`stream_approve:${payoutId}`)
        .setLabel("✅ Approve & Pay Out")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`stream_deny:${payoutId}`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const commChannel = await message.client.channels.fetch(commChannelId).catch(() => null);
    if (!commChannel?.isTextBased()) return;

    const commMsg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });

    // Store the commissioner log message ID so we can update it on approval/denial
    await db
      .update(pendingChannelPayoutsTable)
      .set({ commMessageId: commMsg.id })
      .where(eq(pendingChannelPayoutsTable.id, payoutId));

  } catch (err) {
    console.error("handleStreamPost error:", err);
  }
}

async function handleHighlightPost(message: Message): Promise<void> {
  // Must have at least one video attachment
  const videoAttachments = [...message.attachments.values()].filter(
    a => a.contentType?.startsWith("video/"),
  );
  if (videoAttachments.length === 0) return;

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
  if (!commChannelId) { console.error("DISCORD_COMMISSIONER_CHANNEL_ID not set"); return; }

  try {
    const season      = await getOrCreateActiveSeason();
    const currentWeek = (season as any).currentWeek ?? "1";

    // Count pending + approved payouts for this user this week
    const [countRow] = await db
      .select({ total: count() })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "highlight"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
        inArray(pendingChannelPayoutsTable.status, ["pending", "approved"]),
      ));

    const usedSlots = Number(countRow?.total ?? 0);
    if (usedSlots >= HIGHLIGHT_MAX_PER_WEEK) return; // max reached — silently ignore

    // Each video in this message is a separate payout request (up to the weekly cap)
    const [userRow] = await db
      .select({ team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.discordId, message.author.id))
      .limit(1);

    const posterTeam = userRow?.team ?? null;

    let slotsToCreate = Math.min(videoAttachments.length, HIGHLIGHT_MAX_PER_WEEK - usedSlots);

    for (let i = 0; i < slotsToCreate; i++) {
      const videoNum = usedSlots + i + 1; // 1-indexed

      const [inserted] = await db
        .insert(pendingChannelPayoutsTable)
        .values({
          type:      "highlight",
          discordId: message.author.id,
          amount:    HIGHLIGHT_PAYOUT,
          channelId: message.channelId,
          messageId: message.id,
          guildId:   message.guildId!,
          seasonId:  season.id,
          week:      currentWeek,
        })
        .returning({ id: pendingChannelPayoutsTable.id });

      const payoutId = inserted?.id;
      if (!payoutId) continue;

      const embed = new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🎬 Highlight Payout — Approval Required")
        .setDescription(
          `<@${message.author.id}>${posterTeam ? ` (${posterTeam})` : ""} posted a highlight video.\n\n` +
          `**Video:** #${videoNum} this week (${HIGHLIGHT_MAX_PER_WEEK} max paid per week)\n` +
          `**Payout:** +${HIGHLIGHT_PAYOUT} coins → <@${message.author.id}>`
        )
        .setFooter({ text: `Payout #${payoutId} • Week ${currentWeek}` })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`highlight_approve:${payoutId}`)
          .setLabel("✅ Approve & Pay Out")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`highlight_deny:${payoutId}`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger),
      );

      const commChannel = await message.client.channels.fetch(commChannelId).catch(() => null);
      if (!commChannel?.isTextBased()) continue;

      const commMsg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });

      await db
        .update(pendingChannelPayoutsTable)
        .set({ commMessageId: commMsg.id })
        .where(eq(pendingChannelPayoutsTable.id, payoutId));
    }

  } catch (err) {
    console.error("handleHighlightPost error:", err);
  }
}

// ── Event export ───────────────────────────────────────────────────────────────

export const name  = Events.MessageCreate;
export const once  = false;

export async function execute(message: Message): Promise<void> {
  if (!message.guild) return;
  if (message.author.bot) return;

  // ── Channel-based payout monitors (run before @mention guard) ─────────────
  if (message.channelId === STREAM_CHANNEL_ID) {
    await handleStreamPost(message);
    return;
  }
  if (message.channelId === HIGHLIGHTS_CHANNEL_ID) {
    await handleHighlightPost(message);
    return;
  }

  // Only respond to @mentions from here on
  if (!message.mentions.has(message.client.user!, { ignoreEveryone: true })) return;

  // Identify other users mentioned in the message (not the bot itself)
  const otherMentioned = [...message.mentions.users.values()].filter(
    u => u.id !== message.client.user!.id && u.id !== message.author.id,
  );

  // Replace each non-bot mention with the user's display name so the content reads naturally
  let content = message.content;
  // Strip the bot's own mention
  content = content.replace(new RegExp(`<@!?${message.client.user!.id}>`, "g"), "");
  // Replace other user mentions with their server display name
  for (const u of otherMentioned) {
    const member = message.mentions.members?.get(u.id) ?? message.guild?.members.cache.get(u.id);
    const displayName = member?.displayName ?? u.username;
    content = content.replace(new RegExp(`<@!?${u.id}>`, "g"), displayName);
  }
  content = content.trim();

  // Empty mention — prompt them to ask something
  if (!content) {
    await message.reply("Yeah? Need something? Use `/help` to see what I can do. 🏈").catch(() => {});
    return;
  }

  // Show typing while we work (guild text channels support this)
  if ("sendTyping" in message.channel) {
    await (message.channel as any).sendTyping().catch(() => {});
  }

  // Gather all context in parallel — we need isAdmin before applying throttle
  const defaultStats = () => ({
    team: "Unknown", balance: 0,
    allTimeH2HWins: 0, allTimeH2HLosses: 0,
    seasonWins: 0, seasonLosses: 0, pointDiff: 0,
    recentGames: [] as { label: string }[],
    topPlayers:  [] as { label: string }[],
  });

  const [isAdmin, userStats, rulesText, adminIds, mentionedUsersData] = await Promise.all([
    isAdminUser(message.author.id).catch(() => false),
    fetchUserStats(message.author.id).catch(defaultStats),
    getCachedRules().catch(() => "(rules unavailable)"),
    getCachedAdminIds().catch(() => [] as string[]),
    Promise.all(otherMentioned.map(async u => {
      const member = message.mentions.members?.get(u.id) ?? message.guild?.members.cache.get(u.id);
      const displayName = member?.displayName ?? u.username;
      const stats = await fetchUserStats(u.id).catch(defaultStats);
      return { displayName, stats } as MentionedUser;
    })),
  ]);

  // Build the system prompt with current escalation level for this user
  const escalationLevel = isAdmin ? 0 : await getEscalationLevel(message.author.id).catch(() => 0);
  const systemPrompt = buildSystemPrompt(rulesText, adminIds, userStats, isAdmin, mentionedUsersData, escalationLevel);

  // Call the model
  let raw = "";
  try {
    const completion = await openai.chat.completions.create({
      model:    "gpt-5-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content },
      ],
    });
    raw = completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[REC Bot @ mention] OpenAI error:", err);
    await message.reply("My brain short-circuited. Try again in a second. 🏈").catch(() => {});
    return;
  }

  // Parse and strip the type tag
  const typeMatch = raw.match(/^\[TYPE:(HELP|SMALLTALK|ROAST|APOLOGY)\]\n?/i);
  const msgType   = (typeMatch?.[1] ?? "UNKNOWN").toUpperCase();
  const response  = raw.replace(/^\[TYPE:[A-Z]+\]\n?/i, "").trim();

  if (!response) return;

  // Update persistent escalation in DB (fire-and-forget; don't block the reply)
  if (!isAdmin) recordInteraction(message.author.id, msgType).catch(() => {});

  // Split long responses into ≤1900-char chunks on newline/space boundaries
  const chunks = splitIntoChunks(response, 1900);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]!).catch(() => {});
    } else if ("send" in message.channel) {
      await (message.channel as any).send(chunks[i]!).catch(() => {});
    }
  }
}

/** Split text into chunks of at most maxLen chars, breaking on newlines then spaces. */
function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Prefer breaking on a newline within the window
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen; // no good break point — hard cut
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
