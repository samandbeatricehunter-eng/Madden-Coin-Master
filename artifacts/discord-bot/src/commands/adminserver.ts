import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";
import {
  getServerSettings, buildSettingsEmbed, buildSettingsRows,
} from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("adminserver")
  .setDescription("Server administration commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("server_bot_settings")
      .setDescription("Toggle server features on/off (coin economy, store items, wagers, trade block)")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "server_bot_settings") {
    const member        = interaction.guild?.members.cache.get(interaction.user.id)
      ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
    const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

    if (!isDiscordAdmin && !isDbAdmin) {
      await interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });
      return;
    }

    const settings = await getServerSettings();
    await interaction.reply({
      embeds:     [buildSettingsEmbed(settings)],
      components: buildSettingsRows(settings),
      ephemeral:  true,
    });
  }
}
