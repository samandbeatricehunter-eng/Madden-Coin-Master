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
  globalUserRecordsTable,
  usersTable,
  franchiseRostersTable,
  franchiseMcaTeamsTable,
  teamSeasonStatsTable,
  legendsTable,
  inventoryTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, ne, inArray } from "drizzle-orm";

import {
  EA_LOGIN_URL,
  exchangeCodeForToken,
  detectPersonas,
  getPersonaScopedTokens,
  getLeaguesFromToken,
  saveEAConnection,
  loadEAConnection,
  fetchWeeklyStats,
  fetchNewsData,
  fetchLeagueTeamsAndRosters,
  fetchAllWeekSchedules,
  updateStoredToken,
  refreshTokenIfNeeded,
  type EALeague,
  type TokenInfo,
} from "./ea-client.js";

import { isAdminUser, getGuildChannel, CHANNEL_KEYS } from "./db-helpers.js";

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

  const currentWeekNum = season ? (parseInt(season.currentWeek ?? "1", 10) || 1) : 1;
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

    const currentWeekNum = season ? (parseInt(season.currentWeek ?? "1", 10) || 1) : 1;
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
  const domain = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim() ?? "";
  if (!domain) throw new Error("REPLIT_DOMAINS is not set — cannot reach API server");
  return `https://${domain}/api`;
}

function getWebhookKey(): string {
  const key = process.env["MADDEN_WEBHOOK_KEY"];
  if (!key) throw new Error("MADDEN_WEBHOOK_KEY is not set");
  return key;
}

async function postToApi(url: string, payload: unknown): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await axios.post(url, payload, {
      headers:        { "Content-Type": "application/json" },
      timeout:        30_000,
      validateStatus: () => true,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err: any) {
    console.error("[ld/postToApi]", err?.message);
    return { ok: false, status: 0 };
  }
}

async function runRosterSync(token: TokenInfo, eaLeagueId: number, guild?: Guild | null, guildId?: string): Promise<{ summaryLine: string; allOk: boolean }> {
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
    rosterData = await fetchLeagueTeamsAndRosters(token, eaLeagueId);
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

  const { token, eaLeagueId } = conn;
  // Playoffs (weeks 19/20/21/23) use stageIndex=1 (same as regular season), weekIndex = weekNum - 1.
  // Wild Card (wk 19) → index 18 | Divisional (wk 20) → index 19 | Conf Champ (wk 21) → index 20 | Super Bowl (wk 23) → index 22
  const stageIndex = weekType === "pre" ? 0 : 1;
  const weekIndex  = weekNum - 1;
  const wkLabel    = getWeekLabel(weekType, weekNum);

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Fetching **${wkLabel}** stats from EA…`)],
    components: [],
  });

  let stats: Awaited<ReturnType<typeof fetchWeeklyStats>>;
  try {
    stats = await fetchWeeklyStats(token, eaLeagueId, weekIndex, stageIndex);
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) await updateStoredToken(eaLeagueId, refreshed);
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
    await runRosterSync(token, eaLeagueId, guild, guildId);

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

  const schedulesUrl = skipPayouts
    ? `${weekBase}/schedules${guildQs}&skipPayouts=1`
    : `${weekBase}/schedules${guildQs}`;
  const schedRes = await postToApi(schedulesUrl, stats.schedules);
  results.push({ name: "schedules", ...schedRes });

  try {
    const newsData = await fetchNewsData(token, eaLeagueId);
    if (newsData != null) {
      const newsRes = await postToApi(`${leagueBase}/news${guildQs}`, newsData);
      results.push({ name: "in-game news", ...newsRes });
    }
  } catch { /* non-fatal */ }

  // ── Full season schedule sync (all 18 weeks) ─────────────────────────────────
  // Each week import only fetches the current week's schedule data. Fetch all
  // 18 weeks using a single Blaze session and store them idempotently so the
  // /schedule button can show the full season immediately.
  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Syncing full season schedule (all ${weekType === "pre" ? "preseason" : "18"} weeks)…`)],
    components: [],
  });

  let schedulesSynced = 0;
  if (weekType !== "pre") {
    try {
      const { weekResults: allWeekSchedules } = await fetchAllWeekSchedules(token, eaLeagueId);
      for (const { weekNum: wk, data } of allWeekSchedules) {
        const url = `${leagueBase}/week/reg/${wk}/schedule-import${guildQs}`;
        const r = await postToApi(url, data);
        if (r.ok) schedulesSynced++;
      }
    } catch (err) {
      console.warn("[ld/import] Full schedule sync failed (non-fatal):", err);
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
      { name: "📅 Season Schedule",      value: weekType === "pre" ? "⏭ Skipped (preseason)" : schedulesSynced > 0 ? `✅ ${schedulesSynced}/18 weeks stored` : "⚠️ Schedule sync failed (non-fatal)" },
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
