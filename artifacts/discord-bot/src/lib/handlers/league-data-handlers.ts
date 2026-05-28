/**
 * league-data-handlers.ts
 *
 * All logic for /admin-league-data — the unified EA connection + import wizard.
 *
 * Flow overview:
 *   Main Menu (3 buttons)
 *     ├─ "Start EA Connection" → Step 1 (login link) → URL modal → code exchange
 *     │    → single-league auto-connect OR league select menu
 *     │    → Week select → Proceed with Import
 *     ├─ "Import Data Only" → Week select → Proceed with Import
 *     └─ "Clear Season Data" → Warning → Confirm → Wipe
 *
 * Every step updates the SAME ephemeral message via interaction.update()
 * or interaction.deferUpdate() + editReply() so the wizard stays in-place.
 */

import {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Guild,
  TextChannel,
  Client,
} from "discord.js";
import axios from "axios";
import { db } from "@workspace/db";
import {
  seasonsTable,
  userRecordsTable,
  gameLogTable,
  playerSeasonStatsTable,
  playerStatWeekProcessedTable,
  statPaddingViolationsTable,
  franchiseScheduleTable,
  gameSchedulesTable,
  gotwHistoryTable,
  globalUserRecordsTable,
  usersTable,
  franchiseRostersTable,
  franchiseMcaTeamsTable,
  teamSeasonStatsTable,
  legendsTable,
  inventoryTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, ne, inArray, or } from "drizzle-orm";

import {
  EA_LOGIN_URL,
  exchangeCodeForToken,
  detectPersonas,
  getPersonaScopedTokens,
  getLeaguesFromToken,
  saveEAConnection,
  loadEAConnection,
  createBlazeSession,
  fetchWeeklyStats,
  fetchNewsData,
  fetchLeagueTeamsAndRosters,
  fetchAllWeekSchedules,
  probeMcaExportEndpoints,
  updateStoredToken,
  refreshTokenIfNeeded,
  type BlazeSession,
  type EALeague,
  type TokenInfo,
} from "../ea/ea-client.js";

import { isAdminUser, getGuildChannel, CHANNEL_KEYS } from "../db/db-helpers.js";

// ── In-memory pending sessions (multi-league selection flow) ──────────────────
type PendingSession = {
  guildId: string;
  leagues: EALeague[];
  token: TokenInfo;
  personas: Awaited<ReturnType<typeof detectPersonas>>;
  expiresAt: number;
};
const pendingSessions = new Map<string, PendingSession>();

// ── Cancel row helper ──────────────────────────────────────────────────────────
function cancelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("✕ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Build the main menu message ───────────────────────────────────────────────
export async function buildLeagueDataMainMenu(guildId: string) {
  const conn = await loadEAConnection(guildId).catch(() => null);

  const statusLine = conn
    ? `✅ **Connected:** ${conn.leagueName} (ID: ${conn.eaLeagueId}) · ${conn.token.platform.toUpperCase()}`
    : "⚠️ **Not connected** — run Step 1 below to link your EA franchise.";

  const embed = new EmbedBuilder()
    .setColor(conn ? Colors.Green : Colors.Orange)
    .setTitle("🏈 League Data Manager")
    .setDescription(
      statusLine +
      "\n\n" +
      "**🔗 Start EA Connection**\n" +
      "Full guided wizard — log in to EA, link your franchise, then import a week.\n\n" +
      "**📥 Import Data Only**\n" +
      "Skip setup and import a specific week (requires active connection).\n\n" +
      "**🗑️ Clear Season Data**\n" +
      "Wipe all W/L records, scores, player stats, and game logs for the current season so you can reimport clean.",
    )
    .setFooter({ text: "All operations are scoped to this server only" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_start_connect")
      .setLabel("🔗 Start EA Connection")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ld_import_only")
      .setLabel("📥 Import Data Only")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ld_clear_data")
      .setLabel("🗑️ Clear Season Data")
      .setStyle(ButtonStyle.Danger),
  );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ao_hub_back")
      .setLabel("← Back to Hub")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row, backRow] };
}

