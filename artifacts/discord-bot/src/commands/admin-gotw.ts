import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser, addBalance, logTransaction, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

const PLAYOFF_WEEKS = ["wildcard", "divisional", "conference", "superbowl"];
export const GOTW_REGULAR_BONUS  = 5;
export const GOTW_PLAYOFF_BONUS  = 10;

export const data = new SlashCommandBuilder()
  .setName("admin-gotw")
  .setDescription("Award GOTW correct-guess bonuses in bulk (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o.setName("user1").setDescription("Correct guesser").setRequired(true))
  .addUserOption(o => o.setName("user2").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user3").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user4").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user5").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user6").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user7").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user8").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user9").setDescription("Correct guesser").setRequired(false))
  .addUserOption(o => o.setName("user10").setDescription("Correct guesser").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member       = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);
  const isPlayoff   = PLAYOFF_WEEKS.includes(currentWeek);
  const bonus       = isPlayoff ? GOTW_PLAYOFF_BONUS : GOTW_REGULAR_BONUS;
  const bonusLabel  = isPlayoff
    ? `+${bonus} coins (postseason — all games are GOTW)`
    : `+${bonus} coins (regular season)`;

  const users: any[] = [];
  for (let i = 1; i <= 10; i++) {
    const user = interaction.options.getUser(`user${i}`);
    if (!user) break;
    users.push(user);
  }

  if (users.length === 0) {
    await interaction.editReply({ content: "❌ No users provided." });
    return;
  }

  const lines: string[] = [];
  for (const user of users) {
    await addBalance(user.id, bonus);
    await logTransaction(user.id, bonus, "addcoins", `GOTW correct guess bonus — ${weekDisplay}`, interaction.user.id);
    lines.push(`✅ <@${user.id}> → +**${bonus} coins**`);
    try {
      const discordUser = await interaction.client.users.fetch(user.id);
      await discordUser.send(
        `🏈 **GOTW Correct Guess Bonus!** Your prediction for **${weekDisplay}**'s Game of the Week was correct!\n` +
        `**+${bonus} coins** added to your balance.`
      ).catch(() => {});
    } catch (_) {}
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 GOTW Correct Guess Bonuses Issued")
    .addFields(
      { name: "Week",      value: weekDisplay,  inline: true },
      { name: "Bonus",     value: bonusLabel,   inline: true },
      { name: "Recipients", value: lines.join("\n") },
    )
    .setFooter({ text: `Issued by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
