import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { runWeeklyMatchupsFlow } from "../lib/weekly-matchups-runner.js";

const PLAYOFF_WEEKS = new Set(["wildcard", "divisional", "conference", "superbowl"]);

export const data = new SlashCommandBuilder()
  .setName("weeklymatchups")
  .setDescription("Admin: post this week's matchups publicly, clear GOTW channel, pay previous GOTW voters")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;

  const [season] = await db.select()
    .from(seasonsTable)
    .where(and(eq(seasonsTable.isActive, true), eq(seasonsTable.guildId, guildId)))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  const currentWeekStr = season.currentWeek ?? "1";
  const currentWeekNum = parseInt(currentWeekStr, 10);
  if (isNaN(currentWeekNum) || currentWeekNum < 1 || currentWeekNum > 18 || PLAYOFF_WEEKS.has(currentWeekStr.toLowerCase())) {
    await interaction.editReply({
      content: `⚠️ League is on **${currentWeekStr}** (not a regular-season week). Use \`/advanceweek\` first.`,
    });
    return;
  }

  await runWeeklyMatchupsFlow({
    client:          interaction.client,
    guild:           interaction.guild,
    season,
    guildId,
    displayWeekNum:  currentWeekNum,
    payoutWeekIndex: currentWeekNum > 1 ? currentWeekNum - 2 : null,
    replyFn: async ({ content, components }) => {
      await interaction.editReply({ content, components: components ?? [] });
    },
  });
}