// ── Step 1: Show EA login link ─────────────────────────────────────────────────
function buildStep1Content() {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🔗 EA Connection — Step 1 of 3")
    .setDescription(
      [
        "**Click the link below to log in to EA.** Use the commissioner's EA account that owns the Madden franchise.",
        "",
        `## [→ Log Into EA](${EA_LOGIN_URL})`,
        "",
        "After you log in, EA will redirect your browser to a page that **won't load** (it tries to open `http://127.0.0.1/success?code=...`).",
        "",
        "**Copy the full URL from your browser's address bar** — it looks like:",
        "```\nhttp://127.0.0.1/success?code=QUOhAFs1kcSeHLr18Vv...\n```",
        "",
        "Then click **Next →** to paste it in.",
        "",
        "⚠️ Each login link can only be used **once**. If you need a fresh one, click Cancel and run the command again.",
      ].join("\n"),
    )
    .setFooter({ text: "EA Direct Connect • Step 1 of 3" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_next_to_url")
      .setLabel("Next →")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("✕ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ── URL modal ──────────────────────────────────────────────────────────────────
function buildUrlModal() {
  return new ModalBuilder()
    .setCustomId("ld_modal_url")
    .setTitle("Step 2 — Paste Redirect URL")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("redirect_url")
          .setLabel("Full redirect URL from your browser")
          .setPlaceholder("http://127.0.0.1/success?code=QUOhAFs1kcSeHLr18Vv...")
          .setStyle(TextInputStyle.Short)
          .setMinLength(30)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
}

// ── League select menu (multiple leagues) ─────────────────────────────────────
function buildLeagueSelectContent(leagues: EALeague[]) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("🏈 Multiple Leagues Found — Pick One")
    .setDescription(
      leagues
        .map(l => `• **${l.leagueName}** — ID: \`${l.leagueId}\` (your team: ${l.userTeamName})`)
        .join("\n") +
      "\n\nSelect your league from the dropdown below.",
    )
    .setFooter({ text: "Session expires in 10 minutes" });

  const select = new StringSelectMenuBuilder()
    .setCustomId("ld_select_league")
    .setPlaceholder("Select your league…")
    .addOptions(
      leagues.slice(0, 25).map(l =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${l.leagueName} (ID: ${l.leagueId})`)
          .setValue(String(l.leagueId))
          .setDescription(`Your team: ${l.userTeamName}`),
      ),
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const cancelRow_ = cancelRow();

  return { embeds: [embed], components: [selectRow, cancelRow_] };
}

// ── Playoff round metadata ─────────────────────────────────────────────────────
// Playoffs use stageIndex=1 (same as regular season), weekIndex = weekNum - 1.
// Week 19 = Wild Card (index 18), 20 = Divisional (19), 21 = Conf Champ (20), 23 = Super Bowl (22).
const PLAYOFF_ROUNDS: { weekNum: number; label: string; desc: string }[] = [
  { weekNum: 19, label: "🏆 Wild Card Round",            desc: "Playoff Week 19 — Wild Card (stageIndex 1, weekIndex 18)" },
  { weekNum: 20, label: "🏆 Divisional Round",           desc: "Playoff Week 20 — Divisional (stageIndex 1, weekIndex 19)" },
  { weekNum: 21, label: "🏆 Conference Championship",    desc: "Playoff Week 21 — Conf. Champ (stageIndex 1, weekIndex 20)" },
  { weekNum: 23, label: "🏆 Super Bowl",                 desc: "Playoff Week 23 — Super Bowl (stageIndex 1, weekIndex 22)" },
];

/**
 * Converts a season.currentWeek string (e.g. "18", "wildcard", "divisional")
 * to a numeric week number so it can be compared against PLAYOFF_ROUNDS.
 * Non-numeric playoff strings map to their EA weekNum equivalents.
 */
function weekStringToNum(w: string | null | undefined): number {
  if (!w) return 1;
  const n = parseInt(w, 10);
  if (!isNaN(n)) return n;
  const map: Record<string, number> = {
    wildcard:      19,
    divisional:    20,
    conference:    21,
    superbowl:     23,
    offseason:     24,
    training_camp: 25,
  };
  return map[w] ?? 1;
}

/** Human-readable label for any week/stage combination. */
function getWeekLabel(weekType: "reg" | "pre", weekNum: number): string {
  if (weekType === "pre") return `Preseason Week ${weekNum}`;
  const round = PLAYOFF_ROUNDS.find(r => r.weekNum === weekNum);
  if (round) return round.label.replace("🏆 ", ""); // strip emoji for progress messages
  return `Regular Season Week ${weekNum}`;
}

// ── Import mode picker ─────────────────────────────────────────────────────────
function buildImportModeContent() {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📥 Import Data Only — Choose Mode")
    .setDescription(
      "**📥 Import + Payouts**\n" +
      "Normal import — stats are stored and coin payouts are issued for game results.\n\n" +
      "**📦 Reimport — No Payouts**\n" +
      "Stats are stored but **no coins are awarded and W/L records are not updated**.\n" +
      "Use this when reimporting missing weeks (e.g. Weeks 3 & 4) or correcting data after a clear.",
    )
    .setFooter({ text: "No payouts will be triggered in Reimport mode" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_import_mode:0")
      .setLabel("📥 Import + Payouts")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ld_import_mode:1")
      .setLabel("📦 Reimport — No Payouts")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("✕ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ── Connected status + week select ─────────────────────────────────────────────
async function buildWeekSelectContent(guildId: string, connInfo?: { leagueName: string; eaLeagueId: number; platform: string }, skipPayouts = false) {
  const [season] = await db
    .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber, currentWeek: seasonsTable.currentWeek })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  const currentWeekNum = season ? weekStringToNum(season.currentWeek) : 1;
  const maxWeek = currentWeekNum; // include current week and all previous weeks

  const conn = connInfo ?? await loadEAConnection(guildId);

  // Build the list of selectable weeks (reg season + playoff rounds up to maxWeek)
  const options: StringSelectMenuOptionBuilder[] = [];

  for (let w = 1; w <= Math.min(maxWeek, 18); w++) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`Week ${w}`)
        .setValue(`reg:${w}`)
        .setDescription(`Regular Season Week ${w} (stageIndex 1, weekIndex ${w - 1})`),
    );
  }

  for (const round of PLAYOFF_ROUNDS) {
    if (round.weekNum <= maxWeek) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(round.label)
          .setValue(`reg:${round.weekNum}`)
          .setDescription(round.desc),
      );
    }
  }

  const hasOptions = options.length > 0;

  const modeNote = skipPayouts ? "\n\n⚠️ **Reimport mode — No Payouts:** Stats will be stored but no coins will be awarded and W/L records will not be updated." : "";
  const footerBase = connInfo ? `League ID: ${connInfo.eaLeagueId}` : (conn ? `League ID: ${conn.eaLeagueId}` : "No connection");

  const embed = new EmbedBuilder()
    .setColor(skipPayouts ? Colors.Orange : Colors.Green)
    .setTitle(connInfo ? "✅ Connected! Select Week to Import" : (skipPayouts ? "📦 Reimport — No Payouts · Select Week" : "📥 Select Week to Import"))
    .setDescription(
      (connInfo
        ? `**League:** ${connInfo.leagueName} · **Platform:** ${connInfo.platform.toUpperCase()}\n\n`
        : "") +
      (!hasOptions
        ? "⚠️ No weeks available yet. Make sure the season is active."
        : `Select a week to import from EA.\n\n` +
          `Current week: **${currentWeekNum <= 18 ? `Week ${currentWeekNum}` : (PLAYOFF_ROUNDS.find(r => r.weekNum === currentWeekNum)?.label ?? `Week ${currentWeekNum}`)}**\n` +
          `Available: Weeks 1–${Math.min(maxWeek, 18)}` +
          (maxWeek >= 19 ? ` + ${PLAYOFF_ROUNDS.filter(r => r.weekNum <= maxWeek).map(r => r.label.replace("🏆 ", "")).join(", ")}` : "")) +
      modeNote,
    )
    .setFooter({ text: skipPayouts ? `${footerBase} · Reimport mode — no payouts` : footerBase });

  if (!hasOptions) {
    return { embeds: [embed], components: [cancelRow()] };
  }

  const payFlag = skipPayouts ? "1" : "0";

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ld_select_week:${payFlag}`)
    .setPlaceholder("Select a week or playoff round to import…")
    .addOptions(options);

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const proceedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ld_proceed:0:${payFlag}`)
      .setLabel("⬆ Select a week first")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("✕ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [selectRow, proceedRow] };
}

// ── Clear season data: option keys and labels ──────────────────────────────────
const CLEAR_KEYS = ["rec", "stats", "sched", "rosters", "links", "coins", "legends"] as const;
type ClearKey = typeof CLEAR_KEYS[number];

const CLEAR_LABELS: Record<ClearKey, { short: string; desc: string; detail: string }> = {
  rec:     { short: "Season Team Records",          desc: "W/L records, game logs, and matchup scores",               detail: "W/L records, game log entries, and schedule scores" },
  stats:   { short: "Season Team Stats",            desc: "Player stats, week-processed tracker, stat padding flags",  detail: "Player stats, week-processed tracker, stat padding flags, and team season stats" },
  sched:   { short: "Full Season Schedule",         desc: "All matchup rows for this season (full wipe)",             detail: "All franchise schedule rows for this season" },
  rosters: { short: "Team Rosters",                 desc: "All imported roster data for this season",                  detail: "All franchise roster rows for this season" },
  links:   { short: "All Team Links",               desc: "Unlinks every user from their current team",               detail: "Clears usersTable.team and MCA discordId for all guild members" },
  coins:   { short: "Coins",                        desc: "Resets all users' coin balances to 0",                     detail: "Sets balance = 0 for every user in this guild" },
  legends: { short: "Reset Legends to Store",       desc: "Returns all purchased legends back to the store",          detail: "Deletes legend inventory entries and marks legends as available again" },
};

// ── Clear season data: step 1 — multi-select toggle ────────────────────────────
function buildClearSelectContent() {
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🗑️ Clear Season Data — Select Options")
    .setDescription(
      "Choose what to clear for the **active season**.\n" +
      "Select one or more options from the dropdown, then close it to proceed to the confirmation screen.\n\n" +
      "⚠️ **All selected actions are permanent and cannot be undone.**",
    )
    .setFooter({ text: "Global all-time records are never affected" });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ld_clear_select")
    .setPlaceholder("Select what to clear…")
    .setMinValues(1)
    .setMaxValues(7)
    .addOptions(
      CLEAR_KEYS.map(k =>
        new StringSelectMenuOptionBuilder()
          .setValue(k)
          .setLabel(CLEAR_LABELS[k].short)
          .setDescription(CLEAR_LABELS[k].desc),
      ),
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ld_cancel_to_main").setLabel("← Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── Clear season data: step 2 — confirmation screen ───────────────────────────
function buildClearConfirmContent(keys: string[]) {
  const lines = keys.map(k => `• **${CLEAR_LABELS[k as ClearKey]?.short ?? k}** — ${CLEAR_LABELS[k as ClearKey]?.detail ?? ""}`);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Confirm Clear — Are You Sure?")
    .setDescription(
      "**The following will be permanently wiped for the active season:**\n\n" +
      lines.join("\n") +
      "\n\n**This cannot be undone.**",
    )
    .setFooter({ text: "Global all-time records are NOT cleared — only this season's data" });

  const encoded = keys.join("|");
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ld_clear_confirm:${encoded}`).setLabel("✅ Yes, Clear Selected Data").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ld_clear_data").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── Admin guard ────────────────────────────────────────────────────────────────
async function guardAdmin(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction): Promise<boolean> {
  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.reply({ content: "❌ Commissioner access required.", ephemeral: true });
    return false;
  }
  return true;
}

// ── Main button handler ────────────────────────────────────────────────────────
export async function handleLeagueDataButton(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  const idParts = interaction.customId.split(":");
  const action  = idParts[0]!;
  const param   = idParts[1];
  const flagPart = idParts[2] ?? "0";   // "0" = with payouts, "1" = no payouts
  const guildId = interaction.guildId!;

  // ── Back to main menu ──────────────────────────────────────────────────────
  if (action === "ld_cancel_to_main" || action === "ld_main") {
    const content = await buildLeagueDataMainMenu(guildId);
    await interaction.update(content as any);
    return;
  }

  // ── Step 1: Show login link ────────────────────────────────────────────────
  if (action === "ld_start_connect") {
    await interaction.update(buildStep1Content() as any);
    return;
  }

  // ── Step 2: Open URL modal ─────────────────────────────────────────────────
  if (action === "ld_next_to_url") {
    await interaction.showModal(buildUrlModal());
    return;
  }

  // ── Import Only: show mode picker (payouts on/off) ────────────────────────
  if (action === "ld_import_only") {
    const conn = await loadEAConnection(guildId).catch(() => null);
    if (!conn) {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ No EA Connection")
            .setDescription(
              "You don't have an active EA connection for this server.\n\n" +
              "Click **Cancel** to go back and use **Start EA Connection** to set one up first.",
            ),
        ],
        components: [cancelRow()],
      } as any);
      return;
    }
    await interaction.update(buildImportModeContent() as any);
    return;
  }

  // ── Import mode selected: 0 = with payouts, 1 = no payouts ───────────────
  if (action === "ld_import_mode") {
    const skipPayouts = param === "1";
    const content = await buildWeekSelectContent(guildId, undefined, skipPayouts);
    await interaction.update(content as any);
    return;
  }

  // ── Clear: show option-select screen ─────────────────────────────────────
  if (action === "ld_clear_data") {
    await interaction.update(buildClearSelectContent() as any);
    return;
  }

  // ── Clear: confirm and execute selected options ────────────────────────────
  if (action === "ld_clear_confirm") {
    const keys = (param ?? "").split("|").filter(k => CLEAR_KEYS.includes(k as ClearKey)) as ClearKey[];
    if (!keys.length) {
      await interaction.reply({ content: "❌ No valid options selected.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    const [season] = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .limit(1);

    if (!season) {
      await interaction.editReply({ content: "❌ No active season found.", components: [], embeds: [] });
      return;
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Clearing selected season data…")],
      components: [],
    });

    try {
      const resultLines: string[] = [];

      // ── Season Team Records ────────────────────────────────────────────────
      if (keys.includes("rec")) {
        const [urDel, glDel] = await Promise.all([
          db.delete(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id)),
          db.delete(gameLogTable).where(eq(gameLogTable.seasonId, season.id)),
        ]);
        // NULL out schedule scores (keep matchup rows for re-import)
        await db.execute(sql`UPDATE franchise_schedule SET home_score = NULL, away_score = NULL WHERE season_id = ${season.id}`);
        // Rebuild global all-time records
        await db.execute(sql`
          INSERT INTO global_user_records (discord_id, wins, losses, ties, point_differential, updated_at)
          SELECT discord_id, SUM(wins), SUM(losses), SUM(ties), SUM(point_differential), NOW()
          FROM user_records
          GROUP BY discord_id
          ON CONFLICT (discord_id) DO UPDATE SET
            wins               = EXCLUDED.wins,
            losses             = EXCLUDED.losses,
            ties               = EXCLUDED.ties,
            point_differential = EXCLUDED.point_differential,
            updated_at         = NOW()
        `);
        resultLines.push(`• **Season Team Records** — ${(urDel as any).rowCount ?? 0} records, ${(glDel as any).rowCount ?? 0} game logs deleted; schedule scores cleared`);
      }

      // ── Season Team Stats ──────────────────────────────────────────────────
      if (keys.includes("stats")) {
        const [psDel, pwpDel, spvDel, tssDel] = await Promise.all([
          db.delete(playerSeasonStatsTable).where(eq(playerSeasonStatsTable.seasonId, season.id)),
          db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
          db.delete(statPaddingViolationsTable).where(eq(statPaddingViolationsTable.seasonId, season.id)),
          db.delete(teamSeasonStatsTable).where(eq(teamSeasonStatsTable.seasonId, season.id)),
        ]);
        resultLines.push(`• **Season Team Stats** — ${(psDel as any).rowCount ?? 0} player stat rows, ${(pwpDel as any).rowCount ?? 0} week-processed, ${(spvDel as any).rowCount ?? 0} padding flags, ${(tssDel as any).rowCount ?? 0} team stat rows deleted`);
      }

      // ── Full Season Schedule ───────────────────────────────────────────────
      if (keys.includes("sched")) {
        const schedDel = await db.delete(franchiseScheduleTable).where(eq(franchiseScheduleTable.seasonId, season.id));
        // Also clear week-processed so weeks can be reimported fresh
        await db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id));
        resultLines.push(`• **Full Season Schedule** — ${(schedDel as any).rowCount ?? 0} schedule rows deleted`);
      }

      // ── Team Rosters ───────────────────────────────────────────────────────
      if (keys.includes("rosters")) {
        const rostDel = await db.delete(franchiseRostersTable).where(eq(franchiseRostersTable.seasonId, season.id));
        resultLines.push(`• **Team Rosters** — ${(rostDel as any).rowCount ?? 0} roster rows deleted`);
      }

      // ── All Team Links ─────────────────────────────────────────────────────
      if (keys.includes("links")) {
        const [usersUpd, mcaUpd] = await Promise.all([
          db.update(usersTable)
            .set({ team: null })
            .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team), ne(usersTable.team, ""))),
          db.update(franchiseMcaTeamsTable)
            .set({ discordId: null })
            .where(eq(franchiseMcaTeamsTable.seasonId, season.id)),
        ]);
        resultLines.push(`• **All Team Links** — ${(usersUpd as any).rowCount ?? 0} users unlinked, ${(mcaUpd as any).rowCount ?? 0} MCA entries cleared`);
      }

      // ── Coins ──────────────────────────────────────────────────────────────
      if (keys.includes("coins")) {
        const coinsUpd = await db.execute(
          sql`UPDATE users SET balance = 0 WHERE guild_id = ${guildId} AND discord_id NOT LIKE 'unlinked_%'`,
        );
        resultLines.push(`• **Coins** — ${(coinsUpd as any).rowCount ?? 0} users reset to 0 coins`);
      }

      // ── Reset Legends to Store ─────────────────────────────────────────────
      if (keys.includes("legends")) {
        // Find legend inventory entries for this season
        const legendInvRows = await db.select({ legendId: inventoryTable.legendId })
          .from(inventoryTable)
          .where(and(eq(inventoryTable.seasonId, season.id), eq(inventoryTable.itemType, "legend"), isNotNull(inventoryTable.legendId)));

        const legendIds = [...new Set(legendInvRows.map(r => r.legendId!))];
        const invDel = await db.delete(inventoryTable)
          .where(and(eq(inventoryTable.seasonId, season.id), eq(inventoryTable.itemType, "legend")));

        // Mark them available again in the store
        if (legendIds.length > 0) {
          await db.update(legendsTable).set({ isAvailable: true }).where(inArray(legendsTable.id, legendIds));
        }
        resultLines.push(`• **Reset Legends to Store** — ${(invDel as any).rowCount ?? 0} inventory entries removed, ${legendIds.length} legends returned to store`);
      }

      const embed = new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Season Data Cleared")
        .setDescription(
          `**Season ${season.seasonNumber}** — selected data wiped:\n\n` +
          resultLines.join("\n"),
        )
        .setFooter({ text: "Global all-time records were not affected" })
        .setTimestamp();

      await interaction.editReply({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ld_cancel_to_main").setLabel("← Back to Menu").setStyle(ButtonStyle.Secondary),
          ) as any,
        ],
      });
    } catch (err: any) {
      console.error("[ld_clear_confirm]", err);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Error during clear: ${err?.message ?? String(err)}`)],
        components: [cancelRow()],
      });
    }
    return;
  }

  // ── Proceed with import ────────────────────────────────────────────────────
  if (action === "ld_proceed") {
    const parts = (param ?? "").split("_"); // format: "reg_3" or "pre_3"
    const weekType    = (parts[0] ?? "reg") as "reg" | "pre";
    const weekNum     = parseInt(parts[1] ?? "0", 10);
    const skipPayouts = flagPart === "1";

    if (!weekNum || weekNum < 1) {
      await interaction.reply({ content: "❌ Invalid week selection.", ephemeral: true });
      return;
    }

    const wkLabel = weekType === "pre" ? `Preseason Week ${weekNum}` : `Regular Season Week ${weekNum}`;

    await interaction.deferUpdate();

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setDescription(
            `⏳ Importing **${wkLabel}** from EA…` +
            (skipPayouts ? "\n\n📦 Reimport mode — no coin payouts will be triggered." : ""),
          ),
      ],
      components: [],
    });

    try {
      await runWeekImport({
        guildId,
        weekNum,
        weekType,
        skipPayouts,
        guild: interaction.guild,
        editReply: data => interaction.editReply(data),
      });
    } catch (err: any) {
      console.error("[ld_proceed]", err);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Import Failed")
            .setDescription(err?.message ?? String(err)),
        ],
        components: [cancelRow()],
      });
    }
    return;
  }
}

// ── Modal submit handler ───────────────────────────────────────────────────────
export async function handleLeagueDataModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  const [action] = interaction.customId.split(":");
  const guildId  = interaction.guildId!;
  const userId   = interaction.user.id;

  if (action !== "ld_modal_url") return;

  const redirectUrl = interaction.fields.getTextInputValue("redirect_url").trim();

  // deferUpdate works because this modal was opened by a button on a message
  await interaction.deferUpdate();

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Exchanging auth code with EA…")],
    components: [],
  });

  try {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Exchanging auth code with EA…")], components: [] });

    const accessToken = await exchangeCodeForToken(redirectUrl);

    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Looking up your EA personas and platform…")], components: [] });
    const personas = await detectPersonas(accessToken);

    if (personas.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ No Madden Personas Found")
            .setDescription(
              "No Madden 26 personas were found on this EA account.\n\n" +
              "Make sure you're using the **commissioner's EA account** that owns Madden 26, then try again.",
            ),
        ],
        components: [cancelRow()],
      });
      return;
    }

    const persona = personas[0]!;
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Authorizing persona **${persona.personaId}** (${persona.platform.toUpperCase()})…`)], components: [] });

    const scopedToken = await getPersonaScopedTokens(accessToken, persona.personaId, persona.namespace, persona.platform);

    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Fetching your Madden leagues from EA…")], components: [] });
    const leagues = await getLeaguesFromToken(scopedToken);

    if (leagues.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ No Leagues Found")
            .setDescription(
              "No Madden 26 CFM leagues were found for this account.\n\n" +
              "Make sure the commissioner's team is in an active franchise league.",
            ),
        ],
        components: [cancelRow()],
      });
      return;
    }

    if (leagues.length === 1) {
      // Auto-connect
      const league = leagues[0]!;
      await saveEAConnection({ guildId, eaLeagueId: league.leagueId, leagueName: league.leagueName, token: scopedToken, connectedBy: userId });

      const weekContent = await buildWeekSelectContent(guildId, {
        leagueName:  league.leagueName,
        eaLeagueId:  league.leagueId,
        platform:    scopedToken.platform,
      });
      await interaction.editReply(weekContent as any);
      return;
    }

    // Multiple leagues — store pending and show select menu
    pendingSessions.set(userId, {
      guildId,
      leagues,
      token: scopedToken,
      personas,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    await interaction.editReply(buildLeagueSelectContent(leagues) as any);
  } catch (err: any) {
    console.error("[ld_modal_url]", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Connection Failed")
          .setDescription(
            `${err?.message ?? String(err)}\n\n` +
            "The redirect URL may be expired. Click Cancel, then run the command again to get a fresh login link.",
          ),
      ],
      components: [cancelRow()],
    });
  }
}

