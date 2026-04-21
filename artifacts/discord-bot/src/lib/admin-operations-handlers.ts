/**
 * /admin-operations hub — admin-facing interactions with prefix ao_
 * Session TTL: 15 minutes (keyed by `${guildId}:${userId}`)
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, TextChannel, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, ComponentType,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonsTable, franchiseScheduleTable, usersTable, gameChannelsTable,
  gotwHistoryTable, franchiseMcaTeamsTable, leagueTwitterTable,
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  gameLogTable, userRecordsTable, statPaddingViolationsTable,
  defaultTeamLogosTable,
  serverSettingsTable, franchiseRostersTable, inventoryTable, legendsTable, customPlayersTable,
} from "@workspace/db";
import { eq, and, sql, ne } from "drizzle-orm";
import {
  getOrCreateActiveSeason, addBalance, logTransaction,
  getGuildChannel, CHANNEL_KEYS,
  getOrSeedRules, setRules, getAllSections,
} from "./db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "./week-helpers.js";
import { generateFranchiseArticle, generateWeekPreview } from "./franchise-article.js";
import { runWildcardAutomation, runOffseasonHistoricalPost } from "./wildcard-automation.js";
import { runEosAutoPost } from "./eos-auto-post.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";
import { sendArticleChunked } from "./send-article.js";
import { runWeeklyMatchupsFlow } from "./weekly-matchups-runner.js";
import { postFullSeasonScheduleToChannel } from "./season-schedule-post.js";
import { PLAYOFF_WEEK_META, runPlayoffMatchupsFlow, payoutPlayoffRoundResults } from "./playoff-matchups-runner.js";
import { autoPayoutPlayoffGotw, purgeChannel } from "./gotw-helpers.js";
import { triggerWeekAdvanceTweets } from "./league-twitter.js";
import { checkAndNotifyWaitlist } from "../commands/waitlist.js";
import { buildMatchupBanner, resolveLogoBuf } from "./matchup-image.js";
import { generateMatchupBreakdown } from "./matchup-ai-breakdown.js";
import { globalLogoPath } from "./gcs-reader.js";
import { buildAdminOpsEmbed, buildAdminOpsRows } from "../commands/admin-operations.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type AnyInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

interface AoSession {
  guildId: string;
  userId: string;
  rulesSection?: string;
  expiresAt: number;
}

// ── Session management ─────────────────────────────────────────────────────────

const aoSessions = new Map<string, AoSession>();
const AO_SESSION_TTL = 15 * 60 * 1000;

function getAoSession(guildId: string, userId: string): AoSession {
  const key = `${guildId}:${userId}`;
  let sess = aoSessions.get(key);
  if (!sess || sess.expiresAt < Date.now()) {
    sess = { guildId, userId, expiresAt: Date.now() + AO_SESSION_TTL };
    aoSessions.set(key, sess);
  }
  sess.expiresAt = Date.now() + AO_SESSION_TTL;
  return sess;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function buildRulesEmbed(section: string, sectionMeta: { title: string; color: number }, rules: string[]): EmbedBuilder {
  const lines = rules.length > 0
    ? rules.map((r, i) => `**${i + 1}.** ${r}`)
    : ["_No rules in this section yet._"];

  return new EmbedBuilder()
    .setColor(sectionMeta.color)
    .setTitle(sectionMeta.title)
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: `Section: ${section} · ${rules.length} rule${rules.length !== 1 ? "s" : ""}` });
}

function buildRulesButtons(rulesCount: number): ActionRowBuilder<ButtonBuilder>[] {
  const editDisabled  = rulesCount === 0;
  const deleteDisabled = rulesCount === 0;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules_add").setLabel("➕ Add Rule").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_rules_edit").setLabel("✏️ Edit Rule").setStyle(ButtonStyle.Primary).setDisabled(editDisabled),
    new ButtonBuilder().setCustomId("ao_rules_delete").setLabel("🗑️ Delete Rule").setStyle(ButtonStyle.Danger).setDisabled(deleteDisabled),
    new ButtonBuilder().setCustomId("ao_rules_back_sections").setLabel("← Sections").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

export async function handleAdminOperationsInteraction(interaction: AnyInteraction): Promise<boolean> {
  const id      = interaction.customId;
  const guildId = interaction.guildId!;
  const userId  = interaction.user.id;
  const sess    = getAoSession(guildId, userId);

  // ── Hub close ────────────────────────────────────────────────────────────────
  if (id === "ao_hub_close") {
    await (interaction as ButtonInteraction).update({
      embeds: [new EmbedBuilder().setColor(Colors.DarkGrey).setDescription("✖ Hub closed.")],
      components: [],
    });
    return true;
  }

  // ── Back to hub main screen ─────────────────────────────────────────────────
  if (id === "ao_hub_back") {
    await (interaction as ButtonInteraction).update({
      embeds: [buildAdminOpsEmbed()],
      components: buildAdminOpsRows(),
    });
    return true;
  }

  // ── Set Week ─────────────────────────────────────────────────────────────────
  if (id === "ao_set_week") {
    await handleSetWeek(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_setwk_sel") {
    await handleSetWeekSelect(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  // ── Advance Week ─────────────────────────────────────────────────────────────
  if (id === "ao_advance_week") {
    await handleAdvanceWeek(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_advance_confirm") {
    await handleAdvanceConfirm(interaction as ButtonInteraction);
    return true;
  }

  // ── Set Season Number ─────────────────────────────────────────────────────────
  if (id === "ao_set_season_num") {
    await handleSetSeasonNum(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_set_season_num_sel") {
    await handleSetSeasonNumSel(interaction as StringSelectMenuInteraction);
    return true;
  }

  if (id.startsWith("ao_set_season_num_confirm:")) {
    await handleSetSeasonNumConfirm(interaction as ButtonInteraction);
    return true;
  }

  // ── Rules ────────────────────────────────────────────────────────────────────
  if (id === "ao_rules") {
    await handleRulesHub(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_section") {
    await handleRulesSection(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  if (id === "ao_rules_back_sections") {
    await handleRulesHub(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_add") {
    await handleRulesAdd(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_edit") {
    await handleRulesEdit(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_edit_sel") {
    await handleRulesEditSel(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  if (id === "ao_rules_delete") {
    await handleRulesDelete(interaction as ButtonInteraction, sess);
    return true;
  }

  // Modal submits
  if (id === "ao_modal_rules_add") {
    await handleModalRulesAdd(interaction as ModalSubmitInteraction, sess);
    return true;
  }

  if (id === "ao_modal_rules_edit") {
    await handleModalRulesEdit(interaction as ModalSubmitInteraction, sess);
    return true;
  }

  if (id === "ao_modal_rules_delete") {
    await handleModalRulesDelete(interaction as ModalSubmitInteraction, sess);
    return true;
  }

  return false;
}

// ── Set Week ───────────────────────────────────────────────────────────────────

async function handleSetWeek(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const current = season.currentWeek ?? "1";

  const weekOptions = WEEK_SEQUENCE.map(w => ({
    label: weekLabel(w),
    value: w,
    default: w === current,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_setwk_sel")
    .setPlaceholder(`Current: ${weekLabel(current)}`)
    .addOptions(weekOptions.map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(o.label)
        .setValue(o.value)
        .setDefault(o.default),
    ));

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📅 Set Week")
        .setDescription(
          `Current week: **${weekLabel(current)}**\n\n` +
          "Select a week to set. **No auto-actions will run** — channels, GOTW, and articles are NOT triggered.\n" +
          "Use **⏩ Advance Week** if you want all auto-actions."
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>, backRow],
  });
}

async function handleSetWeekSelect(interaction: StringSelectMenuInteraction, _sess: AoSession) {
  const guildId = interaction.guildId!;
  const newWeek = interaction.values[0]!;
  const season  = await getOrCreateActiveSeason(guildId);
  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📅 Week Updated")
    .setDescription(
      `Week changed from **${oldLabel}** → **${newLabel}**.\n\n` +
      "No auto-actions were triggered. Use **⏩ Advance Week** for full auto-processing."
    )
    .setTimestamp();

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({ embeds: [embed], components: [backRow] });
}

// ── Advance Week ───────────────────────────────────────────────────────────────

async function handleAdvanceWeek(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const current = season.currentWeek ?? "1";

  const currentIdx = WEEK_SEQUENCE.indexOf(current);
  const nextIdx    = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1);
  const nextWeek   = WEEK_SEQUENCE[nextIdx]!;

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_advance_confirm").setLabel("✅ Confirm Advance").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("✖ Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⏩ Advance Week — Confirm")
        .setDescription(
          `**Current week:** ${weekLabel(current)}\n` +
          `**Next week:** **${weekLabel(nextWeek)}**\n\n` +
          "This will run **all auto-actions**:\n" +
          "• Create matchup channels for H2H games\n" +
          "• Award GOTW participation bonuses\n" +
          "• Process playoff payouts (if applicable)\n" +
          "• Post AI franchise articles\n" +
          "• Trigger League Twitter burst\n" +
          "• And more...\n\n" +
          "**Are you sure?**"
        ),
    ],
    components: [confirmRow],
  });
}

async function handleAdvanceConfirm(interaction: ButtonInteraction) {
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⏩ Advancing Week...")
        .setDescription("Please wait — running all auto-actions..."),
    ],
    components: [],
  });

  try {
    await performAdvanceWeek(interaction);
  } catch (err) {
    console.error("[admin-operations] Advance week error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Advance Week Failed")
          .setDescription(`An error occurred: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ── Advance Week — Core Logic (adapted from advanceweek.ts) ───────────────────

function toChannelName(teamName: string): string {
  return teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");
}

async function performAdvanceWeek(interaction: ButtonInteraction): Promise<void> {
  const guildId    = interaction.guildId!;
  const season     = await getOrCreateActiveSeason(guildId);

  const announceChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.ANNOUNCEMENTS);
  const offseasonWipeIds  = (await Promise.all([
    getGuildChannel(guildId, CHANNEL_KEYS.PAYOUTS),
    getGuildChannel(guildId, CHANNEL_KEYS.HIGHLIGHTS),
    getGuildChannel(guildId, CHANNEL_KEYS.STREAM),
    getGuildChannel(guildId, CHANNEL_KEYS.HEADLINES),
    getGuildChannel(guildId, CHANNEL_KEYS.MATCHUPS),
    getGuildChannel(guildId, CHANNEL_KEYS.SCHEDULE),
    getGuildChannel(guildId, CHANNEL_KEYS.ANNOUNCEMENTS),
    getGuildChannel(guildId, CHANNEL_KEYS.LEAGUE_TWITTER),
  ])).filter((id): id is string => !!id);

  const currentIdx    = WEEK_SEQUENCE.indexOf(season.currentWeek ?? "1");
  const wouldClamp    = currentIdx !== -1 && currentIdx + 1 >= WEEK_SEQUENCE.length;
  const isTrainingEnd = season.currentWeek === "training_camp" && wouldClamp;

  // ── Auto-rollover: Training Camp → Week 1 of next season ─────────────────────
  let autoRolloverNote = "";
  if (isTrainingEnd) {
    const maxSeasons   = await getMaxSeasons(guildId);
    const nextNumber   = (season.seasonNumber ?? 0) + 1;

    if (nextNumber > maxSeasons) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("🏁 Franchise Complete")
            .setDescription(
              `This franchise has reached its **${maxSeasons}-season limit**.\n\n` +
              `Season ${season.seasonNumber} is the final season — you cannot advance past it.\n\n` +
              `• Use **🔢 Set Season Number** to re-activate any previous season.\n` +
              `• Or increase the franchise length via \`/admin-initialize\`.`
            ),
        ],
        components: buildAdminOpsRows(),
      });
      return;
    }

    // Rollover current-season legends → permanent (4-cap per user)
    const PERMANENT_CAP = 4;
    const currentLegends = await db.select().from(inventoryTable)
      .where(and(
        eq(inventoryTable.seasonId, season.id),
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'current'`,
      ));
    let legendsPromoted = 0, legendsReturned = 0;
    const byUser: Record<string, typeof currentLegends> = {};
    for (const item of currentLegends) {
      if (!byUser[item.discordId]) byUser[item.discordId] = [];
      byUser[item.discordId]!.push(item);
    }
    for (const [userId, legends] of Object.entries(byUser)) {
      const [userRow] = await db.select({ team: usersTable.team }).from(usersTable)
        .where(and(eq(usersTable.discordId, userId), eq(usersTable.guildId, guildId))).limit(1);
      const teamName = userRow?.team ?? null;
      const [countRow] = await db.select({ c: sql<string>`count(*)` }).from(inventoryTable)
        .where(and(
          eq(inventoryTable.discordId, userId),
          eq(inventoryTable.itemType, "legend"),
          sql`${inventoryTable.legendCategory} = 'permanent'`,
        ));
      const existing  = parseInt(countRow?.c ?? "0", 10);
      const slotsLeft = Math.max(0, PERMANENT_CAP - existing);
      const toPromote = legends.slice(0, slotsLeft);
      const toReturn  = legends.slice(slotsLeft);
      for (const item of toPromote) {
        await db.update(inventoryTable)
          .set({ legendCategory: "permanent", ...(teamName ? { team: teamName } : {}) })
          .where(eq(inventoryTable.id, item.id));
        legendsPromoted++;
      }
      for (const item of toReturn) {
        if (item.legendId) {
          await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, item.legendId));
        }
        await db.delete(inventoryTable).where(eq(inventoryTable.id, item.id));
        await db.update(usersTable)
          .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, userId));
        legendsReturned++;
      }
    }

    // Rollover active custom players → permanent inventory
    const activeCustomPlayers = await db.select().from(customPlayersTable)
      .where(and(eq(customPlayersTable.seasonId, season.id), ne(customPlayersTable.status, "refunded")));
    let customPlayersRolled = 0;
    const tierToItemType = (tier: string): "custom_player_gold" | "custom_player_silver" | "custom_player_bronze" =>
      tier === "gold" ? "custom_player_gold" : tier === "silver" ? "custom_player_silver" : "custom_player_bronze";
    for (const cp of activeCustomPlayers) {
      const [existingCp] = await db.select({ id: inventoryTable.id }).from(inventoryTable)
        .where(and(
          eq(inventoryTable.discordId, cp.discordId),
          eq(inventoryTable.seasonId, season.id),
          eq(inventoryTable.itemType, tierToItemType(cp.packageTier)),
          sql`${inventoryTable.playerName} = ${`${cp.firstName} ${cp.lastName}`}`,
          sql`${inventoryTable.legendCategory} = 'permanent'`,
        )).limit(1);
      if (existingCp) continue;
      const [cpUser] = await db.select({ team: usersTable.team }).from(usersTable)
        .where(and(eq(usersTable.discordId, cp.discordId), eq(usersTable.guildId, guildId))).limit(1);
      await db.insert(inventoryTable).values({
        discordId:      cp.discordId,
        seasonId:       season.id,
        purchaseId:     0,
        itemType:       tierToItemType(cp.packageTier),
        playerName:     `${cp.firstName} ${cp.lastName}`,
        playerPosition: cp.position,
        legendCategory: "permanent",
        ...(cpUser?.team ? { team: cpUser.team } : {}),
      });
      customPlayersRolled++;
    }

    // Create new season record
    await db.update(seasonsTable).set({ isActive: false });
    const [newSeasonRecord] = await db.insert(seasonsTable)
      .values({ seasonNumber: nextNumber, isActive: true })
      .returning();

    // Carry forward MCA teams + rosters
    const prevTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    let carryTeams = 0, carryRosters = 0;
    if (newSeasonRecord && prevTeams.length > 0) {
      const teamRows = prevTeams.map(t => ({
        seasonId: newSeasonRecord.id, teamId: t.teamId, fullName: t.fullName,
        nickName: t.nickName, userName: t.userName, isHuman: t.isHuman, discordId: t.discordId,
      }));
      await db.insert(franchiseMcaTeamsTable).values(teamRows).onConflictDoNothing();
      carryTeams = teamRows.length;
      const prevRosters = await db.select().from(franchiseRostersTable)
        .where(eq(franchiseRostersTable.seasonId, season.id));
      if (prevRosters.length > 0) {
        const rosterRows = prevRosters.map(r => ({
          seasonId: newSeasonRecord.id, teamId: r.teamId, teamName: r.teamName,
          discordId: r.discordId, playerId: r.playerId, firstName: r.firstName,
          lastName: r.lastName, position: r.position, overall: r.overall,
          devTrait: r.devTrait, age: r.age, jerseyNum: r.jerseyNum,
          contractYearsLeft: r.contractYearsLeft, attributes: r.attributes,
        }));
        for (let i = 0; i < rosterRows.length; i += 500) {
          await db.insert(franchiseRostersTable).values(rosterRows.slice(i, i + 500)).onConflictDoNothing();
        }
        carryRosters = rosterRows.length;
      }
    }

    const isLastSeason = nextNumber === maxSeasons;
    autoRolloverNote = [
      `🎉 **Season ${nextNumber} of ${maxSeasons} has begun!**` + (isLastSeason ? " ⚠️ This is the final season." : ""),
      `• ${legendsPromoted} legend(s) moved to permanent vaults${legendsReturned > 0 ? `; ${legendsReturned} returned to store (vault full)` : ""}.`,
      customPlayersRolled > 0 ? `• ${customPlayersRolled} custom player(s) rolled over to permanent inventories.` : "",
      carryTeams > 0 ? `• ${carryTeams} team links + ${carryRosters} roster rows carried forward from Season ${season.seasonNumber}.` : "• No roster data to carry forward — MCA import required.",
    ].filter(Boolean).join("\n");
    console.log(`[admin-operations] Auto season rollover: Season ${season.seasonNumber} → ${nextNumber} (guildId=${guildId})`);

    // The new active record is newSeasonRecord — we advance week on IT, not season
    // Override season reference for the week update below
    Object.assign(season, { id: newSeasonRecord!.id, seasonNumber: nextNumber });
  }

  const nextIdx = isTrainingEnd ? 0 : (currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1));
  const newWeek = WEEK_SEQUENCE[nextIdx]!;

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  const channelLines: string[] = [];

  // ── Wipe preseason stats when advancing from Training Camp → Week 1 ─────────
  let preseasonWipeNote = "";
  if (season.currentWeek === "training_camp" && newWeek === "1") {
    try {
      await Promise.all([
        db.delete(playerSeasonStatsTable)      .where(eq(playerSeasonStatsTable.seasonId,      season.id)),
        db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
        db.delete(gameLogTable)                .where(eq(gameLogTable.seasonId,                 season.id)),
        db.delete(userRecordsTable)            .where(eq(userRecordsTable.seasonId,              season.id)),
        db.delete(statPaddingViolationsTable)  .where(eq(statPaddingViolationsTable.seasonId,   season.id)),
      ]);
      preseasonWipeNote =
        "✅ Preseason stats cleared (player stats, game logs, W/L records, and violation flags have been reset for the regular season).";
      console.log(`[admin-operations] Preseason stats wiped for season ${season.id}`);
    } catch (err) {
      preseasonWipeNote = "⚠️ Preseason stat wipe partially failed — check logs.";
      console.error("[admin-operations] Preseason stat wipe error:", err);
    }
  }

  // ── GOTW bonus + cleanup for the week we're leaving ───────────────────────────
  const oldWeekNum = parseInt(season.currentWeek ?? "1", 10);
  if (!isNaN(oldWeekNum) && oldWeekNum >= 1 && oldWeekNum <= 18) {
    const oldWeekIndex = oldWeekNum - 1;

    try {
      const [gotwRow] = await db.select()
        .from(gotwHistoryTable)
        .where(and(
          eq(gotwHistoryTable.seasonId,  season.id),
          eq(gotwHistoryTable.weekIndex, oldWeekIndex),
        ))
        .limit(1);

      if (gotwRow) {
        const scheduleGames = await db.select()
          .from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  season.id),
            eq(franchiseScheduleTable.weekIndex, oldWeekIndex),
          ));

        const mcaForGotw = await db.select({
          discordId: franchiseMcaTeamsTable.discordId,
          fullName:  franchiseMcaTeamsTable.fullName,
          nickName:  franchiseMcaTeamsTable.nickName,
        })
          .from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

        const gotwNameToId = new Map<string, string>();
        for (const t of mcaForGotw) {
          if (t.discordId) {
            gotwNameToId.set(t.fullName.toLowerCase().trim(), t.discordId);
            gotwNameToId.set(t.nickName.toLowerCase().trim(), t.discordId);
          }
        }

        const gotwGame = scheduleGames.find(g => {
          const awayId = gotwNameToId.get(g.awayTeamName.toLowerCase().trim());
          const homeId = gotwNameToId.get(g.homeTeamName.toLowerCase().trim());
          if (awayId && homeId) {
            return (
              (awayId === gotwRow.discordId1 && homeId === gotwRow.discordId2) ||
              (awayId === gotwRow.discordId2 && homeId === gotwRow.discordId1)
            );
          }
          const away = g.awayTeamName.toLowerCase().trim();
          const home = g.homeTeamName.toLowerCase().trim();
          const t1   = gotwRow.teamName1.toLowerCase().trim();
          const t2   = gotwRow.teamName2.toLowerCase().trim();
          return (
            (away.includes(t1) || t1.includes(away)) && (home.includes(t2) || t2.includes(home)) ||
            (away.includes(t2) || t2.includes(away)) && (home.includes(t1) || t1.includes(home))
          );
        });

        if (gotwGame && gotwGame.status === 3) {
          const GOTW_BONUS = 10;
          await addBalance(gotwRow.discordId1, GOTW_BONUS, guildId);
          await logTransaction(gotwRow.discordId1, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");
          await addBalance(gotwRow.discordId2, GOTW_BONUS, guildId);
          await logTransaction(gotwRow.discordId2, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");

          channelLines.push(
            `🏆 GOTW bonus: **+${GOTW_BONUS} coins** awarded to <@${gotwRow.discordId1}> & <@${gotwRow.discordId2}>`,
          );

          for (const discordId of [gotwRow.discordId1, gotwRow.discordId2]) {
            try {
              const user = await interaction.client.users.fetch(discordId);
              await user.send(
                `🏆 **GOTW Bonus!** You participated in this week's Game of the Week and earned **+${GOTW_BONUS} coins**!`
              ).catch(() => {});
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error("[admin-operations] GOTW bonus error:", err);
    }
  }

  // ── Playoff payouts — fires when leaving a playoff week ──────────────────────
  const leavingPlayoffMeta = PLAYOFF_WEEK_META[season.currentWeek ?? ""];
  if (leavingPlayoffMeta) {
    try {
      const roundPayoutSummary = await payoutPlayoffRoundResults(
        interaction.client,
        season,
        season.currentWeek!,
      );
      if (roundPayoutSummary) channelLines.push(roundPayoutSummary);
    } catch (err) {
      console.error("[admin-operations] Playoff round payout error:", err);
    }

    try {
      const payoutSummary = await autoPayoutPlayoffGotw(
        interaction.client,
        season.id,
        leavingPlayoffMeta.weekIndex,
        season.currentWeek!,
        guildId,
      );
      if (payoutSummary) channelLines.push(payoutSummary);
    } catch (err) {
      console.error("[admin-operations] Playoff GOTW payout error:", err);
    }
  }

  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  // ── Channel lifecycle ──────────────────────────────────────────────────────
  const guild = interaction.guild;

  if (guild) {
    const oldChannels = await db.select()
      .from(gameChannelsTable)
      .where(eq(gameChannelsTable.seasonId, season.id));

    let deleted = 0;
    for (const row of oldChannels) {
      try {
        const ch = guild.channels.cache.get(row.channelId)
          ?? await guild.channels.fetch(row.channelId).catch(() => null);
        if (ch) {
          await ch.delete("Advance week — removing previous week's matchup channels");
          deleted++;
        }
      } catch (_) {}
    }

    if (oldChannels.length > 0) {
      await db.delete(gameChannelsTable)
        .where(eq(gameChannelsTable.seasonId, season.id));
      if (deleted > 0) channelLines.push(`🗑️ Removed **${deleted}** previous matchup channel${deleted !== 1 ? "s" : ""}`);
    }

    const newWeekNum = parseInt(newWeek, 10);
    let channelWeekIndex: number | null = null;
    let channelWeekDisplayLabel = weekLabel(newWeek);

    if (!isNaN(newWeekNum) && newWeekNum >= 1 && newWeekNum <= 18) {
      channelWeekIndex = newWeekNum - 1;
    } else if (PLAYOFF_WEEK_META[newWeek]) {
      channelWeekIndex = PLAYOFF_WEEK_META[newWeek]!.weekIndex;
    }

    if (channelWeekIndex !== null) {
      const weekIndex = channelWeekIndex;

      const games = await db.select()
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ));

      const [mcaTeams, defaultLogos] = await Promise.all([
        db.select({
          fullName:  franchiseMcaTeamsTable.fullName,
          nickName:  franchiseMcaTeamsTable.nickName,
          discordId: franchiseMcaTeamsTable.discordId,
          teamId:    franchiseMcaTeamsTable.teamId,
          logoUrl:   franchiseMcaTeamsTable.logoUrl,
        }).from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id)),
        db.select({
          teamId:   defaultTeamLogosTable.teamId,
          fullName: defaultTeamLogosTable.fullName,
          nickName: defaultTeamLogosTable.nickName,
          logoUrl:  defaultTeamLogosTable.logoUrl,
        }).from(defaultTeamLogosTable),
      ]);

      const defaultById   = new Map<number, string>();
      const defaultByName = new Map<string, string>();
      for (const d of defaultLogos) {
        defaultById.set(d.teamId, d.logoUrl);
        defaultByName.set(d.fullName.toLowerCase().trim(), d.logoUrl);
        defaultByName.set(d.nickName.toLowerCase().trim(), d.logoUrl);
      }

      const teamToDiscord = new Map<string, string>();
      const teamToMca     = new Map<string, typeof mcaTeams[0]>();
      for (const t of mcaTeams) {
        const keys = [
          t.fullName.toLowerCase().trim(),
          t.nickName.toLowerCase().trim(),
          String(t.teamId),
        ];
        for (const key of keys) {
          if (!teamToMca.has(key)) teamToMca.set(key, t);
          if (t.discordId && !teamToDiscord.has(key)) teamToDiscord.set(key, t.discordId);
        }
      }

      const discordIdToMca = new Map<string, typeof mcaTeams[0]>();
      for (const t of mcaTeams) {
        if (t.discordId) discordIdToMca.set(t.discordId, t);
      }

      const allUsers = await db.select({
        discordId: usersTable.discordId,
        team:      usersTable.team,
      }).from(usersTable).where(eq(usersTable.guildId, guildId));
      for (const u of allUsers) {
        if (u.team && !teamToDiscord.has(u.team.toLowerCase().trim())) {
          teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
        }
      }

      const discordIdToProperTeam = new Map<string, string>();
      for (const u of allUsers) {
        if (u.team) discordIdToProperTeam.set(u.discordId, u.team);
      }

      const h2hGames = games.filter(g => {
        const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
        const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
        return awayId && homeId;
      });

      if (h2hGames.length === 0 && games.length > 0) {
        channelLines.push("📭 No H2H matchups found in schedule for this week — no channels created");
      } else if (games.length === 0) {
        channelLines.push("📭 No schedule data found for this week — run `/franchiseupdate` first");
      }

      await guild.channels.fetch();
      const matchupCategory = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes("GAMEDAY"),
      );
      const resolvedCategoryId = matchupCategory?.id ?? null;

      if (!resolvedCategoryId) {
        channelLines.push("⚠️ Could not find a GAMEDAY CENTER category in this server — matchup channels not created.");
      }

      let created = 0;
      for (const g of resolvedCategoryId ? h2hGames : []) {
        const awayDiscordId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim())!;
        const homeDiscordId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim())!;
        const awayProper    = discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName;
        const homeProper    = discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName;
        const chanName      = `${toChannelName(awayProper)}-vs-${toChannelName(homeProper)}`;

        try {
          const newChannel = await guild.channels.create({
            name:   chanName,
            type:   ChannelType.GuildText,
            parent: resolvedCategoryId!,
          });

          await newChannel.lockPermissions();

          await newChannel.send(
            `🏈 **${awayProper} vs ${homeProper}** — ${channelWeekDisplayLabel}\n` +
            `<@${awayDiscordId}> <@${homeDiscordId}>\n` +
            `Good luck this week!`,
          );

          await db.insert(gameChannelsTable).values({
            seasonId:     season.id,
            weekIndex,
            channelId:    newChannel.id,
            awayTeamName: awayProper,
            homeTeamName: homeProper,
          });

          // ── Matchup banner + AI breakdown (fire-and-forget) ───────────────────
          (async () => {
            try {
              const awayMca = teamToMca.get(g.awayTeamName.toLowerCase().trim()) ?? discordIdToMca.get(awayDiscordId);
              const homeMca = teamToMca.get(g.homeTeamName.toLowerCase().trim()) ?? discordIdToMca.get(homeDiscordId);

              function resolveLogoPath(teamName: string, mca: typeof mcaTeams[0] | undefined): string | null {
                const key = teamName.toLowerCase().trim();
                if (mca?.logoUrl) return mca.logoUrl;
                if (mca?.teamId != null) {
                  const byId = defaultById.get(mca.teamId);
                  if (byId) return byId;
                }
                const exact = defaultByName.get(key);
                if (exact) return exact;
                for (const d of defaultLogos) {
                  if (key.includes(d.nickName.toLowerCase().trim())) return d.logoUrl;
                }
                if (mca?.teamId != null && mca.teamId <= 31) return globalLogoPath(mca.teamId);
                return null;
              }

              const awayGcsPath = resolveLogoPath(awayProper, awayMca);
              const homeGcsPath = resolveLogoPath(homeProper, homeMca);

              if (awayGcsPath && homeGcsPath) {
                const [awayBuf, homeBuf] = await Promise.all([
                  resolveLogoBuf(awayGcsPath),
                  resolveLogoBuf(homeGcsPath),
                ]);
                if (awayBuf && homeBuf) {
                  const bannerBuf  = await buildMatchupBanner(awayBuf, homeBuf);
                  const attachment = new AttachmentBuilder(bannerBuf, { name: "matchup-banner.png" });
                  const bannerEmbed = new EmbedBuilder()
                    .setColor(0x7c3aed)
                    .setTitle(`${awayProper} @ ${homeProper}`)
                    .setDescription(`<@${awayDiscordId}> **vs** <@${homeDiscordId}>`)
                    .setImage("attachment://matchup-banner.png")
                    .setFooter({ text: channelWeekDisplayLabel });
                  await newChannel.send({ embeds: [bannerEmbed], files: [attachment] });
                }
              }

              if (awayMca?.teamId && homeMca?.teamId) {
                const breakdownEmbed = await generateMatchupBreakdown({
                  seasonId:       season.id,
                  awayTeamName:   awayProper,
                  homeTeamName:   homeProper,
                  awayTeamId:     awayMca.teamId,
                  homeTeamId:     homeMca.teamId,
                  awayDiscordId,
                  homeDiscordId,
                  awayDiscordTag: `<@${awayDiscordId}>`,
                  homeDiscordTag: `<@${homeDiscordId}>`,
                  weekLabel:      channelWeekDisplayLabel,
                });
                await newChannel.send({ embeds: [breakdownEmbed] });
              }
            } catch (postErr) {
              console.error(`[admin-operations] Failed to post banner/breakdown for ${chanName}:`, postErr);
            }
          })();

          created++;
        } catch (chErr) {
          console.error(`[admin-operations] Failed to create channel for ${chanName}:`, chErr);
          channelLines.push(`⚠️ Could not create channel for **${g.awayTeamName} vs ${g.homeTeamName}**`);
        }
      }

      if (created > 0) {
        channelLines.push(`✅ Created **${created}** matchup channel${created !== 1 ? "s" : ""}${resolvedCategoryId ? `` : ""}`);
      }
    }
  }

  // ── Build reply embed ──────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(autoRolloverNote ? Colors.Gold : Colors.Green)
    .setTitle(autoRolloverNote ? "🎉 Season Rollover — Week 1 Begins!" : "📅 League Week Updated")
    .addFields(
      { name: "Previous Week", value: oldLabel,         inline: true },
      { name: "Current Week",  value: `**${newLabel}**`, inline: true },
    )
    .setTimestamp();

  if (autoRolloverNote) {
    embed.addFields({ name: "🔄 Season Rollover", value: autoRolloverNote });
  }

  if (channelLines.length > 0) {
    embed.addFields({ name: "📺 Matchup Channels", value: channelLines.join("\n") });
  }

  if (preseasonWipeNote) {
    embed.addFields({ name: "🧹 Preseason Data Cleared", value: preseasonWipeNote });
  }

  if (newWeek === "wildcard") {
    embed.addFields({
      name: "⚠️ Wildcard Week — Action Required",
      value: [
        "Before games begin, complete these steps:",
        "**1.** `/admin-playoffs setnfcseeds` — Register NFC seeds 1–7",
        "**2.** `/admin-playoffs setafcseeds` — Register AFC seeds 1–7",
        "**3.** `/admin-playoffs divisionbonus` — Award +25 coins to all 8 division winners",
        "",
        "Seeds 1–4 in each conference earn **+75 coins/playoff win**.",
        "Seeds 5–7 (wildcard entrants) earn **+100 coins/playoff win**.",
        "All playoff losers receive **+50 coins** upon elimination.",
      ].join("\n"),
    });
    embed.setColor(Colors.Yellow);
  }

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  ) as ActionRowBuilder<any>;

  await interaction.editReply({ embeds: [embed], components: [backRow] });

  // ── League Twitter burst ───────────────────────────────────────────────────
  triggerWeekAdvanceTweets(interaction.client, guildId);

  // ── Franchise articles ────────────────────────────────────────────────────
  if (!isNaN(oldWeekNum) && oldWeekNum >= 1 && oldWeekNum <= 18 && newWeek !== "1" && guild) {
    const headlinesChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.HEADLINES);
    const headlinesChannel   = headlinesChannelId
      ? (interaction.client.channels.cache.get(headlinesChannelId) ?? await interaction.client.channels.fetch(headlinesChannelId).catch(() => null))
      : null;

    if (headlinesChannel && headlinesChannel.isTextBased()) {
      (async () => {
        const tc = headlinesChannel as TextChannel;
        const completedWeekIndex = oldWeekNum - 1;

        try {
          const recapArticle = await generateFranchiseArticle(
            season.id,
            season.seasonNumber,
            completedWeekIndex,
            weekLabel(newWeek),
          );
          await sendArticleChunked(
            tc,
            `@everyone\n📰 **REC League — Week ${oldWeekNum} Recap**\n\n`,
            recapArticle,
          );
        } catch (err) {
          console.error("[admin-operations] Failed to generate recap article:", err);
          try {
            await tc.send({
              content: `📰 **REC League — Week ${oldWeekNum} Recap**\n\n_The AI recap could not be generated for this week._`,
            });
          } catch { /* nothing */ }
        }

        const newWeekNum2 = parseInt(newWeek, 10);
        if (!isNaN(newWeekNum2) && newWeekNum2 >= 1 && newWeekNum2 <= 18) {
          try {
            const previewArticle = await generateWeekPreview(
              season.id,
              season.seasonNumber,
              newWeekNum2 - 1,
            );
            await sendArticleChunked(
              tc,
              `@everyone\n📋 **REC League — Week ${newWeekNum2} Preview**\n\n`,
              previewArticle,
            );
          } catch (err) {
            console.error("[admin-operations] Failed to generate preview article:", err);
            try {
              await tc.send({
                content: `📋 **REC League — Week ${newWeekNum2} Preview**\n\n_The AI preview could not be generated for this week._`,
              });
            } catch { /* nothing */ }
          }
        }
      })();
    }
  }

  // ── Wildcard automation ───────────────────────────────────────────────────
  if (newWeek === "wildcard" && season.currentWeek === "18") {
    (async () => {
      try {
        await runWildcardAutomation(interaction.client, season.id, season.seasonNumber, interaction.guild);
      } catch (err) {
        console.error("[admin-operations] Wildcard automation error:", err);
      }
    })();
  }

  // ── EOS payout auto-post ──────────────────────────────────────────────────
  if (newWeek === "wildcard") {
    (async () => {
      try {
        const safeModeActive = (await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE)) > 0;
        if (safeModeActive) {
          await interaction.followUp({
            content: "⚠️ **EOS payouts are blocked** — stat reimport safe mode is currently active. Disable it before advancing to Wildcard week to run EOS payouts.",
            ephemeral: true,
          }).catch(() => {});
          return;
        }
        const result = await runEosAutoPost(interaction.client, season.id);
        const lines = [
          `📋 **End-of-Season Payout Summaries Posted** to the commissioner log.`,
          `• **${result.posted}** user payout${result.posted !== 1 ? "s" : ""} queued for approval`,
        ];
        if (result.skipped > 0) lines.push(`• **${result.skipped}** already had records for this season (skipped)`);
        if (result.errors > 0)  lines.push(`• ⚠️ **${result.errors}** failed — check bot console`);
        lines.push("Use the **Edit Amount** buttons in the commissioner log to adjust before approving.");
        await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      } catch (err) {
        console.error("[admin-operations] EOS auto-post error:", err);
        await interaction.followUp({ content: `⚠️ EOS auto-post failed: ${err}`, ephemeral: true }).catch(() => {});
      }
    })();
  }

  // ── Offseason historical post + channel wipes ─────────────────────────────
  if (newWeek === "offseason") {
    (async () => {
      try {
        await runOffseasonHistoricalPost(interaction.client, season.id, season.seasonNumber);
      } catch (err) {
        console.error("[admin-operations] Offseason historical post error:", err);
      }

      for (const chId of offseasonWipeIds) {
        try {
          const ch = interaction.client.channels.cache.get(chId)
            ?? await interaction.client.channels.fetch(chId).catch(() => null);
          if (ch?.isTextBased()) {
            await purgeChannel(ch as TextChannel).catch(err =>
              console.error(`[admin-operations] Offseason wipe error (${chId}):`, err),
            );
          }
        } catch (err) {
          console.error(`[admin-operations] Could not wipe channel ${chId}:`, err);
        }
      }

      try {
        await db.delete(leagueTwitterTable).where(eq(leagueTwitterTable.seasonId, season.id));
      } catch (err) {
        console.error("[admin-operations] Failed to wipe league twitter DB rows:", err);
      }

      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `📣 **The rule change voting period has begun!**\n\n` +
              `If you are requesting a specific rule change to be voted on by the league, ` +
              `please post it in the **League Announcements** channel immediately to be considered.\n\n` +
              `⚠️ This opportunity **ends once the Draft has begun**. Get your proposals in now!`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] Offseason announcement error:", err);
      }
    })();
  }

  // ── Training Camp announcement ────────────────────────────────────────────
  if (newWeek === "training_camp") {
    (async () => {
      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏕️ **Training Camp has begun!**\n\n` +
              `The offseason is over — it's time to build your roster and get ready for the upcoming season.\n\n` +
              `📋 All attribute upgrades, dev upgrades, and store purchases are now open for the new season.`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] Training Camp announcement error:", err);
      }
    })();
  }

  // ── New season announcement + full schedule ───────────────────────────────
  if (newWeek === "1" && (!season.currentWeek || season.currentWeek === "offseason" || season.currentWeek === "training_camp")) {
    (async () => {
      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏈 **A new season has begun!**\n\n` +
              `We have officially advanced to **Season ${season.seasonNumber}**.\n` +
              `Good luck to everyone this season — let's get to work! 💪`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] New season announcement error:", err);
      }

      try {
        await db.update(usersTable).set({ playoffSeed: null, playoffConference: null });
        console.log("[admin-operations] Cleared playoff seeds for new season");
      } catch (err) {
        console.error("[admin-operations] Failed to clear playoff seeds:", err);
      }

      try {
        const commId = await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTIONS)
          ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
        if (commId) {
          const commCh = interaction.client.channels.cache.get(commId)
            ?? await interaction.client.channels.fetch(commId).catch(() => null);
          if (commCh?.isTextBased()) {
            const messages = await (commCh as TextChannel).messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
              if (!msg.components.length || !msg.editable) continue;
              const NON_REFUNDABLE = new Set(["legend", "custom_player"]);
              let modified = false;
              const newRows: ReturnType<typeof ButtonBuilder.from>[][] = [];
              for (const row of msg.components) {
                if (row.type !== ComponentType.ActionRow) continue;
                const kept: ReturnType<typeof ButtonBuilder.from>[] = [];
                for (const c of (row as any).components ?? []) {
                  if (c.type !== ComponentType.Button) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const cid: string = c.customId ?? "";
                  if (!cid.startsWith("refund_purchase:")) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const purchaseType: string = cid.split(":")[3] ?? "";
                  if (NON_REFUNDABLE.has(purchaseType) || purchaseType.startsWith("custom_player")) {
                    modified = true;
                  } else {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                  }
                }
                if (kept.length > 0) newRows.push(kept);
              }
              if (modified) {
                const actionRows = newRows.map(btns =>
                  new ActionRowBuilder<ButtonBuilder>().addComponents(btns)
                );
                await msg.edit({ components: actionRows }).catch(() => null);
              }
            }
          }
        }
      } catch (err) {
        console.error("[admin-operations] Refund button removal error:", err);
      }

      try {
        const postedWeeks = await postFullSeasonScheduleToChannel(
          interaction.client,
          season.id,
          season.seasonNumber ?? season.id,
          { guildId },
        );
        if (postedWeeks > 0) {
          await interaction.followUp({
            content: `📅 Full Season ${season.seasonNumber} schedule (${postedWeeks} weeks) posted.`,
            ephemeral: true,
          }).catch(() => {});
        } else {
          await interaction.followUp({
            content: `⚠️ Could not auto-post season schedule — no schedule data found.`,
            ephemeral: true,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("[admin-operations] Auto season schedule post error:", err);
        await interaction.followUp({
          content: `⚠️ Season schedule auto-post failed: ${err}.`,
          ephemeral: true,
        }).catch(() => {});
      }
    })();
  }

  // ── Weekly matchups flow ──────────────────────────────────────────────────
  const _newWeekNum = parseInt(newWeek, 10);
  if (!isNaN(_newWeekNum) && _newWeekNum >= 1 && _newWeekNum <= 18) {
    (async () => {
      try {
        await runWeeklyMatchupsFlow({
          client:          interaction.client,
          guild:           interaction.guild,
          season,
          displayWeekNum:  _newWeekNum,
          payoutWeekIndex: (!isNaN(oldWeekNum) && oldWeekNum >= 1) ? oldWeekNum - 1 : null,
          guildId,
          replyFn: async ({ content, components }) => {
            await interaction.followUp({
              content,
              components: components ?? [],
              ephemeral:  true,
            });
          },
        });
      } catch (err) {
        console.error("[admin-operations] Weekly matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Week advanced, but the weekly matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing */ }
      }
    })();
  }

  // ── Playoff matchups flow ─────────────────────────────────────────────────
  if (PLAYOFF_WEEK_META[newWeek]) {
    (async () => {
      try {
        const summary = await runPlayoffMatchupsFlow(
          interaction.client,
          season,
          newWeek,
          guildId,
        );
        await interaction.followUp({ content: summary, ephemeral: true }).catch(() => {});
      } catch (err) {
        console.error("[admin-operations] Playoff matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Week advanced, but the playoff matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing */ }
      }
    })();
  }

  // ── Waitlist scan ─────────────────────────────────────────────────────────
  checkAndNotifyWaitlist(
    interaction.client,
    interaction.guild,
    guildId,
  ).catch(err => console.error("[admin-operations] Waitlist scan error:", err));
}

// ── Set Season Number ──────────────────────────────────────────────────────────

async function getMaxSeasons(guildId: string): Promise<number> {
  const [row] = await db.select({ maxSeasons: serverSettingsTable.maxSeasons })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  return row?.maxSeasons ?? 10;
}

async function handleSetSeasonNum(interaction: ButtonInteraction) {
  const guildId   = interaction.guildId!;
  const [season, maxSeasons] = await Promise.all([
    getOrCreateActiveSeason(guildId),
    getMaxSeasons(guildId),
  ]);
  const current = season.seasonNumber ?? 1;

  const options = Array.from({ length: maxSeasons }, (_, i) => i + 1).map(n =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`Season ${n}${n === current ? " (current)" : ""}`)
      .setValue(String(n))
      .setDefault(n === current),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_set_season_num_sel")
    .setPlaceholder(`Current: Season ${current} of ${maxSeasons}`)
    .addOptions(options);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🔢 Set Season Number")
        .setDescription(
          `Select the season number to activate.\n\n` +
          `Current season: **Season ${current} of ${maxSeasons}**\n\n` +
          `⚠️ This sets the active season record only — it does **not** roll over inventories or player data. ` +
          `Use **Advance Week** through Training Camp for a full season rollover.`
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumSel(interaction: StringSelectMenuInteraction) {
  const guildId   = interaction.guildId!;
  const target    = parseInt(interaction.values[0]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);
  const isLast    = target >= maxSeasons;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Blue)
        .setTitle("🔢 Confirm Season Change")
        .setDescription(
          `Set the active season to **Season ${target} of ${maxSeasons}**?\n\n` +
          (isLast ? "⚠️ This is the **final season** of the franchise.\n\n" : "") +
          `This will activate (or create) the Season ${target} record. ` +
          `Coin balances and inventories are unchanged.`
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ao_set_season_num_confirm:${target}`)
          .setLabel(`✅ Set to Season ${target}`)
          .setStyle(isLast ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumConfirm(interaction: ButtonInteraction) {
  const guildId   = interaction.guildId!;
  const target    = parseInt(interaction.customId.split(":")[1]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);

  const existing = await db.select().from(seasonsTable)
    .where(eq(seasonsTable.seasonNumber, target)).limit(1);

  await db.update(seasonsTable).set({ isActive: false });

  let activeSeason;
  if (existing.length > 0) {
    const [updated] = await db.update(seasonsTable)
      .set({ isActive: true })
      .where(eq(seasonsTable.seasonNumber, target))
      .returning();
    activeSeason = updated;
  } else {
    const [created] = await db.insert(seasonsTable)
      .values({ seasonNumber: target, isActive: true })
      .returning();
    activeSeason = created;
  }

  const isLast = target >= maxSeasons;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Green)
        .setTitle(`📅 Season Set to ${target} of ${maxSeasons}`)
        .setDescription(
          `The active season is now **Season ${target}**.\n\n` +
          `Season ID: \`${activeSeason?.id ?? "?"}\`` +
          (isLast ? "\n\n🏁 **This is the final season of the franchise.**" : "")
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// ── Rules Hub ─────────────────────────────────────────────────────────────────

async function handleRulesHub(interaction: ButtonInteraction | StringSelectMenuInteraction, _sess: AoSession) {
  const guildId  = interaction.guildId!;
  const sections = await getAllSections(guildId);
  const entries  = Object.entries(sections);

  if (entries.length === 0) {
    await (interaction as any).update({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("📋 Rules")
          .setDescription("No rule sections found. Run `/adminrules new-section` to create one first."),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
        ) as ActionRowBuilder<any>,
      ],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_rules_section")
    .setPlaceholder("Select a section to view/edit...")
    .addOptions(
      entries.slice(0, 25).map(([key, meta]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim() || key)
          .setValue(key)
          .setDescription(`Section: ${key}`),
      ),
    );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 View / Edit Rules")
        .setDescription("Select a section to view its rules and manage them."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      backRow,
    ],
  });
}

async function handleRulesSection(interaction: StringSelectMenuInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  const section = interaction.values[0]!;
  sess.rulesSection = section;

  const sections = await getAllSections(guildId);
  const meta     = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules = await getOrSeedRules(section, guildId);
  const embed = buildRulesEmbed(section, meta, rules);
  const btns  = buildRulesButtons(rules.length);

  await interaction.update({ embeds: [embed], components: btns });
}

async function handleRulesAdd(interaction: ButtonInteraction, sess: AoSession) {
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_add")
    .setTitle("Add New Rule");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule Text")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Enter the full text of the new rule...")
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRulesEdit(interaction: ButtonInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (rules.length === 0) {
    await interaction.reply({ content: "❌ No rules to edit in this section.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_rules_edit_sel")
    .setPlaceholder("Select the rule number to edit...")
    .addOptions(
      rules.slice(0, 25).map((text, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Rule ${i + 1}`)
          .setValue(String(i + 1))
          .setDescription(text.length > 50 ? text.slice(0, 47) + "..." : text),
      ),
    );

  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules_back_sections").setLabel("← Back to Sections").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("✏️ Edit Rule — Select Rule Number")
        .setDescription("Choose which rule you want to edit. A form will appear with the current text pre-filled."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      cancelRow,
    ],
  });
}

async function handleRulesEditSel(interaction: StringSelectMenuInteraction, sess: AoSession) {
  const guildId  = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum = parseInt(interaction.values[0]!, 10);
  const rules   = await getOrSeedRules(sess.rulesSection, guildId);
  const ruleText = rules[ruleNum - 1] ?? "";

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_edit")
    .setTitle(`Edit Rule ${ruleNum}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_num")
        .setLabel("Rule Number (do not change)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(ruleNum))
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule Text")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(ruleText)
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRulesDelete(interaction: ButtonInteraction, sess: AoSession) {
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_delete")
    .setTitle("Delete Rule");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_num")
        .setLabel("Rule Number to Delete")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 3")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(3),
    ),
  );

  await interaction.showModal(modal);
}

// ── Rules Modal Handlers ───────────────────────────────────────────────────────

async function handleModalRulesAdd(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const newText = interaction.fields.getTextInputValue("rule_text").trim();
  if (!newText) {
    await interaction.reply({ content: "❌ Rule text cannot be empty.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  rules.push(newText);
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.rulesSection]!;
  const embed    = buildRulesEmbed(sess.rulesSection, meta, rules);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Rule Added")
        .setDescription(`Rule **#${rules.length}** has been added to **${meta.title}**.`),
      embed,
    ],
    components: buildRulesButtons(rules.length),
    ephemeral: true,
  });
}

async function handleModalRulesEdit(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId  = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum  = parseInt(interaction.fields.getTextInputValue("rule_num"), 10);
  const newText  = interaction.fields.getTextInputValue("rule_text").trim();

  if (isNaN(ruleNum) || ruleNum < 1) {
    await interaction.reply({ content: "❌ Invalid rule number.", ephemeral: true });
    return;
  }
  if (!newText) {
    await interaction.reply({ content: "❌ Rule text cannot be empty.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (ruleNum > rules.length) {
    await interaction.reply({ content: `❌ Rule #${ruleNum} does not exist. This section has ${rules.length} rule(s).`, ephemeral: true });
    return;
  }

  rules[ruleNum - 1] = newText;
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.rulesSection]!;
  const embed    = buildRulesEmbed(sess.rulesSection, meta, rules);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Rule Updated")
        .setDescription(`Rule **#${ruleNum}** in **${meta.title}** has been updated.`),
      embed,
    ],
    components: buildRulesButtons(rules.length),
    ephemeral: true,
  });
}

async function handleModalRulesDelete(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum = parseInt(interaction.fields.getTextInputValue("rule_num"), 10);
  if (isNaN(ruleNum) || ruleNum < 1) {
    await interaction.reply({ content: "❌ Invalid rule number.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (ruleNum > rules.length) {
    await interaction.reply({ content: `❌ Rule #${ruleNum} does not exist. This section has ${rules.length} rule(s).`, ephemeral: true });
    return;
  }

  const [deleted] = rules.splice(ruleNum - 1, 1);
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.rulesSection]!;
  const embed    = buildRulesEmbed(sess.rulesSection, meta, rules);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Rule Deleted")
        .setDescription(
          `Rule **#${ruleNum}** has been removed from **${meta.title}**.\n` +
          `_Deleted text: "${deleted?.slice(0, 100)}${(deleted?.length ?? 0) > 100 ? "..." : ""}"_\n\n` +
          `Remaining rules have been renumbered.`
        ),
      embed,
    ],
    components: buildRulesButtons(rules.length),
    ephemeral: true,
  });
}
