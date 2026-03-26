import {
  SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("setadmin")
  .setDescription("Manage bot-admin status for league members")
  .addSubcommand(sub =>
    sub.setName("grant")
      .setDescription("Grant bot-admin status to a user")
      .addUserOption(opt =>
        opt.setName("user").setDescription("The user to grant admin status").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("revoke")
      .setDescription("Revoke bot-admin status from a user")
      .addUserOption(opt =>
        opt.setName("user").setDescription("The user to revoke admin status from").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("List all current bot admins")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── List ───────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const admins = await db.select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
    })
      .from(usersTable)
      .where(eq(usersTable.isAdmin, true));

    if (admins.length === 0) {
      await interaction.reply({ content: "📋 No bot admins are currently set.", ephemeral: true });
      return;
    }

    const lines = admins.map((a, i) =>
      `${i + 1}. <@${a.discordId}> (${a.discordUsername})${a.team ? ` — ${a.team}` : ""}`
    );

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("🛡️ Bot Admins")
      .setDescription(lines.join("\n"))
      .setFooter({ text: `${admins.length} admin${admins.length === 1 ? "" : "s"}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── Grant / Revoke ────────────────────────────────────────────────────────
  const targetUser = interaction.options.getUser("user", true);
  const grantAdmin = sub === "grant";

  if (targetUser.id === interaction.user.id && !grantAdmin) {
    await interaction.reply({ content: "❌ You can't revoke your own admin status.", ephemeral: true });
    return;
  }

  const result = await db.update(usersTable)
    .set({ isAdmin: grantAdmin, updatedAt: new Date() })
    .where(eq(usersTable.discordId, targetUser.id))
    .returning({ discordUsername: usersTable.discordUsername });

  if (result.length === 0) {
    await interaction.reply({
      content: `❌ **${targetUser.username}** isn't registered in the league. They need to use a bot command first.`,
      ephemeral: true,
    });
    return;
  }

  const action = grantAdmin ? "granted ✅" : "revoked ❌";
  await interaction.reply({
    content: `🛡️ Bot-admin status **${action}** for **${targetUser.username}**.`,
    ephemeral: true,
  });
}
