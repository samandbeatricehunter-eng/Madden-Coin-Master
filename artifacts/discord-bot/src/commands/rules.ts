import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";

// ── Rules Content ─────────────────────────────────────────────────────────────
// Edit the text here to update what the bot displays for each section.

const RULES: Record<string, { title: string; color: number; rules: string[] }> = {
  sportsmanship: {
    title: "🤝 Sportsmanship",
    color: Colors.Green,
    rules: [
      "Treat all league members with respect at all times.",
      "No trash talk that crosses into personal attacks — keep it competitive, not personal.",
      "Rage quitting or intentionally disconnecting to avoid a loss is not tolerated.",
      "Do not exploit glitches, cheese plays, or any mechanics considered unsportsmanlike by the league.",
      "Disputes must be brought to a commissioner — do not handle conflicts in public channels.",
      "Any member found to be acting in bad faith may be removed from the league.",
    ],
  },
  activity: {
    title: "📅 Activity",
    color: Colors.Blue,
    rules: [
      "All games must be completed by the weekly deadline set by the commissioner.",
      "Members must be reachable and responsive — check in at least every 48 hours during the season.",
      "If you cannot play your game on time, notify your opponent AND a commissioner as early as possible.",
      "Two unexcused missed deadlines in a season may result in replacement.",
      "CPU games are not a substitute for playing your opponent — schedule your games.",
      "If a member goes inactive without notice, their team may be simmed or reassigned.",
    ],
  },
  settings: {
    title: "⚙️ Settings",
    color: Colors.Yellow,
    rules: [
      "The league plays on [difficulty] with [quarter length] minute quarters.",
      "Injuries are set to [on/off]. Fatigue is set to [on/off].",
      "Home team controls stadium and weather settings — no extreme conditions without mutual agreement.",
      "All games are played on the default playbook unless both players agree otherwise.",
      "No pausing the game excessively to slow down momentum or frustrate your opponent.",
      "Any settings disputes should be reported to a commissioner before the game is played.",
    ],
  },
  "4th_down": {
    title: "4️⃣ 4th Down Rules",
    color: Colors.Orange,
    rules: [
      "Going for it on 4th down is allowed in all situations — no restrictions.",
      "However, repeatedly going for it on 4th down early in the game while blowing out an opponent is considered unsportsmanlike.",
      "Onside kicks are only allowed if you are trailing in the 4th quarter.",
      "Fake punts and fake field goals are always allowed.",
      "Use good judgment — if a commissioner rules a 4th down decision as poor sportsmanship, a warning may be issued.",
    ],
  },
  trade_policy: {
    title: "🔄 Trade Policy",
    color: Colors.Purple,
    rules: [
      "All trades must be submitted to the commissioner for review before being accepted in-game.",
      "Trades suspected of being collusion (intentionally unbalanced to benefit one team) will be vetoed.",
      "The trade deadline is set each season by the commissioner — no trades after the deadline.",
      "CPU trades are not allowed without commissioner approval.",
      "A trade vetoed by the commissioner is final — do not attempt to re-submit the same trade.",
      "Both parties must confirm a trade in the league Discord before it is submitted in-game.",
    ],
  },
  off_season: {
    title: "🏖️ Off-Season Rules",
    color: Colors.Fuchsia,
    rules: [
      "The draft order is determined by reverse standings (worst record picks first).",
      "Free agency begins after the draft — all signings must follow the salary cap rules.",
      "Salary cap penalties carry over from the previous season if applicable.",
      "Re-signing windows open before free agency — take advantage of these before your players hit the market.",
      "Fantasy draft rules apply if the league resets — all players are eligible regardless of previous team.",
      "Off-season coin purchases (attribute upgrades, dev ups, etc.) reset at the start of each new season.",
    ],
  },
};

// ── Command Definition ─────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("rules")
  .setDescription("Display a section of the league rules")
  .addStringOption(opt =>
    opt.setName("section")
      .setDescription("Which rules section to display?")
      .setRequired(true)
      .addChoices(
        { name: "Sportsmanship", value: "sportsmanship" },
        { name: "Activity", value: "activity" },
        { name: "Settings", value: "settings" },
        { name: "4th Down", value: "4th_down" },
        { name: "Trade Policy", value: "trade_policy" },
        { name: "Off-Season", value: "off_season" },
      )
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Tag a member to share this rule with them")
      .setRequired(false)
  );

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  const section = interaction.options.getString("section", true);
  const taggedUser = interaction.options.getUser("user");

  const content = RULES[section];
  if (!content) {
    await interaction.reply({ content: "❌ Unknown rules section.", ephemeral: true });
    return;
  }

  const rulesText = content.rules
    .map((rule, i) => `**${i + 1}.** ${rule}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(content.color)
    .setTitle(content.title)
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
