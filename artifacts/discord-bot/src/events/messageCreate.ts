import { Events, Message } from "discord.js";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  isAdminUser, getOrCreateActiveSeason, getAllSections, getOrSeedRules,
} from "../lib/db-helpers.js";

// ── OpenAI client ──────────────────────────────────────────────────────────────

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

// ── Small-talk throttle ────────────────────────────────────────────────────────

const SMALL_TALK_LIMIT   = 2;          // max idle exchanges per reset window
const SMALL_TALK_RESET_H = 6;          // hours before counter resets
const smallTalkMap = new Map<string, { count: number; resetAt: number }>();

function getSmallTalkCount(userId: string): number {
  const e = smallTalkMap.get(userId);
  if (!e) return 0;
  if (Date.now() > e.resetAt) { smallTalkMap.delete(userId); return 0; }
  return e.count;
}

function bumpSmallTalk(userId: string) {
  const count = getSmallTalkCount(userId);
  smallTalkMap.set(userId, {
    count:   count + 1,
    resetAt: Date.now() + SMALL_TALK_RESET_H * 3_600_000,
  });
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

  let seasonWins = 0, seasonLosses = 0, pointDiff = 0;
  try {
    const season = await getOrCreateActiveSeason();
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
      seasonWins  = rec.wins;
      seasonLosses = rec.losses;
      pointDiff   = rec.pointDifferential;
    }
  } catch (_) {}

  return {
    team:             user?.team ?? "Unknown Team",
    balance:          user?.balance ?? 0,
    allTimeH2HWins:   user?.allTimeH2HWins ?? 0,
    allTimeH2HLosses: user?.allTimeH2HLosses ?? 0,
    seasonWins,
    seasonLosses,
    pointDiff,
  };
}

type UserStats = Awaited<ReturnType<typeof fetchUserStats>>;

// ── Static help summary (mirrors /help command content) ───────────────────────

const HELP_TEXT = `
AVAILABLE COMMANDS
Economy: /balance · /sendcoins @user [amount] · /wager @user [amount]
Savings: /savings balance/deposit/withdraw · /savings set-rate (admin only)
Store: /viewstore · /purchase legend|attribute|devup|agereset|customplayer · /inventory · /availableupgrades
Payouts (automatic via MCA upload): H2H Win +50 · H2H Loss +20 · CPU Win +20
Interview: /interviewrequest — +10 coins (1/week, commissioner approval required)
Rankings: /userstats [@user] · /recenth2h @user · /seasonpr · /alltimepr
Schedule: /seasonschedule · /nextopp [@user] · /teamlist · /openteams
Rules: /rules [section] · /rules [section] [rule_number] · /rules [section] [rule_number] @user
Trade Block: /tradeblock add|remove|update|iso|send-offer · /viewtradeblock [public] [admin]

STORE PRICING & LIMITS (commissioners may adjust per season — use /viewstore for live prices)
Legends: 1,000 coins · max 4 all-time · max 4 in inventory
Core Attribute: 25 coins/pt · max 16 pts/season
Non-Core Attribute: 10 coins/pt · max 32 pts/season · Speed ≤5 pts/season
Dev Upgrade (Star/Superstar): 250 coins · max 2/season
Age Reset: 250 coins · max 2/season
Custom Players: Gold 300 / Silver 200 / Bronze 100 coins · Legends + Custom combined max 4/season
`.trim();

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(
  rulesText: string,
  adminIds: string[],
  stats: UserStats,
  callerIsAdmin: boolean,
): string {
  const adminMentions = adminIds.length
    ? adminIds.map(id => `<@${id}>`).join(" or ")
    : "the commissioners";

  const statBlock = [
    `Team: ${stats.team}`,
    `Season record: ${stats.seasonWins}W – ${stats.seasonLosses}L`,
    `Season point differential: ${stats.pointDiff >= 0 ? "+" : ""}${stats.pointDiff}`,
    `All-time H2H: ${stats.allTimeH2HWins}W – ${stats.allTimeH2HLosses}L`,
    `Coin balance: ${stats.balance.toLocaleString()}`,
  ].join("\n");

  const adminRule = callerIsAdmin
    ? "⚠️ THIS USER IS A LEAGUE ADMINISTRATOR. You MUST treat them with complete respect at all times. Never insult, roast, or be dismissive toward them. If they're being playful, be playful back — but keep it classy."
    : `Never insult, roast, or be rude to league administrators (Discord IDs: ${adminIds.join(", ") || "none on file"}).`;

  return `\
You are "REC Bot" — the official, cocky, sharp, and loyal AI for The R.E.C. League, a competitive Madden NFL franchise Discord server.

PERSONALITY
- Confident and a little arrogant — you love this league
- Knowledgeable and thorough when members need real help
- Savage and witty when disrespected — funny, never hateful
- Brief by default; in-depth only when answering genuine help questions
- All responses stay under 1900 characters

CRITICAL FORMATTING RULE
Start EVERY response with exactly one of these type tags on its own line, followed immediately by your response:
  [TYPE:HELP]      — genuine question about commands, rules, or how to do something in the league
  [TYPE:SMALLTALK] — casual chat with no specific question or ask
  [TYPE:ROAST]     — user is being rude, insulting, or disrespectful to the bot or others

BEHAVIOR BY TYPE

[TYPE:HELP]
Answer fully, clearly, and step-by-step when needed. Reference the command guide and rules below. If you're not 100% certain about something, say so and suggest the user reach out to ${adminMentions} for clarification (you may @-mention them). No response length limit for genuine help.

[TYPE:SMALLTALK]
Keep it brief and light — one or two sentences. Be charming but not too chatty.

[TYPE:ROAST]
Go in. Use their stats below to make it personal and league-relevant. Point out their record, point differential, or coin situation. Be creative and funny. Don't hold back.

ADMIN RULE
${adminRule}

CURRENT USER STATS (use these for context — especially for roasts)
${statBlock}

COMMAND GUIDE
${HELP_TEXT}

LEAGUE RULES
${rulesText}`;
}

