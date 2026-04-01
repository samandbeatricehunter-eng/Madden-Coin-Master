import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("webhookurl")
  .setDescription("Admin: show the Madden Companion App export URL for this league")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const key = process.env["MADDEN_WEBHOOK_KEY"] ?? "(not set)";

  // REPLIT_DOMAINS contains the deployed domain (e.g. "abc.replit.app").
  // We strip any protocol prefix and trailing slashes for a clean URL.
  const rawDomain = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim() ?? "";
  const domain    = rawDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const baseUrl = domain
    ? `https://${domain}/api/madden/${key}`
    : `https://<your-replit-domain>/api/madden/${key}`;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("📡 Madden Companion App — Export URL")
    .setDescription(
      [
        "Enter this URL in the **Madden Companion App** before each export:",
        "",
        `\`\`\`${baseUrl}\`\`\``,
        "",
        "**How to export:**",
        "1. Open Madden → Settings → Madden Companion App",
        "2. Enter the URL above as the **Export URL**",
        "3. Tap **Export** for each data category (Teams, Schedule, Stats, Scores)",
        "4. The bot will process and post results automatically",
        "",
        "Payouts, records, and stats update instantly — no ZIP needed.",
      ].join("\n")
    )
    .setFooter({ text: "URL is static — the same every week" });

  return interaction.editReply({ embeds: [embed] });
}