// ── Select menu handler ────────────────────────────────────────────────────────
export async function handleLeagueDataSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  const parts   = interaction.customId.split(":");
  const action  = parts[0]!;
  const flagStr = parts[1] ?? "0";          // "0" = with payouts, "1" = no payouts
  const guildId  = interaction.guildId!;
  const userId   = interaction.user.id;
  const value    = interaction.values[0] ?? "";

  // ── Clear season data option selection ─────────────────────────────────────
  if (action === "ld_clear_select") {
    const selectedKeys = interaction.values.filter(k => CLEAR_KEYS.includes(k as ClearKey));
    await interaction.update(buildClearConfirmContent(selectedKeys) as any);
    return;
  }

  // ── League selection ────────────────────────────────────────────────────────
  if (action === "ld_select_league") {
    const leagueId = parseInt(value, 10);
    const session  = pendingSessions.get(userId);

    if (!session || Date.now() > session.expiresAt) {
      pendingSessions.delete(userId);
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setDescription("❌ Session expired. Click Cancel and start the process again."),
        ],
        components: [cancelRow()],
      } as any);
      return;
    }

    const league = session.leagues.find(l => l.leagueId === leagueId);
    if (!league) {
      await interaction.reply({ content: "❌ League not found in session.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    try {
      await saveEAConnection({
        guildId,
        eaLeagueId: league.leagueId,
        leagueName: league.leagueName,
        token:      session.token,
        connectedBy: userId,
      });
      pendingSessions.delete(userId);

      const weekContent = await buildWeekSelectContent(guildId, {
        leagueName: league.leagueName,
        eaLeagueId: league.leagueId,
        platform:   session.token.platform,
      });
      await interaction.editReply(weekContent as any);
    } catch (err: any) {
      console.error("[ld_select_league]", err);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setDescription(`❌ Failed to save connection: ${err?.message}`),
        ],
        components: [cancelRow()],
      });
    }
    return;
  }

  // ── Week selection ─────────────────────────────────────────────────────────
  if (action === "ld_select_week") {
    // value format: "reg:3" or "reg:19" (playoff) or "pre:1"
    // flagStr from customId carries the skipPayouts flag ("0" or "1")
    const skipPayouts = flagStr === "1";
    const [stage, weekStr] = value.split(":");
    const weekNum  = parseInt(weekStr ?? "0", 10);
    const stageKey = stage === "pre" ? "pre" : "reg";
    const chosen   = getWeekLabel(stageKey, weekNum);

    const conn = await loadEAConnection(guildId).catch(() => null);

    const [season] = await db
      .select({ currentWeek: seasonsTable.currentWeek })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .limit(1);

    const currentWeekNum = season ? weekStringToNum(season.currentWeek) : 1;
    const maxWeek = currentWeekNum;

    const modeNote = skipPayouts ? "\n\n⚠️ **Reimport mode — No Payouts:** Coins will not be awarded and W/L records will not be updated." : "";

    const embed = new EmbedBuilder()
      .setColor(skipPayouts ? Colors.Orange : Colors.Green)
      .setTitle(skipPayouts ? "📦 Reimport — No Payouts · Select Week" : "📥 Select Week to Import")
      .setDescription(
        `**Selected: ${chosen}**\n\n` +
        (conn
          ? `League: **${conn.leagueName}** · Platform: **${conn.token.platform.toUpperCase()}**\n\n`
          : "") +
        `Click **Proceed with Import** to start, or pick a different week from the dropdown.` +
        modeNote,
      )
      .setFooter({ text: conn ? `League ID: ${conn.eaLeagueId}` : "No connection info" });

    // Rebuild the dropdown with the same options, marking selected; carry the flag in customId
    const options: StringSelectMenuOptionBuilder[] = [];
    for (let w = 1; w <= Math.min(maxWeek, 18); w++) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Week ${w}`)
          .setValue(`reg:${w}`)
          .setDescription(`Regular Season Week ${w} (stageIndex 1, weekIndex ${w - 1})`)
          .setDefault(w === weekNum && stageKey === "reg"),
      );
    }
    for (const round of PLAYOFF_ROUNDS) {
      if (round.weekNum <= maxWeek) {
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(round.label)
            .setValue(`reg:${round.weekNum}`)
            .setDescription(round.desc)
            .setDefault(round.weekNum === weekNum && stageKey === "reg"),
        );
      }
    }

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ld_select_week:${flagStr}`)
        .setPlaceholder(chosen)
        .addOptions(options),
    );

    const proceedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ld_proceed:${stageKey}_${weekNum}:${flagStr}`)
        .setLabel(`⬆ Proceed with Import — ${chosen}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("ld_cancel_to_main")
        .setLabel("✕ Cancel")
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.update({ embeds: [embed], components: [selectRow, proceedRow] } as any);
    return;
  }
}