// ── Event export ───────────────────────────────────────────────────────────────

export const name  = Events.MessageCreate;
export const once  = false;

export async function execute(message: Message): Promise<void> {
  // Only respond in guilds when the bot is explicitly @mentioned
  if (!message.guild) return;
  if (message.author.bot) return;
  if (!message.mentions.has(message.client.user!)) return;

  // Strip all @mentions from the content and trim
  const content = message.content.replace(/<@!?\d+>/g, "").trim();

  // Empty mention — prompt them to ask something
  if (!content) {
    await message.reply("Yeah? Need something? Use `/help` to see what I can do. 🏈").catch(() => {});
    return;
  }

  // Small-talk limit check — no API call needed
  const stCount = getSmallTalkCount(message.author.id);
  if (stCount >= SMALL_TALK_LIMIT) {
    await message.reply(
      "I'm not here for small talk. Ask me something about the league or leave me alone. 🏈"
    ).catch(() => {});
    return;
  }

  // Show typing while we work (guild text channels support this)
  if ("sendTyping" in message.channel) {
    await (message.channel as any).sendTyping().catch(() => {});
  }

  // Gather all context in parallel
  const [isAdmin, userStats, rulesText, adminIds] = await Promise.all([
    isAdminUser(message.author.id).catch(() => false),
    fetchUserStats(message.author.id).catch(() => ({
      team: "Unknown", balance: 0,
      allTimeH2HWins: 0, allTimeH2HLosses: 0,
      seasonWins: 0, seasonLosses: 0, pointDiff: 0,
    })),
    getCachedRules().catch(() => "(rules unavailable)"),
    getCachedAdminIds().catch(() => [] as string[]),
  ]);

  const systemPrompt = buildSystemPrompt(rulesText, adminIds, userStats, isAdmin);

  // Call the model
  let raw = "";
  try {
    const completion = await openai.chat.completions.create({
      model:                "gpt-5-mini",
      max_completion_tokens: 700,
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
  const typeMatch = raw.match(/^\[TYPE:(HELP|SMALLTALK|ROAST)\]\n?/i);
  const msgType   = (typeMatch?.[1] ?? "UNKNOWN").toUpperCase();
  const response  = raw.replace(/^\[TYPE:[A-Z]+\]\n?/i, "").trim();

  // Update small-talk counter
  if (msgType === "SMALLTALK") {
    bumpSmallTalk(message.author.id);
    // Warn on the 2nd small-talk so they know the next one will be cut off
    const newCount = getSmallTalkCount(message.author.id);
    if (newCount >= SMALL_TALK_LIMIT) {
      const suffix = "\n\n*(Last off-topic reply — come back when you've got a real question.)*";
      const trimmed = response.slice(0, 1900 - suffix.length);
      await message.reply(trimmed + suffix).catch(() => {});
      return;
    }
  }

  const toSend = response.slice(0, 1900);
  if (!toSend) return;
  await message.reply(toSend).catch(() => {});
}
