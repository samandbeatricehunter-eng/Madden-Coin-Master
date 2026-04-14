import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser, addBalance, logTransaction, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const POTW_BONUS = 10;

export const data = new SlashCommandBuilder()
  .setName("admin-potw")
  .setDescription("Award Player of the Week bonus — 1 to 4 players, +10 coins each (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o.setName("player1").setDescription("POTW recipient").setRequired(true))
  .addUserOption(o => o.setName("player2").setDescription("POTW recipient").setRequired(false))
  .addUserOption(o => o.setName("player3").setDescription("POTW recipient").setRequired(false))
  .addUserOption(o => o.setName("player4").setDescription("POTW recipient").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member       = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const season      = await getOrCreateActiveSeason(interaction.guildId!);
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);

  const players: any[] = [];
  for (let i = 1; i <= 4; i++) {
    const user = interaction.options.getUser(`player${i}`);
    if (!user) break;
    players.push(user);
  }

  if (players.length === 0) {
    await interaction.editReply({ content: "❌ No players provided." });
    return;
  }

  const lines: string[] = [];
  for (const user of players) {
    await addBalance(user.id, POTW_BONUS, interaction.guildId!);
    await logTransaction(user.id, POTW_BONUS, "addcoins", `Player of the Week bonus — ${weekDisplay}`, interaction.guildId!, interaction.user.id);
    lines.push(`🌟 <@${user.id}> → +**${POTW_BONUS} coins**`);
    try {
      const discordUser = await interaction.client.users.fetch(user.id);
      await discordUser.send(
        `🌟 **Player of the Week!** You've been selected as a POTW award winner for **${weekDisplay}**!\n` +
        `**+${POTW_BONUS} coins** have been added to your balance. Keep balling out! 🏈`
      ).catch(() => {});
    } catch (_) {}
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🌟 Player of the Week Awards Issued")
    .addFields(
      { name: "Week",       value: weekDisplay,           inline: true },
      { name: "Bonus Each", value: `+${POTW_BONUS} coins`, inline: true },
      { name: "Recipients", value: lines.join("\n") },
    )
    .setFooter({ text: `Issued by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