// ── Core week import logic ─────────────────────────────────────────────────────
// Adapted from admin-ea-export.ts exportWeek() — no interaction dependency.

function getApiBase(): string {
  const raw = process.env["MADDEN_API_BASE_URL"] ?? process.env["API_BASE_URL"] ?? "";
  const cleaned = raw.trim().replace(/\/+$/, "");

  if (!cleaned) {
    throw new Error("MADDEN_API_BASE_URL is not set — cannot reach the API server from the Discord bot service");
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(`MADDEN_API_BASE_URL is not a valid URL: ${cleaned}`);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`MADDEN_API_BASE_URL must start with http:// or https://: ${cleaned}`);
  }

  return cleaned.endsWith("/api") ? cleaned : `${cleaned}/api`;
}

function getWebhookKey(): string {
  const key = process.env["MADDEN_WEBHOOK_KEY"];
  if (!key) throw new Error("MADDEN_WEBHOOK_KEY is not set");
  return key;
}

async function postToApi(url: string, payload: unknown): Promise<{ ok: boolean; status: number; body?: any }> {
  try {
    const res = await axios.post(url, payload, {
      headers:        { "Content-Type": "application/json" },
      timeout:        60_000,
      validateStatus: () => true,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.data };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const code = err?.code ? ` code=${err.code}` : "";
    const cause = err?.cause?.message ? ` cause=${err.cause.message}` : "";
    console.error(`[ld/postToApi] ${msg}${code}${cause} url=${url}`);
    return { ok: false, status: 0, body: { error: msg } };
  }
}

// ── Schedule-only import (used by Troubleshoot panel) ─────────────────────────
export async function runScheduleOnlyImport(guildId: string): Promise<{
  ok:        boolean;
  synced:    number;
  total:     number;
  weekLabel: string;
  error?: "no_connection" | "token_refresh_failed" | "fetch_failed";
}> {
  // Determine the current week so we fetch only that week's schedule.
  const [seasonRow] = await db
    .select({ currentWeek: seasonsTable.currentWeek })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  const currentWeekNum = seasonRow ? weekStringToNum(seasonRow.currentWeek) : 1;

  // Human-readable label for result messaging
  const PLAYOFF_LABEL_MAP: Record<number, string> = { 19: "Wild Card", 20: "Divisional", 21: "Conference Championship", 23: "Super Bowl" };
  const wkLabel = currentWeekNum > 18
    ? (PLAYOFF_LABEL_MAP[currentWeekNum] ?? `Week ${currentWeekNum}`)
    : `Week ${currentWeekNum}`;

  const conn = await loadEAConnection(guildId);
  if (!conn) return { ok: false, synced: 0, total: 0, weekLabel: wkLabel, error: "no_connection" };

  let { token, eaLeagueId } = conn;
  try {
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) {
      await updateStoredToken(eaLeagueId, refreshed);
      token = refreshed;
    }
  } catch {
    return { ok: false, synced: 0, total: 0, weekLabel: wkLabel, error: "token_refresh_failed" };
  }

  const platform   = token.platform;
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const leagueBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}`;
  const guildQs    = `?guildId=${encodeURIComponent(guildId)}`;

  // Fetch only the current week — startWeek = totalWeeks = currentWeekNum
  let weekResults: { weekNum: number; data: unknown }[];
  try {
    const result = await fetchAllWeekSchedules(token, eaLeagueId, currentWeekNum, 1, currentWeekNum);
    weekResults = result.weekResults;
  } catch {
    return { ok: false, synced: 0, total: 0, weekLabel: wkLabel, error: "fetch_failed" };
  }

  let synced = 0;
  const total = weekResults.length;
  for (const { weekNum: wk, data } of weekResults) {
    const url = `${leagueBase}/week/reg/${wk}/schedule-import${guildQs}`;
    const r = await postToApi(url, data);
    if (r.ok) synced++;
  }

  return { ok: synced === total, synced, total, weekLabel: wkLabel };
}

async function runRosterSync(token: TokenInfo, eaLeagueId: number, guild?: Guild | null, guildId?: string, existingSession?: BlazeSession): Promise<{ summaryLine: string; allOk: boolean }> {
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const platform   = token.platform;
  const guildQs    = guildId ? `?guildId=${encodeURIComponent(guildId)}` : "";
  const leagueBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}`;

  if (guild) {
    try {
      const members = await guild.members.fetch();
      const gId     = guild.id;
      const ops: Promise<any>[] = [];
      for (const [memberId, member] of members) {
        ops.push(
          db.update(usersTable)
            .set({ serverNickname: member.displayName, updatedAt: new Date() })
            .where(and(eq(usersTable.discordId, memberId), eq(usersTable.guildId, gId))),
        );
      }
      await Promise.all(ops);
    } catch (err) {
      console.warn("[ld/roster-sync] Nickname sync failed (non-fatal):", err);
    }
  }

  let rosterData: Awaited<ReturnType<typeof fetchLeagueTeamsAndRosters>>;
  try {
    rosterData = await fetchLeagueTeamsAndRosters(token, eaLeagueId, existingSession);
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) await updateStoredToken(eaLeagueId, refreshed);
  } catch (err: any) {
    return { summaryLine: `❌ Roster sync failed — ${err?.message ?? String(err)}`, allOk: false };
  }

  const results: { name: string; ok: boolean; status: number }[] = [];

  const teamsRes = await postToApi(`${leagueBase}/leagueteams${guildQs}`, rosterData.leagueTeams);
  results.push({ name: "leagueTeams", ...teamsRes });

  for (const { teamId, data } of rosterData.teamRosters) {
    const res = await postToApi(`${leagueBase}/team/${teamId}/roster${guildQs}`, data);
    results.push({ name: `roster:${teamId}`, ...res });
  }

  const faRes = await postToApi(`${leagueBase}/freeagents/roster${guildQs}`, rosterData.freeAgents);
  results.push({ name: "freeAgents", ...faRes });

  const failed       = results.filter(r => !r.ok);
  const rosterSynced = results.filter(r => r.ok && (r.name.startsWith("roster:") || r.name === "freeAgents")).length;
  const teamsOk      = !failed.find(r => r.name === "leagueTeams");

  const summaryLine = failed.length === 0
    ? `✅ leagueTeams + ${rosterSynced} rosters + free agents synced`
    : `⚠️ Roster sync partial — ${failed.length} failed (leagueTeams:${teamsOk ? "ok" : "fail"}, rosters:${failed.filter(r => r.name.startsWith("roster:")).length} failed)`;

  return { summaryLine, allOk: failed.length === 0 };
}


