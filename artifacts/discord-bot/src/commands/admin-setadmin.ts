import {
  SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("setadmin")
  .setDescription("Grant or revoke bot-admin status for a user")
  .addUserOption(opt =>
    opt.setName("user").setDescription("The user to grant or revoke admin status").setRequired(true)
  )
  .addBooleanOption(opt =>
    opt.setName("admin").setDescription("true = grant admin, false = revoke admin").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const grantAdmin = interaction.options.getBoolean("admin", true);

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
