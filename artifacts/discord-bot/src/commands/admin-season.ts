import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable, seasonStatsTable, inventoryTable, usersTable, legendsTable, userRecordsTable, gameLogTable, serverSettingsTable, customPlayersTable, franchiseMcaTeamsTable, franchiseRostersTable, playerStatWeekProcessedTable, playerSeasonStatsTable } from "@workspace/db";
import { eq, and, sql, ne } from "drizzle-orm";
import { logTransaction, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { ATTRIBUTES } from "../lib/constants.js";

const PERMANENT_CAP = 4;

// Promote current-season legends → permanent for all users, enforcing the 4-cap.
// Returns a summary of what happened.
async function rolloverLegends(seasonId: number, guildId: string): Promise<string> {
  const currentLegends = await db.select().from(inventoryTable)
    .where(and(
      eq(inventoryTable.seasonId, seasonId),
      eq(inventoryTable.itemType, "legend"),
      sql`${inventoryTable.legendCategory} = 'current'`,
    ));

  if (currentLegends.length === 0) return "No current-season legends to roll over.";

  // Group by user
  const byUser: Record<string, typeof currentLegends> = {};
  for (const item of currentLegends) {
    if (!byUser[item.discordId]) byUser[item.discordId] = [];
    byUser[item.discordId]!.push(item);
  }

  let promoted = 0;
  let returned = 0;

  for (const [userId, legends] of Object.entries(byUser)) {
    // Resolve the team this user currently controls — items will be stamped with it
    // so the permanent vault follows the FRANCHISE, not the individual Discord account.
    const [userRow] = await db.select({ team: usersTable.team }).from(usersTable)
      .where(and(eq(usersTable.discordId, userId), eq(usersTable.guildId, guildId))).limit(1);
    const teamName = userRow?.team ?? null;

    // Count existing permanent legends for this team (or user as fallback)
    const countRows = await db.select({ c: sql<string>`COUNT(*)` })
      .from(inventoryTable)
      .where(and(
        teamName
          ? eq(inventoryTable.team, teamName)
          : eq(inventoryTable.discordId, userId),
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'permanent'`,
      ));
    const existing = parseInt(countRows[0]?.c ?? "0", 10);
    const slotsLeft = Math.max(0, PERMANENT_CAP - existing);

    const toPromote = legends.slice(0, slotsLeft);
    const toReturn  = legends.slice(slotsLeft);

    for (const item of toPromote) {
      await db.update(inventoryTable)
        .set({ legendCategory: "permanent", ...(teamName ? { team: teamName } : {}) })
        .where(eq(inventoryTable.id, item.id));
      promoted++;
    }

    for (const item of toReturn) {
      // Return legend to store and remove from inventory
      if (item.legendId) {
        await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, item.legendId));
      }
      await db.delete(inventoryTable).where(eq(inventoryTable.id, item.id));
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, userId));
      returned++;
    }
  }

  const lines = [`• **${promoted}** legend(s) moved to permanent vaults.`];
  if (returned > 0) lines.push(`• **${returned}** legend(s) returned to the store (vault full).`);
  return lines.join("\n");
}

// Move active custom players from customPlayersTable → inventoryTable as permanent items.
// Only processes non-refunded players that haven't already been rolled over.
async function rolloverCustomPlayers(seasonId: number, guildId: string): Promise<string> {
  const active = await db.select()
    .from(customPlayersTable)
    .where(and(
      eq(customPlayersTable.seasonId, seasonId),
      ne(customPlayersTable.status, "refunded"),
    ));

  if (active.length === 0) return "";

  // Map tier → purchaseTypeEnum value (kp falls back to bronze for inventory tracking)
  const tierToItemType = (tier: string): "custom_player_gold" | "custom_player_silver" | "custom_player_bronze" => {
    if (tier === "gold")   return "custom_player_gold";
    if (tier === "silver") return "custom_player_silver";
    return "custom_player_bronze";
  };

  let rolled = 0;
  for (const cp of active) {
    // Resolve the team this user currently controls so the permanent item follows the franchise.
    const [userRow] = await db.select({ team: usersTable.team }).from(usersTable)
      .where(and(eq(usersTable.discordId, cp.discordId), eq(usersTable.guildId, guildId))).limit(1);
    const teamName = userRow?.team ?? null;

    // Check if already in inventory (idempotent guard)
    const existing = await db.select({ id: inventoryTable.id })
      .from(inventoryTable)
      .where(and(
        eq(inventoryTable.discordId, cp.discordId),
        eq(inventoryTable.seasonId, seasonId),
        eq(inventoryTable.itemType, tierToItemType(cp.packageTier)),
        sql`${inventoryTable.playerName} = ${`${cp.firstName} ${cp.lastName}`}`,
        sql`${inventoryTable.legendCategory} = 'permanent'`,
      ))
      .limit(1);

    if (existing.length > 0) continue; // already rolled over

    await db.insert(inventoryTable).values({
      discordId:        cp.discordId,
      seasonId,
      purchaseId:       0, // no linked purchase row for new-style custom players
      itemType:         tierToItemType(cp.packageTier),
      playerName:       `${cp.firstName} ${cp.lastName}`,
      playerPosition:   cp.position,
      notes:            `Dev: ${cp.devTrait} | Archetype: ${cp.archetypeName} | Tier: ${cp.packageTier.toUpperCase()}`,
      legendCategory:   "permanent",
      ...(teamName ? { team: teamName } : {}),
    });
    rolled++;
  }

  if (rolled === 0) return "";
  return `• **${rolled}** custom player${rolled !== 1 ? "s" : ""} moved to permanent inventories.`;
}

const DEFAULT_MAX_SEASONS = 10;

async function getMaxSeasons(): Promise<number> {
  const [row] = await db.select({ maxSeasons: serverSettingsTable.maxSeasons })
    .from(serverSettingsTable).limit(1);
  return row?.maxSeasons ?? DEFAULT_MAX_SEASONS;
}

export const data = new SlashCommandBuilder()
  .setName("season")
  .setDescription("Commissioner: Manage seasons")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("advance")
      .setDescription("Advance to the next season (subject to franchise season limit)")
  )
  .addSubcommand(sub =>
    sub.setName("set")
      .setDescription("Jump directly to a specific season number (1–50)")
      .addIntegerOption(opt =>
        opt.setName("number")
          .setDescription("Season number to activate")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(50)
      )
  )
  .addSubcommand(sub =>
    sub.setName("status")
      .setDescription("View the current season info")
  )
  .addSubcommand(sub =>
    sub.setName("addcoins")
      .setDescription("Add coins to a user's balance")
      .addUserOption(opt => opt.setName("user").setDescription("The user to give coins to").setRequired(true))
      .addIntegerOption(opt => opt.setName("amount").setDescription("Amount to add").setRequired(true).setMinValue(1))
  )
  .addSubcommand(sub =>
    sub.setName("set_limits")
      .setDescription("Set attribute rule overrides for the current season (omit = keep current value)")
      .addIntegerOption(opt =>
        opt.setName("core_attr_cost")
          .setDescription("Cost per core attribute point this season (default: 25)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("core_attr_cap")
          .setDescription("Max core attribute points this season (default: 16)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("non_core_attr_cost")
          .setDescription("Cost per non-core attribute point this season (default: 10)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("non_core_attr_cap")
          .setDescription("Max non-core attribute points this season (default: 32)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("dev_ups_cap")
          .setDescription("Max dev upgrades per season (default: 2)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("dev_ups_cost")
          .setDescription("Coin cost per dev upgrade (default: 250)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("age_resets_cap")
          .setDescription("Max age resets per season (default: 2)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("age_resets_cost")
          .setDescription("Coin cost per age reset (default: 250)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("legend_cost")
          .setDescription("Coin cost per legend (default: 1000)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("custom_gold_cost")
          .setDescription("Coin cost for a Gold custom player (default: 300)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("custom_silver_cost")
          .setDescription("Coin cost for a Silver custom player (default: 200)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("custom_bronze_cost")
          .setDescription("Coin cost for a Bronze custom player (default: 100)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addBooleanOption(opt =>
        opt.setName("clear")
          .setDescription("Set to True to clear ALL overrides and restore defaults")
          .setRequired(false)
      )
  )
  .addSubcommand(sub => {
    let s = sub
      .setName("core-attrs")
      .setDescription("Set which attributes count as Core this season (1–10). Omit to reset to defaults.")
      .addStringOption(opt =>
        opt.setName("attr1")
          .setDescription("Core attribute #1 (required — provide at least one)")
          .setRequired(true)
          .setAutocomplete(true)
      );
    for (let i = 2; i <= 10; i++) {
      s = s.addStringOption(opt =>
        opt.setName(`attr${i}`)
          .setDescription(`Core attribute #${i}`)
          .setRequired(false)
          .setAutocomplete(true)
      );
    }
    return s.addBooleanOption(opt =>
      opt.setName("reset")
        .setDescription("Set to True to restore the default core attribute list instead of saving")
        .setRequired(false)
    );
  })
  .addSubcommand(sub =>
    sub.setName("carryforward")
      .setDescription("Manually copy team links + roster data from the previous season into the current season"),
  )
  .addSubcommand(sub =>
    sub.setName("resetweekstats")
      .setDescription("Clear stat dedup records + player season stats so EA export can re-import them fresh")
      .addBooleanOption(o => o
        .setName("confirm")
        .setDescription("Must be True to execute — this wipes all player season stats for the active season")
        .setRequired(true)),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === "advance") {
    const [seasons, maxSeasons] = await Promise.all([
      db.select().from(seasonsTable).orderBy(sql`${seasonsTable.seasonNumber} DESC`).limit(1),
      getMaxSeasons(),
    ]);
    const currentSeason = seasons[0];
    const currentNumber = currentSeason?.seasonNumber ?? 0;
    const nextNumber    = currentNumber + 1;

    if (nextNumber > maxSeasons) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("🏁 Franchise Complete")
            .setDescription(
              `This franchise has reached its **${maxSeasons}-season limit**.\n\n` +
              `Season ${currentNumber} is the final season.\n` +
              `• To extend the franchise: \`/season franchise-limit limit:XX\`\n` +
              `• To reset the franchise entirely: \`/season franchise-reset confirm:True\``
            ),
        ],
      });
    }

    // ── Roll over current-season legends → permanent ───────────────────────
    const rolloverMsg = currentSeason
      ? await rolloverLegends(currentSeason.id, interaction.guildId!)
      : "No previous season to roll over.";

    // ── Roll over active custom players → permanent inventory ──────────────
    const cpRolloverMsg = currentSeason
      ? await rolloverCustomPlayers(currentSeason.id, interaction.guildId!)
      : "";

    await db.update(seasonsTable).set({ isActive: false });
    const [newSeason] = await db.insert(seasonsTable).values({ seasonNumber: nextNumber, isActive: true }).returning();

    // ── Carry forward MCA team links and roster data from the previous season ──
    // This keeps the Discord↔team links and player attribute data intact so
    // all roster-based features keep working until MCA reimports fresh data.
    let carryTeams = 0, carryRosters = 0;
    if (currentSeason && newSeason) {
      const prevTeams = await db.select().from(franchiseMcaTeamsTable)
        .where(eq(franchiseMcaTeamsTable.seasonId, currentSeason.id));

      if (prevTeams.length > 0) {
        const teamRows = prevTeams.map(t => ({
          seasonId:  newSeason.id,
          teamId:    t.teamId,
          fullName:  t.fullName,
          nickName:  t.nickName,
          userName:  t.userName,
          isHuman:   t.isHuman,
          discordId: t.discordId,
        }));
        await db.insert(franchiseMcaTeamsTable).values(teamRows).onConflictDoNothing();
        carryTeams = teamRows.length;

        const prevRosters = await db.select().from(franchiseRostersTable)
          .where(eq(franchiseRostersTable.seasonId, currentSeason.id));

        if (prevRosters.length > 0) {
          const rosterRows = prevRosters.map(r => ({
            seasonId:          newSeason.id,
            teamId:            r.teamId,
            teamName:          r.teamName,
            discordId:         r.discordId,
            playerId:          r.playerId,
            firstName:         r.firstName,
            lastName:          r.lastName,
            position:          r.position,
            overall:           r.overall,
            devTrait:          r.devTrait,
            age:               r.age,
            jerseyNum:         r.jerseyNum,
            contractYearsLeft: r.contractYearsLeft,
            attributes:        r.attributes,
          }));
          // Insert in batches of 500 to avoid parameter limits
          for (let i = 0; i < rosterRows.length; i += 500) {
            await db.insert(franchiseRostersTable).values(rosterRows.slice(i, i + 500)).onConflictDoNothing();
          }
          carryRosters = rosterRows.length;
        }
      }
    }

    const isLast = nextNumber === maxSeasons;
    const embed  = new EmbedBuilder()
      .setColor(isLast ? Colors.Orange : Colors.Green)
      .setTitle(isLast ? "🏁 Final Season Started!" : "🎉 New Season Started!")
      .setDescription(
        `**Season ${newSeason!.seasonNumber} of ${maxSeasons}** has begun!\n\n` +
        `All player inventories and purchase limits have been reset.\nCoin balances are unchanged.` +
        (isLast ? "\n\n⚠️ **This is the last season of the franchise.**" : "")
      )
      .addFields({ name: "🏅 Legend Vault Rollover", value: rolloverMsg });
    if (cpRolloverMsg) embed.addFields({ name: "🏈 Custom Player Rollover", value: cpRolloverMsg });
    embed.addFields({
      name: "📋 Roster Carry-Forward",
      value: carryTeams > 0
        ? `${carryTeams} team links + ${carryRosters} roster rows copied from Season ${currentSeason!.seasonNumber}. MCA will overwrite with fresh data on next import.`
        : "No previous roster data to carry forward — MCA import required before roster features work.",
    });
    embed.setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "set") {
    const targetNumber = interaction.options.getInteger("number", true);
    const maxSeasons   = await getMaxSeasons();

    // Check if a season record already exists for this number
    const existing = await db.select().from(seasonsTable)
      .where(eq(seasonsTable.seasonNumber, targetNumber)).limit(1);

    // Deactivate all seasons
    await db.update(seasonsTable).set({ isActive: false });

    let activeSeason;
    if (existing.length > 0) {
      // Reactivate the existing record
      const [updated] = await db.update(seasonsTable)
        .set({ isActive: true })
        .where(eq(seasonsTable.seasonNumber, targetNumber))
        .returning();
      activeSeason = updated;
    } else {
      // Create the season record at this number
      const [created] = await db.insert(seasonsTable)
        .values({ seasonNumber: targetNumber, isActive: true })
        .returning();
      activeSeason = created;
    }

    const isLast = targetNumber >= maxSeasons;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(isLast ? Colors.Orange : Colors.Blue)
          .setTitle(`📅 Season Set to ${targetNumber} of ${maxSeasons}`)
          .setDescription(
            `The active season is now **Season ${targetNumber}**.\n\n` +
            `⚠️ Note: This does **not** reset inventories or upgrade counts — use \`/season new\` if you want a full season rollover.` +
            (isLast ? "\n\n🏁 **This is the final season of the franchise.**" : "")
          )
          .setTimestamp(),
      ],
    });
  }

  if (sub === "status") {
    const seasons = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
    const season = seasons[0];
    if (!season) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Active Season").setDescription("No active season found. Use `/season new` to start one.")] });
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle("📅 Current Season")
          .addFields(
            { name: "Season", value: `#${season.seasonNumber}`, inline: true },
            { name: "Started", value: `<t:${Math.floor(season.startedAt.getTime() / 1000)}:R>`, inline: true },
          )
          .setTimestamp(),
      ],
    });
  }

  if (sub === "addcoins") {
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, target.id));

    await logTransaction(target.id, amount, "season_adjustment", "Season coin adjustment by commissioner", interaction.guildId!, interaction.user.id);

    const adjustEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Season Coin Adjustment")
      .setDescription(`Added **${amount.toLocaleString()} coins** to ${target.toString()}.`)
      .addFields({ name: "Issued by", value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp();

    try {
      const commChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER)
        ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";
      const commCh = commChannelId
        ? await interaction.client.channels.fetch(commChannelId).catch(() => null)
        : null;
      if (commCh instanceof TextChannel) await commCh.send({ embeds: [adjustEmbed] });
    } catch (err) {
      console.error("[admin-season addcoins] Failed to log to commissioner channel:", err);
    }

    return interaction.editReply({ embeds: [adjustEmbed] });
  }

  if (sub === "set_limits") {
    const clear = interaction.options.getBoolean("clear") ?? false;

    const seasons = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
    const season = seasons[0];
    if (!season) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Active Season").setDescription("No active season found.")],
      });
    }

    if (clear) {
      await db.update(seasonsTable)
        .set({
          coreAttrCostOverride: null, coreAttrCapOverride: null,
          nonCoreAttrCostOverride: null, nonCoreAttrCapOverride: null,
          devUpsCapOverride: null, devUpsCostOverride: null,
          ageResetsCapOverride: null, ageResetsCostOverride: null,
          legendCostOverride: null,
          customGoldCostOverride: null, customSilverCostOverride: null, customBronzeCostOverride: null,
          coreAttributesOverride: null,
        })
        .where(eq(seasonsTable.id, season.id));

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blue)
            .setTitle("🔄 Overrides Cleared — Season " + season.seasonNumber)
            .setDescription(
              "All overrides removed. Default rules are now active:\n" +
              "• **Core attrs**: 25 coins/pt, cap 16/season\n" +
              "• **Non-core attrs**: 10 coins/pt, cap 32/season\n" +
              "• **Dev upgrades**: 250 coins, 2/season\n" +
              "• **Age resets**: 250 coins, 2/season\n" +
              "• **Legends**: 1000 coins\n" +
              "• **Custom players**: Gold 300 / Silver 200 / Bronze 100 coins\n" +
              "• **Core attribute list**: restored to defaults"
            )
            .setTimestamp(),
        ],
      });
    }

    const coreAttrCost     = interaction.options.getInteger("core_attr_cost");
    const coreAttrCap      = interaction.options.getInteger("core_attr_cap");
    const nonCoreAttrCost  = interaction.options.getInteger("non_core_attr_cost");
    const nonCoreAttrCap   = interaction.options.getInteger("non_core_attr_cap");
    const devUpsCap        = interaction.options.getInteger("dev_ups_cap");
    const devUpsCost       = interaction.options.getInteger("dev_ups_cost");
    const ageResetsCap     = interaction.options.getInteger("age_resets_cap");
    const ageResetsCost    = interaction.options.getInteger("age_resets_cost");
    const legendCost       = interaction.options.getInteger("legend_cost");
    const customGoldCost   = interaction.options.getInteger("custom_gold_cost");
    const customSilverCost = interaction.options.getInteger("custom_silver_cost");
    const customBronzeCost = interaction.options.getInteger("custom_bronze_cost");

    if (coreAttrCost === null && coreAttrCap === null && nonCoreAttrCost === null && nonCoreAttrCap === null
        && devUpsCap === null && devUpsCost === null && ageResetsCap === null && ageResetsCost === null
        && legendCost === null && customGoldCost === null && customSilverCost === null && customBronzeCost === null) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Nothing to Change").setDescription("Provide at least one override value, or use `clear: True` to restore defaults.")],
      });
    }

    const updates: Record<string, number | null> = {};
    if (coreAttrCost     !== null) updates["coreAttrCostOverride"]    = coreAttrCost;
    if (coreAttrCap      !== null) updates["coreAttrCapOverride"]     = coreAttrCap;
    if (nonCoreAttrCost  !== null) updates["nonCoreAttrCostOverride"] = nonCoreAttrCost;
    if (nonCoreAttrCap   !== null) updates["nonCoreAttrCapOverride"]  = nonCoreAttrCap;
    if (devUpsCap        !== null) updates["devUpsCapOverride"]       = devUpsCap;
    if (devUpsCost       !== null) updates["devUpsCostOverride"]      = devUpsCost;
    if (ageResetsCap     !== null) updates["ageResetsCapOverride"]    = ageResetsCap;
    if (ageResetsCost    !== null) updates["ageResetsCostOverride"]   = ageResetsCost;
    if (legendCost       !== null) updates["legendCostOverride"]      = legendCost;
    if (customGoldCost   !== null) updates["customGoldCostOverride"]  = customGoldCost;
    if (customSilverCost !== null) updates["customSilverCostOverride"] = customSilverCost;
    if (customBronzeCost !== null) updates["customBronzeCostOverride"] = customBronzeCost;

    await db.update(seasonsTable).set(updates as any).where(eq(seasonsTable.id, season.id));

    const updated = await db.select().from(seasonsTable).where(eq(seasonsTable.id, season.id)).limit(1);
    const s = updated[0]!;

    const { COSTS, LIMITS } = await import("../lib/constants.js");
    const lines = [
      `**Core attr cost:** ${s.coreAttrCostOverride !== null ? `~~${COSTS.core_attribute}~~ → **${s.coreAttrCostOverride} coins** ⚠️` : `**${COSTS.core_attribute} coins** (default)`}`,
      `**Core attr cap:** ${s.coreAttrCapOverride !== null ? `~~${LIMITS.coreAttrPerSeason}~~ → **${s.coreAttrCapOverride}/season** ⚠️` : `**${LIMITS.coreAttrPerSeason}/season** (default)`}`,
      `**Non-core attr cost:** ${s.nonCoreAttrCostOverride !== null ? `~~${COSTS.non_core_attribute}~~ → **${s.nonCoreAttrCostOverride} coins** ⚠️` : `**${COSTS.non_core_attribute} coins** (default)`}`,
      `**Non-core attr cap:** ${s.nonCoreAttrCapOverride !== null ? `~~${LIMITS.nonCoreAttrPerSeason}~~ → **${s.nonCoreAttrCapOverride}/season** ⚠️` : `**${LIMITS.nonCoreAttrPerSeason}/season** (default)`}`,
      `**Dev upgrade cap:** ${s.devUpsCapOverride !== null ? `~~${LIMITS.devUpsPerSeason}~~ → **${s.devUpsCapOverride}/season** ⚠️` : `**${LIMITS.devUpsPerSeason}/season** (default)`}`,
      `**Dev upgrade cost:** ${s.devUpsCostOverride !== null ? `~~${COSTS.dev_up}~~ → **${s.devUpsCostOverride} coins** ⚠️` : `**${COSTS.dev_up} coins** (default)`}`,
      `**Age reset cap:** ${s.ageResetsCapOverride !== null ? `~~${LIMITS.ageResetsPerSeason}~~ → **${s.ageResetsCapOverride}/season** ⚠️` : `**${LIMITS.ageResetsPerSeason}/season** (default)`}`,
      `**Age reset cost:** ${s.ageResetsCostOverride !== null ? `~~${COSTS.age_reset}~~ → **${s.ageResetsCostOverride} coins** ⚠️` : `**${COSTS.age_reset} coins** (default)`}`,
      `**Legend cost:** ${s.legendCostOverride !== null ? `~~${COSTS.legend}~~ → **${s.legendCostOverride} coins** ⚠️` : `**${COSTS.legend} coins** (default)`}`,
      `**Custom Gold cost:** ${s.customGoldCostOverride !== null ? `~~${COSTS.custom_player_gold}~~ → **${s.customGoldCostOverride} coins** ⚠️` : `**${COSTS.custom_player_gold} coins** (default)`}`,
      `**Custom Silver cost:** ${s.customSilverCostOverride !== null ? `~~${COSTS.custom_player_silver}~~ → **${s.customSilverCostOverride} coins** ⚠️` : `**${COSTS.custom_player_silver} coins** (default)`}`,
      `**Custom Bronze cost:** ${s.customBronzeCostOverride !== null ? `~~${COSTS.custom_player_bronze}~~ → **${s.customBronzeCostOverride} coins** ⚠️` : `**${COSTS.custom_player_bronze} coins** (default)`}`,
    ];

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle(`⚙️ Season ${season.seasonNumber} Overrides Updated`)
          .setDescription(lines.join("\n") + "\n\n*Overrides apply only to this season. Defaults restore when a new season starts.*")
          .setTimestamp(),
      ],
    });
  }

  if (sub === "core-attrs") {
    const seasons = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
    const season = seasons[0];
    if (!season) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Active Season").setDescription("No active season found.")],
      });
    }

    const reset = interaction.options.getBoolean("reset") ?? false;
    if (reset) {
      await db.update(seasonsTable).set({ coreAttributesOverride: null }).where(eq(seasonsTable.id, season.id));
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blue)
            .setTitle(`🔄 Core Attributes Reset — Season ${season.seasonNumber}`)
            .setDescription("Core attribute list restored to default:\n" + [...new Set(["Speed","Acceleration","Change of Direction","Agility","Strength","Jumping","Throwing Power","Awareness","Stamina"])].map(a => `• ${a}`).join("\n"))
            .setTimestamp(),
        ],
      });
    }

    const chosen: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const val = interaction.options.getString(i === 1 ? "attr1" : `attr${i}`);
      if (val) chosen.push(val);
    }

    const invalid = chosen.filter(a => !ATTRIBUTES.includes(a as any));
    if (invalid.length > 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Invalid Attribute(s)").setDescription(`These are not valid attributes: **${invalid.join(", ")}**\n\nUse the autocomplete list when typing each attribute.`)],
      });
    }

    const unique = [...new Set(chosen)];
    if (unique.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Attributes Provided").setDescription("You must provide at least 1 attribute (`attr1` is required).")],
      });
    }

    await db.update(seasonsTable).set({ coreAttributesOverride: JSON.stringify(unique) }).where(eq(seasonsTable.id, season.id));

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`✅ Core Attributes Set — Season ${season.seasonNumber}`)
          .setDescription(
            `**${unique.length}** attribute${unique.length === 1 ? "" : "s"} now count as Core this season:\n` +
            unique.map(a => `• ${a}`).join("\n") +
            "\n\nAll other attributes are Non-Core. Use `/season override clear: True` or `/season core-attrs reset: True` to restore defaults."
          )
          .setTimestamp(),
      ],
    });
    return;
  }
  // ── /season carryforward ──────────────────────────────────────────────────
  if (sub === "carryforward") {
    const seasons = await db.select().from(seasonsTable).orderBy(sql`${seasonsTable.seasonNumber} DESC`).limit(2);
    const currentSeason = seasons.find(s => s.isActive) ?? seasons[0];
    const prevSeason    = seasons.find(s => !s.isActive) ?? seasons[1];

    if (!currentSeason) {
      return interaction.editReply({ content: "❌ No active season found." });
    }
    if (!prevSeason || prevSeason.id === currentSeason.id) {
      return interaction.editReply({ content: "❌ No previous season found to carry forward from." });
    }

    const prevTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, prevSeason.id));

    if (prevTeams.length === 0) {
      return interaction.editReply({ content: `❌ No team data found for Season ${prevSeason.seasonNumber} to carry forward.` });
    }

    // Upsert teams — preserve any season-3 rows already written by MCA stubs
    const teamRows = prevTeams.map(t => ({
      seasonId:  currentSeason.id,
      teamId:    t.teamId,
      fullName:  t.fullName,
      nickName:  t.nickName,
      userName:  t.userName,
      isHuman:   t.isHuman,
      discordId: t.discordId,
      updatedAt: new Date(),
    }));

    let carryTeams = 0;
    for (const row of teamRows) {
      await db.insert(franchiseMcaTeamsTable)
        .values(row)
        .onConflictDoUpdate({
          target: [franchiseMcaTeamsTable.seasonId, franchiseMcaTeamsTable.teamId],
          set: {
            fullName:  row.fullName,
            nickName:  row.nickName,
            userName:  row.userName,
            isHuman:   row.isHuman,
            discordId: row.discordId,
            updatedAt: row.updatedAt,
          },
        });
      carryTeams++;
    }

    // Copy roster rows — delete existing season-N stubs first, then insert
    await db.delete(franchiseRostersTable).where(eq(franchiseRostersTable.seasonId, currentSeason.id));
    const prevRosters = await db.select().from(franchiseRostersTable)
      .where(eq(franchiseRostersTable.seasonId, prevSeason.id));

    let carryRosters = 0;
    if (prevRosters.length > 0) {
      const rosterRows = prevRosters.map(r => ({
        seasonId:          currentSeason.id,
        teamId:            r.teamId,
        teamName:          r.teamName,
        discordId:         r.discordId,
        playerId:          r.playerId,
        firstName:         r.firstName,
        lastName:          r.lastName,
        position:          r.position,
        overall:           r.overall,
        devTrait:          r.devTrait,
        age:               r.age,
        jerseyNum:         r.jerseyNum,
        contractYearsLeft: r.contractYearsLeft,
        attributes:        r.attributes,
      }));
      for (let i = 0; i < rosterRows.length; i += 500) {
        await db.insert(franchiseRostersTable).values(rosterRows.slice(i, i + 500));
      }
      carryRosters = rosterRows.length;
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Roster Carry-Forward Complete")
          .setDescription(
            `Copied from **Season ${prevSeason.seasonNumber}** into **Season ${currentSeason.seasonNumber}**:\n\n` +
            `• **${carryTeams}** team links\n` +
            `• **${carryRosters}** roster rows\n\n` +
            `All roster commands will now work. MCA will overwrite with fresh data on next import.`
          ),
      ],
    });
  }

  // ── /season resetweekstats ────────────────────────────────────────────────
  if (sub === "resetweekstats") {
    const confirmed = interaction.options.getBoolean("confirm") ?? false;
    if (!confirmed) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Confirm Reset")
          .setDescription(
            "This will **delete all player season stats** and **clear the weekly dedup records** for the active season.\n\n" +
            "Run this when stats were imported before carryforward (causing all discord_ids to be NULL). " +
            "After this, run a fresh EA export and then `/admin-linkteam relink`.\n\n" +
            "Re-run with `confirm: True` to proceed."
          )],
      });
    }

    const [activeSeason] = await db.select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
    if (!activeSeason) return interaction.editReply({ content: "❌ No active season found." });

    const [deletedStats] = await Promise.all([
      db.delete(playerSeasonStatsTable)
        .where(eq(playerSeasonStatsTable.seasonId, activeSeason.id))
        .returning({ id: playerSeasonStatsTable.id }),
      db.delete(playerStatWeekProcessedTable)
        .where(eq(playerStatWeekProcessedTable.seasonId, activeSeason.id)),
    ]);

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Player Stats Reset")
        .setDescription(
          `Season **${activeSeason.seasonNumber}** player stats cleared:\n\n` +
          `• **${deletedStats.length}** player stat rows deleted\n` +
          `• Weekly dedup records cleared\n\n` +
          `**Next steps:**\n` +
          `1. Run a full EA export from MCA\n` +
          `2. Run \`/admin-linkteam relink\` to fix any remaining null discord_ids`
        )
        .setTimestamp()],
    });
  }

  return interaction.editReply({ content: "❌ Unknown subcommand." });
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const sub = interaction.options.getSubcommand(false);
  if (sub !== "core-attrs") return;

  const focused = interaction.options.getFocused().toLowerCase();
  const choices = ATTRIBUTES
    .filter(a => a.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(a => ({ name: a, value: a }));
  await interaction.respond(choices);
}