function normalTeamName(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

async function reconcileImportedGameSchedulesForGotw(args: {
  guildId: string;
  weekIndex: number;
}): Promise<{ updated: number; created: number }> {
  const [season] = await db.select().from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, args.guildId), eq(seasonsTable.isActive, true)))
    .limit(1);
  if (!season) return { updated: 0, created: 0 };

  const [franchiseRows, gameRows, gotwRows] = await Promise.all([
    db.select().from(franchiseScheduleTable)
      .where(and(eq(franchiseScheduleTable.seasonId, season.id), eq(franchiseScheduleTable.weekIndex, args.weekIndex))),
    db.select().from(gameSchedulesTable)
      .where(and(eq(gameSchedulesTable.guildId, args.guildId), eq(gameSchedulesTable.seasonId, season.id), eq(gameSchedulesTable.weekIndex, args.weekIndex))),
    db.select().from(gotwHistoryTable)
      .where(and(eq(gotwHistoryTable.seasonId, season.id), eq(gotwHistoryTable.weekIndex, args.weekIndex))),
  ]);

  const gotwByPair = new Map<string, typeof gotwRows[number]>();
  for (const h of gotwRows) {
    const names = [normalTeamName(h.teamName1), normalTeamName(h.teamName2)].sort().join("|");
    gotwByPair.set(names, h);
  }

  let updated = 0;
  let created = 0;

  for (const fs of franchiseRows) {
    const pairKey = [normalTeamName(fs.awayTeamName), normalTeamName(fs.homeTeamName)].sort().join("|");
    const gotw = gotwByPair.get(pairKey);
    if (!gotw) continue;

    const awayDiscordId = normalTeamName(fs.awayTeamName) === normalTeamName(gotw.teamName1)
      ? gotw.discordId1
      : gotw.discordId2;
    const homeDiscordId = normalTeamName(fs.homeTeamName) === normalTeamName(gotw.teamName1)
      ? gotw.discordId1
      : gotw.discordId2;

    const awayScore = fs.awayScore == null ? null : Number(fs.awayScore);
    const homeScore = fs.homeScore == null ? null : Number(fs.homeScore);
    const hasFinalScore = awayScore != null && homeScore != null && awayScore !== homeScore;
    const winnerDiscordId = hasFinalScore
      ? (awayScore > homeScore ? awayDiscordId : homeDiscordId)
      : null;

    const matched = gameRows.find(gs => {
      const sameNames =
        (normalTeamName(gs.awayTeamName) === normalTeamName(fs.awayTeamName) && normalTeamName(gs.homeTeamName) === normalTeamName(fs.homeTeamName)) ||
        (normalTeamName(gs.awayTeamName) === normalTeamName(fs.homeTeamName) && normalTeamName(gs.homeTeamName) === normalTeamName(fs.awayTeamName));
      const sameIds =
        (gs.awayDiscordId === awayDiscordId && gs.homeDiscordId === homeDiscordId) ||
        (gs.awayDiscordId === homeDiscordId && gs.homeDiscordId === awayDiscordId);
      return sameNames || sameIds;
    });

    if (matched) {
      await db.update(gameSchedulesTable).set({
        awayDiscordId,
        homeDiscordId,
        awayTeamName: fs.awayTeamName,
        homeTeamName: fs.homeTeamName,
        awayScore,
        homeScore,
        importedWinnerDiscordId: winnerDiscordId,
        winnerDiscordId: winnerDiscordId ?? matched.winnerDiscordId,
        status: winnerDiscordId ? "completed_imported" : matched.status,
        finishedAt: winnerDiscordId ? (matched.finishedAt ?? new Date()) : matched.finishedAt,
        updatedAt: new Date(),
      }).where(eq(gameSchedulesTable.id, matched.id));
      updated++;
      continue;
    }

    await db.insert(gameSchedulesTable).values({
      guildId: args.guildId,
      channelId: `imported-gotw-${season.id}-${args.weekIndex}-${gotw.matchupIndex}-${Date.now()}`,
      seasonId: Number(season.id),
      weekIndex: args.weekIndex,
      awayDiscordId,
      homeDiscordId,
      awayTeamName: fs.awayTeamName,
      homeTeamName: fs.homeTeamName,
      status: winnerDiscordId ? "completed_imported" : "imported",
      winnerDiscordId,
      importedWinnerDiscordId: winnerDiscordId,
      awayScore,
      homeScore,
      finishedAt: winnerDiscordId ? new Date() : null,
      updatedAt: new Date(),
    });
    created++;
  }

  return { updated, created };
}


