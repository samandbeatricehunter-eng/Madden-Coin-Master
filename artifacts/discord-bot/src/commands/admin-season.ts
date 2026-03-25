import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable, seasonStatsTable, inventoryTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logTransaction } from "../lib/db-helpers.js";

const MAX_SEASONS = 5;

export const data = new SlashCommandBuilder()
  .setName("season")
  .setDescription("Commissioner: Manage seasons")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("new")
      .setDescription("Advance to the next season (max 5 total)")
  )
  .addSubcommand(sub =>
    sub.setName("set")
      .setDescription("Jump directly to a specific season number (1–5)")
      .addIntegerOption(opt =>
        opt.setName("number")
          .setDescription("Season number to activate (1–5)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(MAX_SEASONS)
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
    sub.setName("setbalance")
      .setDescription("Set a user's coin balance")
      .addUserOption(opt => opt.setName("user").setDescription("The user").setRequired(true))
      .addIntegerOption(opt => opt.setName("amount").setDescription("New balance").setRequired(true).setMinValue(0))
  )
  .addSubcommand(sub =>
    sub.setName("override")
      .setDescription("Set attribute rule overrides for the current season (null = use defaults)")
      .addIntegerOption(opt =>
        opt.setName("attr_cost")
          .setDescription("Cost per attribute upgrade this season (default: 40)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("attr_cap")
          .setDescription("Max attribute upgrades allowed this season (default: 20)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addIntegerOption(opt =>
        opt.setName("speed_cap")
          .setDescription("Max Speed points allowed this season (default: 5)")
          .setRequired(false)
          .setMinValue(1)
      )
      .addBooleanOption(opt =>
        opt.setName("clear")
          .setDescription("Set to True to clear ALL overrides and restore defaults")
          .setRequired(false)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === "new") {
    const seasons = await db.select().from(seasonsTable).orderBy(sql`${seasonsTable.seasonNumber} DESC`).limit(1);
    const currentNumber = seasons[0]?.seasonNumber ?? 0;
    const nextNumber = currentNumber + 1;

    if (nextNumber > MAX_SEASONS) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("🏁 Franchise Complete")
            .setDescription(
              `This franchise has reached its **${MAX_SEASONS}-season limit**.\n\n` +
              `Season ${currentNumber} is the final season. No new seasons can be started.`
            ),
        ],
      });
    }

    await db.update(seasonsTable).set({ isActive: false });
    const [newSeason] = await db.insert(seasonsTable).values({ seasonNumber: nextNumber, isActive: true }).returning();

    const isLast = nextNumber === MAX_SEASONS;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(isLast ? Colors.Orange : Colors.Green)
          .setTitle(isLast ? "🏁 Final Season Started!" : "🎉 New Season Started!")
          .setDescription(
            `**Season ${newSeason!.seasonNumber} of ${MAX_SEASONS}** has begun!\n\n` +
            `All player inventories and purchase limits have been reset.\nCoin balances are unchanged.` +
            (isLast ? "\n\n⚠️ **This is the last season of the franchise.**" : "")
          )
          .setTimestamp(),
      ],
    });
  }

  if (sub === "set") {
    const targetNumber = interaction.options.getInteger("number", true);

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

    const isLast = targetNumber === MAX_SEASONS;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(isLast ? Colors.Orange : Colors.Blue)
          .setTitle(`📅 Season Set to ${targetNumber} of ${MAX_SEASONS}`)
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

    await logTransaction(target.id, amount, "season_adjustment", "Season coin adjustment by commissioner", interaction.user.id);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Coins Added")
          .setDescription(`Added **${amount.toLocaleString()} coins** to ${target.toString()}.`)
          .setTimestamp(),
      ],
    });
  }

  if (sub === "setbalance") {
    const target = interaction.options.getUser("user", true);
    const newAmount = interaction.options.getInteger("amount", true);

    const current = await db.select({ balance: usersTable.balance }).from(usersTable).where(eq(usersTable.discordId, target.id)).limit(1);
    const delta = newAmount - (current[0]?.balance ?? 0);

    await db.update(usersTable)
      .set({ balance: newAmount, updatedAt: new Date() })
      .where(eq(usersTable.discordId, target.id));

    await logTransaction(target.id, delta, "setbalance", `Balance set to ${newAmount.toLocaleString()} coins by commissioner`, interaction.user.id);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Balance Set")
          .setDescription(`Set ${target.toString()}'s balance to **${newAmount.toLocaleString()} coins**.`)
          .setTimestamp(),
      ],
    });
  }

  if (sub === "override") {
    const clear = interaction.options.getBoolean("clear") ?? false;

    // Fetch the active season
    const seasons = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
    const season = seasons[0];
    if (!season) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Active Season").setDescription("No active season found.")],
      });
    }

    if (clear) {
      await db.update(seasonsTable)
        .set({ attrCostOverride: null, attrCapOverride: null, speedCapOverride: null })
        .where(eq(seasonsTable.id, season.id));

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blue)
            .setTitle("🔄 Overrides Cleared — Season " + season.seasonNumber)
            .setDescription("All attribute overrides have been removed. Default rules are now active:\n• Attribute cost: **40 coins**\n• Attribute cap: **20/season**\n• Speed cap: **5/season**")
            .setTimestamp(),
        ],
      });
    }

    const attrCost  = interaction.options.getInteger("attr_cost");
    const attrCap   = interaction.options.getInteger("attr_cap");
    const speedCap  = interaction.options.getInteger("speed_cap");

    if (attrCost === null && attrCap === null && speedCap === null) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Nothing to Change").setDescription("Provide at least one override value, or use `clear: True` to restore defaults.")],
      });
    }

    const updates: Record<string, number | null> = {};
    if (attrCost  !== null) updates["attrCostOverride"]  = attrCost;
    if (attrCap   !== null) updates["attrCapOverride"]   = attrCap;
    if (speedCap  !== null) updates["speedCapOverride"]  = speedCap;

    await db.update(seasonsTable).set(updates as any).where(eq(seasonsTable.id, season.id));

    // Fetch fresh season to build the display
    const updated = await db.select().from(seasonsTable).where(eq(seasonsTable.id, season.id)).limit(1);
    const s = updated[0]!;

    const { COSTS, LIMITS } = await import("../lib/constants.js");
    const lines = [
      `**Attribute cost:** ${s.attrCostOverride !== null ? `~~${COSTS.attribute}~~ → **${s.attrCostOverride} coins** ⚠️ override` : `**${COSTS.attribute} coins** (default)`}`,
      `**Attribute cap:** ${s.attrCapOverride !== null ? `~~${LIMITS.attributesPerSeason}~~ → **${s.attrCapOverride}/season** ⚠️ override` : `**${LIMITS.attributesPerSeason}/season** (default)`}`,
      `**Speed cap:** ${s.speedCapOverride !== null ? `~~${LIMITS.speedPointsPerSeason}~~ → **${s.speedCapOverride}/season** ⚠️ override` : `**${LIMITS.speedPointsPerSeason}/season** (default)`}`,
    ];

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle(`⚙️ Season ${season.seasonNumber} Attribute Overrides Updated`)
          .setDescription(lines.join("\n") + "\n\n*These overrides apply only to this season. When a new season starts, defaults are restored automatically.*")
          .setTimestamp(),
      ],
    });
  }
}
