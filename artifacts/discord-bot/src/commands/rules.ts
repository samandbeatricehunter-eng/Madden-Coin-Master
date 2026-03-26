import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
} from "discord.js";
import { getOrSeedRules, SECTION_META } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("rules")
  .setDescription("Display a section of the league rules")
  .addStringOption(opt =>
    opt.setName("section")
      .setDescription("Which rules section to display?")
      .setRequired(true)
      .addChoices(
        { name: "Sportsmanship", value: "sportsmanship" },
        { name: "Activity",      value: "activity" },
        { name: "Settings",      value: "settings" },
        { name: "4th Down",      value: "4th_down" },
        { name: "Trade Policy",  value: "trade_policy" },
        { name: "Off-Season",    value: "off_season" },
      )
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Tag a member to share this rule with them")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const section = interaction.options.getString("section", true);
  const taggedUser = interaction.options.getUser("user");

  const meta = SECTION_META[section];
  if (!meta) {
    await interaction.reply({ content: "❌ Unknown rules section.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(section);
  const rulesText = rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n") || "_No rules have been set for this section yet._";

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(meta.title)
    .setDescription(rulesText)
    .setFooter({ text: "REC League • Use /rules to view any section" })
    .setTimestamp();

  const mention = taggedUser ? `${taggedUser.toString()} — here's the relevant rule:\n` : "";
  const isPublic = !!taggedUser;

  await interaction.reply({
    content: mention || undefined,
    embeds: [embed],
    ephemeral: !isPublic,
  });
}