export async function runWeekImport(ctx: {
  guildId:      string;
  weekNum:      number;
  weekType:     "reg" | "pre";
  guild:        Guild | null | undefined;
  editReply:    (data: any) => Promise<any>;
  skipPayouts?: boolean;
}): Promise<void> {
  const { guildId, weekNum, weekType, guild, editReply, skipPayouts = false } = ctx;

  const conn = await loadEAConnection(guildId);
  if (!conn) {
    await editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ No EA Connection")
          .setDescription("No EA connection found. Use **Start EA Connection** first."),
      ],
      components: [],
    });
    return;
  }

  let { token, eaLeagueId } = conn;
  // Playoffs (weeks 19/20/21/23) use stageIndex=1 (same as regular season), weekIndex = weekNum - 1.
  // Wild Card (wk 19) → index 18 | Divisional (wk 20) → index 19 | Conf Champ (wk 21) → index 20 | Super Bowl (wk 23) → index 22
  const stageIndex = weekType === "pre" ? 0 : 1;
  const weekIndex  = weekNum - 1;
  const wkLabel    = getWeekLabel(weekType, weekNum);

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Fetching **${wkLabel}** stats from EA…`)],
    components: [],
  });

  // Create ONE Blaze session for the entire import — stats, rosters, news, and
  // schedule sync all reuse it so EA never sees more than one session per import.
  let blazeSession: BlazeSession;
  try {
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) {
      await updateStoredToken(eaLeagueId, refreshed);
      token = refreshed;
    }
    blazeSession = await createBlazeSession(token);
  } catch (err: any) {
    console.error("[ld/import] Blaze session creation failed:", err);
    await editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle(`❌ Fetch Failed — ${wkLabel}`)
          .setDescription(
            `${err?.message ?? String(err)}\n\n` +
            "If you see an auth error, use **Start EA Connection** to refresh the link.",
          ),
      ],
      components: [],
    });
    return;
  }

  let stats: Awaited<ReturnType<typeof fetchWeeklyStats>>;
  try {
    stats = await fetchWeeklyStats(token, eaLeagueId, weekIndex, stageIndex, blazeSession);
  } catch (err: any) {
    console.error("[ld/import] Fetch error:", err);
    await editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle(`❌ Fetch Failed — ${wkLabel}`)
          .setDescription(
            `${err?.message ?? String(err)}\n\n` +
            "If you see an auth error, use **Start EA Connection** to refresh the link.",
          ),
      ],
      components: [],
    });
    return;
  }

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Syncing rosters from EA (~60s)…")],
    components: [],
  });

  const { summaryLine: rosterSummary, allOk: rostersAllOk } =
    await runRosterSync(token, eaLeagueId, guild, guildId, blazeSession);

  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const guildQs  = `?guildId=${encodeURIComponent(guildId)}`;
  const leagueBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}`;
  const weekBase = `${leagueBase}/week/${weekType}/${weekNum}`;

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Sending **${wkLabel}** stats to processor…`)],
    components: [],
  });

  // ── When reimporting (skipPayouts=true), erase the week's previously stored ──
  // data BEFORE posting new stats so nothing is double-counted in the cumulative
  // season tables. This subtracts the per-week delta snapshot, removes the dedup
  // markers, and clears schedule rows — the import pipeline then runs cleanly.
  if (skipPayouts) {
    await editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Clearing existing **${wkLabel}** data before reimport…`)],
      components: [],
    });
    const clearRes = await postToApi(`${weekBase}/clear${guildQs}`, {});
    if (!clearRes.ok) {
      console.warn(`[ld/import] clearWeek returned HTTP ${clearRes.status} — proceeding anyway`);
    }
  }

  const results: { name: string; ok: boolean; status: number; skipped?: boolean }[] = [];

  for (const [statType, urlSuffix] of [
    ["passing",    "passing"],
    ["rushing",    "rushing"],
    ["receiving",  "receiving"],
    ["defense",    "defense"],
    ["kicking",    "kicking"],
    ["punting",    "punting"],
    ["kickReturn", "kickreturn"],
    ["puntReturn", "puntreturn"],
  ] as const) {
    const payload = stats[statType as keyof typeof stats];
    if (payload == null) { results.push({ name: statType, ok: true, status: 0, skipped: true }); continue; }
    const res = await postToApi(`${weekBase}/${urlSuffix}${guildQs}`, payload);
    results.push({ name: statType, ...res });
  }

  const teamRes = await postToApi(`${weekBase}/team${guildQs}`, stats.teamStats);
  results.push({ name: "teamStats", ...teamRes });

  // StandingsExport is the current source for season standings, playoff seed data,
  // and Madden cap summary fields:
  //   capRoom      = adjusted cap / cap limit
  //   capSpent     = total spending
  //   capAvailable = cap space, including negative over-cap values
  const standingsRes = await postToApi(`${leagueBase}/standings${guildQs}`, (stats as any).standings);
  results.push({ name: "standings/cap", ...standingsRes });

  const schedulesUrl = skipPayouts
    ? `${weekBase}/schedules${guildQs}&skipPayouts=1`
    : `${weekBase}/schedules${guildQs}`;
  const schedRes = await postToApi(schedulesUrl, stats.schedules);
  // The /schedules endpoint now returns { scheduleCount, gamesProcessed, ... }
  // synchronously. Surface those counts so a silent "0 games written" failure
  // is visible. Detect EA's error-envelope shape directly from stats.schedules
  // so we can distinguish "EA outage" from "legitimately empty week" (e.g. a
  // bye-only week or a week with no fixtures yet).
  const schedCount   = Number(schedRes.body?.scheduleCount ?? 0);
  const schedGames   = Number(schedRes.body?.gamesProcessed ?? 0);
  const schedPayload = stats.schedules as any;
  const isEaError    = schedPayload && typeof schedPayload === "object" && "error" in schedPayload;
  let schedSuffix: string;
  if (isEaError) {
    const msg = String(schedPayload.error?.errortdf?.errorString ?? schedPayload.error?.errorname ?? "EA returned an error envelope");
    schedSuffix = `⚠️ EA error: ${msg}`;
  } else if (schedCount === 0) {
    schedSuffix = "⚠️ 0 games written — empty payload (no fixtures returned)";
  } else {
    schedSuffix = `${schedCount} games stored${skipPayouts ? "" : ` · ${schedGames} processed`}`;
  }
  // Treat 0-games as a soft failure even if HTTP returned 200, so the embed
  // doesn't show a misleading ✅.
  results.push({
    name:   `schedules (${schedSuffix})`,
    ok:     schedRes.ok && schedCount > 0,
    status: schedRes.status,
  });

  try {
    const gotwRepair = await reconcileImportedGameSchedulesForGotw({ guildId, weekIndex });
    if (gotwRepair.updated > 0 || gotwRepair.created > 0) {
      results.push({
        name: `GOTW schedule repair (${gotwRepair.updated} updated · ${gotwRepair.created} created)`,
        ok: true,
        status: 200,
      });
    }
  } catch (err) {
    console.warn("[ld/import] GOTW schedule repair failed (non-fatal):", err);
    results.push({ name: "GOTW schedule repair", ok: false, status: 0 });
  }

  try {
    const newsData = await fetchNewsData(token, eaLeagueId, blazeSession);
    if (newsData != null) {
      const newsRes = await postToApi(`${leagueBase}/news${guildQs}`, newsData);
      results.push({ name: "in-game news", ...newsRes });
    }
  } catch { /* non-fatal */ }

  // ── Schedule sync ─────────────────────────────────────────────────────────────
  // Regular season (weeks 1-17): fetch all 18 reg-season weeks so /seasonschedule
  // can show the full schedule immediately.
  // Weeks 18-21: only fetch the NEXT playoff round — prior weeks already stored.
  //   week 18 → fetch week 19 (Wild Card matchups)
  //   week 19 → fetch week 20 (Divisional matchups)
  //   week 20 → fetch week 21 (Conf Championship matchups)
  //   week 21 → fetch week 23 (Super Bowl matchup)
  // Week 23 (Super Bowl): no next round — skip.
  const NEXT_PLAYOFF_WEEK: Record<number, number> = { 18: 19, 19: 20, 20: 21, 21: 23 };
  const nextPlayoffWeek = NEXT_PLAYOFF_WEEK[weekNum];
  const isPlayoffOrWk18 = weekType !== "pre" && weekNum >= 18;

  let schedSyncLabel: string;
  if (weekType === "pre") {
    schedSyncLabel = "preseason";
  } else if (weekNum < 18) {
    schedSyncLabel = "reg season (weeks 1-18)";
  } else if (nextPlayoffWeek) {
    const ROUND_LABEL: Record<number, string> = { 19: "Wild Card", 20: "Divisional", 21: "Conf. Championship", 23: "Super Bowl" };
    schedSyncLabel = `next round (${ROUND_LABEL[nextPlayoffWeek] ?? `week ${nextPlayoffWeek}`})`;
  } else {
    schedSyncLabel = "none (Super Bowl — no next round)";
  }

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Syncing schedule: ${schedSyncLabel}…`)],
    components: [],
  });

  let schedulesSynced = 0;
  let schedSkipped    = false;
  if (weekType !== "pre") {
    try {
      if (!isPlayoffOrWk18) {
        // Regular season weeks 1-17: fetch all 18 weeks
        const { weekResults } = await fetchAllWeekSchedules(token, eaLeagueId, 18, 1, 1, blazeSession);
        for (const { weekNum: wk, data } of weekResults) {
          const url = `${leagueBase}/week/reg/${wk}/schedule-import${guildQs}`;
          const r = await postToApi(url, data);
          if (r.ok) schedulesSynced++;
        }
      } else if (nextPlayoffWeek) {
        // Week 18-21: fetch only the next playoff round's schedule
        const { weekResults } = await fetchAllWeekSchedules(token, eaLeagueId, nextPlayoffWeek, 1, nextPlayoffWeek, blazeSession);
        for (const { weekNum: wk, data } of weekResults) {
          const url = `${leagueBase}/week/reg/${wk}/schedule-import${guildQs}`;
          const r = await postToApi(url, data);
          if (r.ok) schedulesSynced++;
        }
      } else {
        // Super Bowl — no next round to pre-fetch
        schedSkipped = true;
      }
    } catch (err) {
      console.warn("[ld/import] Schedule sync failed (non-fatal):", err);
    }
  }

  const failCount    = results.filter(r => !r.ok && !r.skipped).length;
  const successCount = results.filter(r => r.ok).length;
  const overallOk    = failCount === 0 && rostersAllOk;

  const statsLines = results.map(r =>
    r.skipped ? `⏭ ${r.name}` :
    r.ok      ? `✅ ${r.name}` :
                `❌ ${r.name} (HTTP ${r.status})`,
  );

  const embed = new EmbedBuilder()
    .setColor(
      !overallOk                        ? (failCount > 0 || !rostersAllOk ? Colors.Yellow : Colors.Red) :
      skipPayouts                       ? Colors.Orange :
                                          Colors.Green,
    )
    .setTitle(skipPayouts ? `📦 Reimport Complete (No Payouts) — ${wkLabel}` : `📥 Import Complete — ${wkLabel}`)
    .setDescription(
      skipPayouts
        ? "✅ Previous week data was cleared first, then fresh stats were stored. **No coins were awarded** and **W/L records were not updated** — reimport mode was active.\n\nRun **Repair User Records** from `/admin-troubleshoot` if W/L counts look off."
        : null,
    )
    .addFields(
      { name: "📊 Player & Team Stats", value: statsLines.join("\n") || "none" },
      { name: "🏈 Roster Sync",         value: rosterSummary },
      { name: "📅 Season Schedule",      value: weekType === "pre" ? "⏭ Skipped (preseason)" : schedSkipped ? "⏭ Skipped (Super Bowl — no next round)" : schedulesSynced > 0 ? `✅ Next round schedule stored (${schedSyncLabel})` : "⚠️ Schedule sync failed (non-fatal)" },
      { name: "Result",                  value: overallOk
        ? "✅ All data imported successfully"
        : `⚠️ ${successCount}/${results.length} stats ok · ${rostersAllOk ? "rosters ok" : "roster errors"}`,
      },
    )
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
    .setTimestamp();

  const returnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("← Back to Menu")
      .setStyle(ButtonStyle.Secondary),
  );

  // ── Post to IMPORT_LOG channel (silent, non-fatal) ─────────────────────────
  try {
    const client = guild?.client;
    if (client) {
      const importChannelId =
        await getGuildChannel(guildId, CHANNEL_KEYS.IMPORT_LOG)
        ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
        ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
      if (importChannelId) {
        const ch = await client.channels.fetch(importChannelId).catch(() => null);
        if (ch?.isTextBased()) await (ch as TextChannel).send({ embeds: [embed] }).catch(console.error);
      }
    }
  } catch { /* non-fatal */ }

  await editReply({ embeds: [embed], components: [returnRow] });
}


// ── Isolated MCA Import Diagnostics (Troubleshoot Hub) ───────────────────────
type DiagnosticPayloadSummary = {
  label: string;
  kind: string;
  topLevelKeys: string[];
  nestedKeys: string[];
  itemCount: number | null;
  sample: unknown;
  warnings: string[];
};

function diagnosticSafeSample(value: unknown, maxJsonChars = 3000): unknown {
  try {
    const json = JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…`;
      return v;
    });
    if (!json) return null;
    return JSON.parse(json.length > maxJsonChars ? `${json.slice(0, maxJsonChars)}"…truncated"}` : json);
  } catch {
    return null;
  }
}

