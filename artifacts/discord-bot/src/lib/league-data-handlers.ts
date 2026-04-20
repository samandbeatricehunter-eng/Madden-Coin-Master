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
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

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
  updateStoredToken,
  refreshTokenIfNeeded,
  type EALeague,
  type TokenInfo,
} from "./ea-client.js";

import { isAdminUser } from "./db-helpers.js";

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

  return { embeds: [embed], components: [row] };
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

// ── Connected status + week select ─────────────────────────────────────────────
async function buildWeekSelectContent(guildId: string, connInfo?: { leagueName: string; eaLeagueId: number; platform: string }) {
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

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(connInfo ? "✅ Connected! Select Week to Import" : "📥 Select Week to Import")
    .setDescription(
      (connInfo
        ? `**League:** ${connInfo.leagueName} · **Platform:** ${connInfo.platform.toUpperCase()}\n\n`
        : "") +
      (!hasOptions
        ? "⚠️ No weeks available yet. Make sure the season is active."
        : `Select a week to import from EA.\n\n` +
          `Current week: **${currentWeekNum <= 18 ? `Week ${currentWeekNum}` : (PLAYOFF_ROUNDS.find(r => r.weekNum === currentWeekNum)?.label ?? `Week ${currentWeekNum}`)}**\n` +
          `Available: Weeks 1–${Math.min(maxWeek, 18)}` +
          (maxWeek >= 19 ? ` + ${PLAYOFF_ROUNDS.filter(r => r.weekNum <= maxWeek).map(r => r.label.replace("🏆 ", "")).join(", ")}` : "")),
    )
    .setFooter({ text: connInfo ? `League ID: ${connInfo.eaLeagueId}` : (conn ? `League ID: ${conn.eaLeagueId}` : "No connection") });

  if (!hasOptions) {
    return { embeds: [embed], components: [cancelRow()] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ld_select_week")
    .setPlaceholder("Select a week or playoff round to import…")
    .addOptions(options);

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const proceedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_proceed:0")
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

// ── Clear season data warning ──────────────────────────────────────────────────
function buildClearWarningContent() {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Clear All Season Data — Confirm?")
    .setDescription(
      "This will permanently wipe the following for the **active season**:\n\n" +
      "• All **W/L records** and **point differential** for every team\n" +
      "• All **game log entries** (win/loss history)\n" +
      "• All **player stats** (all stat categories, all weeks)\n" +
      "• All **game scores** from the schedule (matchups are kept)\n" +
      "• The **week-processed tracker** (so all weeks can be reimported)\n\n" +
      "**After clearing**, use **Import Data Only** to reimport each week from EA. " +
      "No payouts will be triggered by the reimport.\n\n" +
      "**This cannot be undone.**",
    )
    .setFooter({ text: "Global all-time records are NOT cleared — only this season's data" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_clear_confirm")
      .setLabel("✅ Yes, Clear Everything")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("✕ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
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

  const [action, param] = interaction.customId.split(":");
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

  // ── Import Only: skip to week select ──────────────────────────────────────
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
    const content = await buildWeekSelectContent(guildId);
    await interaction.update(content as any);
    return;
  }

  // ── Clear: show warning ────────────────────────────────────────────────────
  if (action === "ld_clear_data") {
    await interaction.update(buildClearWarningContent() as any);
    return;
  }

  // ── Clear: confirm and execute ─────────────────────────────────────────────
  if (action === "ld_clear_confirm") {
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
      embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription("⏳ Clearing season data…")],
      components: [],
    });

    try {
      const [urDel, glDel, psDel, pwpDel, spvDel] = await Promise.all([
        db.delete(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id)),
        db.delete(gameLogTable).where(eq(gameLogTable.seasonId, season.id)),
        db.delete(playerSeasonStatsTable).where(eq(playerSeasonStatsTable.seasonId, season.id)),
        db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
        db.delete(statPaddingViolationsTable).where(eq(statPaddingViolationsTable.seasonId, season.id)),
      ]);

      // Clear scores from schedule (keep matchup structure)
      const schedResult = await db.execute(
        sql`UPDATE franchise_schedule SET home_score = NULL, away_score = NULL WHERE season_id = ${season.id}`,
      );

      // Rebuild global_user_records (now that this season's user_records are gone)
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

      const scoreCount = (schedResult as any).rowCount ?? "?";

      const embed = new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Season Data Cleared")
        .setDescription(
          `**Season ${season.seasonNumber}** data has been wiped:\n\n` +
          `• W/L records: **${(urDel as any).rowCount ?? 0}** rows deleted\n` +
          `• Game logs: **${(glDel as any).rowCount ?? 0}** entries deleted\n` +
          `• Player stats: **${(psDel as any).rowCount ?? 0}** stat rows deleted\n` +
          `• Week-processed tracker: **${(pwpDel as any).rowCount ?? 0}** rows deleted\n` +
          `• Stat padding flags: **${(spvDel as any).rowCount ?? 0}** rows deleted\n` +
          `• Schedule scores cleared: **${scoreCount}** games reset to no-score\n\n` +
          "Use **Import Data Only** to reimport each week from EA.\n" +
          "Global all-time records have been recalculated.",
        )
        .setFooter({ text: "No payouts were triggered" })
        .setTimestamp();

      const returnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ld_cancel_to_main")
          .setLabel("← Back to Menu")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({ embeds: [embed], components: [returnRow] });
    } catch (err: any) {
      console.error("[ld_clear_confirm]", err);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setDescription(`❌ Error during clear: ${err?.message ?? String(err)}`),
        ],
        components: [cancelRow()],
      });
    }
    return;
  }

  // ── Proceed with import ────────────────────────────────────────────────────
  if (action === "ld_proceed") {
    const parts = (param ?? "").split("_"); // format: "reg_3" or "pre_3"
    const weekType = (parts[0] ?? "reg") as "reg" | "pre";
    const weekNum  = parseInt(parts[1] ?? "0", 10);

    if (!weekNum || weekNum < 1) {
      await interaction.reply({ content: "❌ Invalid week selection.", ephemeral: true });
      return;
    }

    await interaction.deferUpdate();

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setDescription(`⏳ Importing **${weekType === "pre" ? "Preseason" : "Regular Season"} Week ${weekNum}** from EA…`),
      ],
      components: [],
    });

    try {
      await runWeekImport({
        guildId,
        weekNum,
        weekType,
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

  const [action] = interaction.customId.split(":");
  const guildId  = interaction.guildId!;
  const userId   = interaction.user.id;
  const value    = interaction.values[0] ?? "";

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
    const maxWeek = currentWeekNum; // include current week and all previous weeks

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("📥 Select Week to Import")
      .setDescription(
        `**Selected: ${chosen}**\n\n` +
        (conn
          ? `League: **${conn.leagueName}** · Platform: **${conn.token.platform.toUpperCase()}**\n\n`
          : "") +
        `Click **Proceed with Import** to start, or pick a different week from the dropdown.`,
      )
      .setFooter({ text: conn ? `League ID: ${conn.eaLeagueId}` : "No connection info" });

    // Rebuild the dropdown with the same options as the initial view, marking selected
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
        .setCustomId("ld_select_week")
        .setPlaceholder(chosen)
        .addOptions(options),
    );

    const proceedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ld_proceed:${stageKey}_${weekNum}`)
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

async function runRosterSync(token: TokenInfo, eaLeagueId: number, guild?: Guild | null): Promise<{ summaryLine: string; allOk: boolean }> {
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const platform   = token.platform;
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

  const teamsRes = await postToApi(`${leagueBase}/leagueteams`, rosterData.leagueTeams);
  results.push({ name: "leagueTeams", ...teamsRes });

  for (const { teamId, data } of rosterData.teamRosters) {
    const res = await postToApi(`${leagueBase}/team/${teamId}/roster`, data);
    results.push({ name: `roster:${teamId}`, ...res });
  }

  const faRes = await postToApi(`${leagueBase}/freeagents/roster`, rosterData.freeAgents);
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
  guildId:   string;
  weekNum:   number;
  weekType:  "reg" | "pre";
  guild:     Guild | null | undefined;
  editReply: (data: any) => Promise<any>;
}): Promise<void> {
  const { guildId, weekNum, weekType, guild, editReply } = ctx;

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
    await runRosterSync(token, eaLeagueId, guild);

  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const weekBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/week/${weekType}/${weekNum}`;

  await editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setDescription(`⏳ Sending **${wkLabel}** stats to processor…`)],
    components: [],
  });

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
    const res = await postToApi(`${weekBase}/${urlSuffix}`, payload);
    results.push({ name: statType, ...res });
  }

  const teamRes = await postToApi(`${weekBase}/team`, stats.teamStats);
  results.push({ name: "teamStats", ...teamRes });

  const schedRes = await postToApi(`${weekBase}/schedules`, stats.schedules);
  results.push({ name: "schedules", ...schedRes });

  try {
    const newsData = await fetchNewsData(token, eaLeagueId);
    if (newsData != null) {
      const newsRes = await postToApi(`${apiBase}/madden/${key}/${platform}/${eaLeagueId}/news`, newsData);
      results.push({ name: "in-game news", ...newsRes });
    }
  } catch { /* non-fatal */ }

  const failCount    = results.filter(r => !r.ok && !r.skipped).length;
  const successCount = results.filter(r => r.ok).length;
  const overallOk    = failCount === 0 && rostersAllOk;

  const statsLines = results.map(r =>
    r.skipped ? `⏭ ${r.name}` :
    r.ok      ? `✅ ${r.name}` :
                `❌ ${r.name} (HTTP ${r.status})`,
  );

  const embed = new EmbedBuilder()
    .setColor(overallOk ? Colors.Green : failCount > 0 || !rostersAllOk ? Colors.Yellow : Colors.Red)
    .setTitle(`📥 Import Complete — ${wkLabel}`)
    .addFields(
      { name: "📊 Player & Team Stats", value: statsLines.join("\n") || "none" },
      { name: "🏈 Roster Sync",         value: rosterSummary },
      { name: "Result",                  value: overallOk
        ? "✅ All data imported successfully"
        : `⚠️ ${successCount}/${results.length} stats ok · ${rostersAllOk ? "rosters ok" : "roster errors"}`,
      },
    )
    .setDescription("No payouts were triggered. Run **Repair User Records** from `/admin-troubleshoot` if W/L counts look off.")
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
    .setTimestamp();

  const returnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ld_cancel_to_main")
      .setLabel("← Back to Menu")
      .setStyle(ButtonStyle.Secondary),
  );

  await editReply({ embeds: [embed], components: [returnRow] });
}