// ── Standalone handlers for /admin server_franchise_limit & server_franchise_reset ──

export async function executeFranchiseLimit(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const limit = interaction.options.getInteger("limit", true);
  const [settings] = await db.select().from(serverSettingsTable).limit(1);
  if (settings) {
    await db.update(serverSettingsTable)
      .set({ maxSeasons: limit, updatedAt: new Date() })
      .where(eq(serverSettingsTable.id, settings.id));
  } else {
    await db.insert(serverSettingsTable).values({ maxSeasons: limit });
  }
  const [current] = await db.select().from(seasonsTable).orderBy(sql`${seasonsTable.seasonNumber} DESC`).limit(1);
  const currentNum = current?.seasonNumber ?? 0;
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Franchise Season Limit Updated")
        .addFields(
          { name: "Max Seasons",    value: `**${limit}**`,                                   inline: true },
          { name: "Current Season", value: `**${currentNum}**`,                              inline: true },
          { name: "Seasons Left",   value: `**${Math.max(0, limit - currentNum)}**`,          inline: true },
        )
        .setTimestamp(),
    ],
  });
}

export async function executeFranchiseReset(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const confirmed = interaction.options.getBoolean("confirm", true);
  if (!confirmed) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Franchise Reset Cancelled")
          .setDescription("You must set `confirm: True` to execute the franchise reset."),
      ],
    });
  }

  // 1. Return ALL owned legends to the store (preserve the legends catalog itself)
  const allLegendItems = await db.select().from(inventoryTable)
    .where(eq(inventoryTable.itemType, "legend"));

  for (const item of allLegendItems) {
    if (item.legendId) {
      await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, item.legendId));
    }
  }

  // 2. Clear all inventory (upgrades, legends, custom players)
  await db.delete(inventoryTable);

  // 3. Clear all season W/L records
  await db.delete(userRecordsTable);

  // 4. Clear all per-season upgrade purchase counts
  await db.delete(seasonStatsTable);

  // 5. Clear the game log (individual match history)
  await db.delete(gameLogTable);

  // 6. Reset user balances and season-specific fields
  //    Preserve: allTimeH2HWins, allTimeH2HLosses, allTimeSuperbowlWins, milestoneTierAwarded
  await db.update(usersTable).set({
    balance: 0,
    totalLegendPurchases: 0,
    playoffSeed: null,
    playoffConference: null,
    updatedAt: new Date(),
  });

  // 7. Deactivate all seasons and restart at Season 1 (clear any overrides)
  await db.update(seasonsTable).set({ isActive: false });
  const existing1 = await db.select().from(seasonsTable).where(eq(seasonsTable.seasonNumber, 1)).limit(1);
  if (existing1.length > 0) {
    await db.update(seasonsTable).set({
      isActive: true,
      currentWeek: "1",
      coreAttrCostOverride: null,
      coreAttrCapOverride: null,
      nonCoreAttrCostOverride: null,
      nonCoreAttrCapOverride: null,
      devUpsCapOverride: null,
      devUpsCostOverride: null,
      ageResetsCapOverride: null,
      ageResetsCostOverride: null,
      legendCostOverride: null,
      customGoldCostOverride: null,
      customSilverCostOverride: null,
      customBronzeCostOverride: null,
    }).where(eq(seasonsTable.seasonNumber, 1));
  } else {
    await db.insert(seasonsTable).values({ seasonNumber: 1, isActive: true });
  }

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🔄 Franchise Reset Complete")
        .setDescription(
          "The franchise cycle has ended and a new one has begun.\n\n" +
          `• **All legends** returned to the store (catalog preserved)\n` +
          `• **All coin balances** reset to 0\n` +
          `• **All inventory** cleared\n` +
          `• **All season W/L records** cleared\n` +
          `• **All upgrade purchase counts** cleared\n` +
          `• **Game log** cleared\n` +
          `• **All-time records preserved** (H2H wins/losses, SB wins, milestones)\n` +
          `• Season restarted at **Season 1**`
        )
        .setTimestamp(),
    ],
  });
}