function collectObjectKeys(value: unknown, prefix = "", depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    const first = value.find(v => v && typeof v === "object");
    if (first) collectObjectKeys(first, prefix ? `${prefix}[]` : "[]", depth + 1, out);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object") collectObjectKeys(child, path, depth + 1, out);
  }
  return out;
}

function summarizeDiagnosticPayload(label: string, payload: unknown): DiagnosticPayloadSummary {
  const topValue = Array.isArray(payload)
    ? payload.find(v => v && typeof v === "object") ?? null
    : payload;

  const topLevelKeys = topValue && typeof topValue === "object" && !Array.isArray(topValue)
    ? Object.keys(topValue as Record<string, unknown>).sort()
    : [];

  const nestedKeys = [...collectObjectKeys(payload)].sort();
  const itemCount = Array.isArray(payload)
    ? payload.length
    : payload && typeof payload === "object"
      ? Object.keys(payload as Record<string, unknown>).length
      : null;

  const keyText = nestedKeys.join(" ").toLowerCase();
  const warnings: string[] = [];
  if (label === "teamStats") {
    const hasCapHints = ["cap", "salary", "spend", "spent", "penalty", "reserve", "rollover"].some(k => keyText.includes(k));
    if (!hasCapHints) warnings.push("No obvious cap/salary/dead-cap keys found in teamStats payload.");
  }
  if (Array.isArray(payload) && payload.length === 0) warnings.push("Payload array is empty.");
  if (payload == null) warnings.push("Payload is null/undefined.");

  return {
    label,
    kind: Array.isArray(payload) ? "array" : typeof payload,
    topLevelKeys,
    nestedKeys,
    itemCount,
    sample: diagnosticSafeSample(Array.isArray(payload) ? payload.slice(0, 2) : payload),
    warnings,
  };
}

const MCA_ENDPOINT_DISCOVERY_KEYWORDS = [
  "cap", "salary", "spend", "spent", "penalt", "reserve", "rollover", "room",
  "available", "contract", "bonus", "dead", "release", "guaranteed", "savings",
];

function extractCapHits(keys: string[]): string[] {
  return keys.filter(k => MCA_ENDPOINT_DISCOVERY_KEYWORDS.some(term => k.toLowerCase().includes(term))).slice(0, 80);
}

function summarizeProbePayload(payload: unknown): { kind: string; itemCount: number | null; topLevelKeys: string[]; nestedKeys: string[]; sample: unknown } {
  const topValue = Array.isArray(payload)
    ? payload.find(v => v && typeof v === "object") ?? null
    : payload;

  const topLevelKeys = topValue && typeof topValue === "object" && !Array.isArray(topValue)
    ? Object.keys(topValue as Record<string, unknown>).sort()
    : [];

  const nestedKeys = [...collectObjectKeys(payload)].sort();
  const itemCount = Array.isArray(payload)
    ? payload.length
    : payload && typeof payload === "object"
      ? Object.keys(payload as Record<string, unknown>).length
      : null;

  return {
    kind: Array.isArray(payload) ? "array" : typeof payload,
    itemCount,
    topLevelKeys,
    nestedKeys,
    sample: diagnosticSafeSample(Array.isArray(payload) ? payload.slice(0, 2) : payload),
  };
}

