import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable, seasonStatsTable, inventoryTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("season")
  .setDescription("Commissioner: Manage seasons")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("new")
      .setDescription("Start a new season (resets inventories and purchase counts, keeps coin balances)")
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
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === "new") {
    // Deactivate all current seasons
    await db.update(seasonsTable).set({ isActive: false });

    // Get current max season number
    const seasons = await db.select().from(seasonsTable).orderBy(sql`${seasonsTable.seasonNumber} DESC`).limit(1);
    const nextNumber = (seasons[0]?.seasonNumber ?? 0) + 1;

    const [newSeason] = await db.insert(seasonsTable).values({ seasonNumber: nextNumber, isActive: true }).returning();

    // NOTE: Inventories are tied to seasonId, so old inventory data remains for history.
    // New season means new inventory entries. Season stats are also tied to seasonId.

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("🎉 New Season Started!")
          .setDescription(`**Season ${newSeason!.seasonNumber}** has begun!\n\nAll player inventories and purchase limits have been reset.\nCoin balances are unchanged.`)
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
    const amount = interaction.options.getInteger("amount", true);

    await db.update(usersTable)
      .set({ balance: amount, updatedAt: new Date() })
      .where(eq(usersTable.discordId, target.id));

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Balance Set")
          .setDescription(`Set ${target.toString()}'s balance to **${amount.toLocaleString()} coins**.`)
          .setTimestamp(),
      ],
    });
  }
}