async function ensureImportDiagnosticTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists mca_import_diagnostic_runs (
      id bigserial primary key,
      guild_id text not null,
      season_id bigint,
      requested_by text,
      week_num integer,
      week_type text not null default 'reg',
      dry_run boolean not null default true,
      status text not null default 'running',
      summary jsonb not null default '{}'::jsonb,
      warnings jsonb not null default '[]'::jsonb,
      created_at timestamp with time zone not null default now(),
      completed_at timestamp with time zone
    )
  `);

  await db.execute(sql`
    create table if not exists mca_import_diagnostic_payloads (
      id bigserial primary key,
      run_id bigint not null references mca_import_diagnostic_runs(id) on delete cascade,
      guild_id text not null,
      season_id bigint,
      payload_label text not null,
      payload_kind text,
      item_count integer,
      top_level_keys jsonb not null default '[]'::jsonb,
      nested_keys jsonb not null default '[]'::jsonb,
      sample_json jsonb,
      warnings jsonb not null default '[]'::jsonb,
      created_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists mca_endpoint_probe_results (
      id bigserial primary key,
      run_id bigint not null references mca_import_diagnostic_runs(id) on delete cascade,
      guild_id text not null,
      season_id bigint,
      endpoint_label text not null,
      endpoint_name text not null,
      request_body jsonb not null default '{}'::jsonb,
      available boolean not null default false,
      payload_kind text,
      item_count integer,
      top_level_keys jsonb not null default '[]'::jsonb,
      nested_keys jsonb not null default '[]'::jsonb,
      cap_score integer not null default 0,
      cap_key_hits jsonb not null default '[]'::jsonb,
      sample_json jsonb,
      error_message text,
      created_at timestamp with time zone not null default now()
    )
  `);
}

export async function runMcaImportDiagnostics(ctx: {
  guildId: string;
  requestedBy: string;
  guild?: Guild | null;
}): Promise<{
  ok: boolean;
  runId?: number;
  weekLabel?: string;
  payloads?: DiagnosticPayloadSummary[];
  endpointProbeCount?: number;
  availableEndpointCount?: number;
  capEndpointHits?: string[];
  warnings?: string[];
  error?: "no_connection" | "token_refresh_failed" | "fetch_failed" | "no_active_season";
}> {
  const { guildId, requestedBy } = ctx;
  await ensureImportDiagnosticTables();

  const [season] = await db.select({ id: seasonsTable.id, currentWeek: seasonsTable.currentWeek })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  if (!season) return { ok: false, error: "no_active_season" };

  // Clear the previous isolated diagnostic review for this guild before creating a new one.
  await db.execute(sql`delete from mca_import_diagnostic_runs where guild_id = ${guildId}`);

  const currentWeekNum = weekStringToNum(season.currentWeek);
  const weekType: "reg" = "reg";
  const weekIndex = currentWeekNum - 1;
  const wkLabel = getWeekLabel(weekType, currentWeekNum);

  const inserted = await db.execute(sql`
    insert into mca_import_diagnostic_runs (guild_id, season_id, requested_by, week_num, week_type, dry_run, status)
    values (${guildId}, ${season.id}, ${requestedBy}, ${currentWeekNum}, ${weekType}, true, 'running')
    returning id
  `);
  const runId = Number((((inserted as any).rows ?? inserted)[0] as any)?.id);

  const conn = await loadEAConnection(guildId);
  if (!conn) {
    await db.execute(sql`update mca_import_diagnostic_runs set status='failed', warnings=${JSON.stringify(["No EA connection found"])}::jsonb, completed_at=now() where id=${runId}`);
    return { ok: false, runId, weekLabel: wkLabel, error: "no_connection" };
  }

  let { token, eaLeagueId } = conn;
  let blazeSession: BlazeSession;
  try {
    const refreshed = await refreshTokenIfNeeded(token);
    token = refreshed;
    blazeSession = await createBlazeSession(token);
  } catch {
    await db.execute(sql`update mca_import_diagnostic_runs set status='failed', warnings=${JSON.stringify(["Token refresh or Blaze session creation failed"])}::jsonb, completed_at=now() where id=${runId}`);
    return { ok: false, runId, weekLabel: wkLabel, error: "token_refresh_failed" };
  }

  try {
    const stats = await fetchWeeklyStats(token, eaLeagueId, weekIndex, 1, blazeSession);
    const rosterData = await fetchLeagueTeamsAndRosters(token, eaLeagueId, blazeSession).catch(() => null);
    const newsData = await fetchNewsData(token, eaLeagueId, blazeSession).catch(() => null);
    const scheduleData = await fetchAllWeekSchedules(token, eaLeagueId, currentWeekNum, 1, currentWeekNum, blazeSession).catch(() => null);

    const payloads: DiagnosticPayloadSummary[] = [];
    for (const [label, payload] of [
      ["passing", stats.passing],
      ["rushing", stats.rushing],
      ["receiving", stats.receiving],
      ["defense", stats.defense],
      ["kicking", stats.kicking],
      ["punting", stats.punting],
      ["kickReturn", stats.kickReturn],
      ["puntReturn", stats.puntReturn],
      ["teamStats", stats.teamStats],
      ["standings", (stats as any).standings],
      ["schedules", stats.schedules],
      ["leagueTeams", rosterData?.leagueTeams],
      ["teamRosters", rosterData?.teamRosters],
      ["freeAgents", rosterData?.freeAgents],
      ["news", newsData],
      ["scheduleOnlyWeekResults", scheduleData?.weekResults],
    ] as const) {
      payloads.push(summarizeDiagnosticPayload(label, payload));
    }

    const warnings = payloads.flatMap(p => p.warnings.map(w => `${p.label}: ${w}`));

    for (const payload of payloads) {
      await db.execute(sql`
        insert into mca_import_diagnostic_payloads (
          run_id, guild_id, season_id, payload_label, payload_kind, item_count,
          top_level_keys, nested_keys, sample_json, warnings
        ) values (
          ${runId}, ${guildId}, ${season.id}, ${payload.label}, ${payload.kind}, ${payload.itemCount},
          ${JSON.stringify(payload.topLevelKeys)}::jsonb,
          ${JSON.stringify(payload.nestedKeys)}::jsonb,
          ${JSON.stringify(payload.sample)}::jsonb,
          ${JSON.stringify(payload.warnings)}::jsonb
        )
      `);
    }

    const teamList = (((rosterData?.leagueTeams as any)?.leagueTeamInfoList ?? []) as Array<{ teamId?: number }>)
      .map((team, listIndex) => ({ teamId: Number(team.teamId ?? 0), listIndex }))
      .filter(t => Number.isFinite(t.teamId) && t.teamId > 0)
      .slice(0, 3);

    const endpointProbes = await probeMcaExportEndpoints(token, eaLeagueId, weekIndex, 1, blazeSession, teamList)
      .catch((err) => {
        warnings.push(`endpointDiscovery: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      });

    const capEndpointHits: string[] = [];
    let availableEndpointCount = 0;

    for (const probe of endpointProbes) {
      const summary = summarizeProbePayload(probe.payload);
      const capHits = extractCapHits(summary.nestedKeys);
      const capScore = capHits.length;

      if (probe.available) availableEndpointCount += 1;
      if (capScore > 0) capEndpointHits.push(`${probe.endpointName} (${capScore})`);

      await db.execute(sql`
        insert into mca_endpoint_probe_results (
          run_id, guild_id, season_id, endpoint_label, endpoint_name, request_body,
          available, payload_kind, item_count, top_level_keys, nested_keys,
          cap_score, cap_key_hits, sample_json, error_message
        ) values (
          ${runId}, ${guildId}, ${season.id}, ${probe.label}, ${probe.endpointName},
          ${JSON.stringify(probe.requestBody)}::jsonb,
          ${probe.available}, ${summary.kind}, ${summary.itemCount},
          ${JSON.stringify(summary.topLevelKeys)}::jsonb,
          ${JSON.stringify(summary.nestedKeys)}::jsonb,
          ${capScore},
          ${JSON.stringify(capHits)}::jsonb,
          ${JSON.stringify(summary.sample)}::jsonb,
          ${probe.errorMessage ?? null}
        )
      `);
    }

    await db.execute(sql`
      update mca_import_diagnostic_runs
      set status='complete',
          summary=${JSON.stringify({
            payloadCount: payloads.length,
            endpointProbeCount: endpointProbes.length,
            availableEndpointCount,
            capEndpointHits: capEndpointHits.slice(0, 20),
            weekLabel: wkLabel,
            dryRun: true,
            leagueDataWrites: 0,
            payoutsTriggered: false,
            endpointDiscovery: true,
          })}::jsonb,
          warnings=${JSON.stringify(warnings)}::jsonb,
          completed_at=now()
      where id=${runId}
    `);

    return {
      ok: true,
      runId,
      weekLabel: wkLabel,
      payloads,
      endpointProbeCount: endpointProbes.length,
      availableEndpointCount,
      capEndpointHits: capEndpointHits.slice(0, 20),
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      update mca_import_diagnostic_runs
      set status='failed', warnings=${JSON.stringify([message])}::jsonb, completed_at=now()
      where id=${runId}
    `);
    return { ok: false, runId, weekLabel: wkLabel, error: "fetch_failed", warnings: [message] };
  }
}
