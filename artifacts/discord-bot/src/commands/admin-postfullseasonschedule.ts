import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { postFullSeasonScheduleToChannel } from "../lib/season-schedule-post.js";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("postfullseasonschedule")
  .setDescription("Admin: post the full 18-week season schedule to the schedule channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  await interaction.editReply({ content: "📤 Posting schedule…" });

  try {
    const postedWeeks = await postFullSeasonScheduleToChannel(
      interaction.client,
      season.id,
      season.seasonNumber ?? season.id,
    );

    if (postedWeeks === 0) {
      await interaction.editReply({
        content: "📭 No schedule data found. Run `/franchiseupdate` first to import the schedule.",
      });
    } else {
      await interaction.editReply({
        content: `✅ Posted **${postedWeeks} weeks** of schedule.`,
      });
    }
  } catch (err) {
    console.error("[postfullseasonschedule] Error:", err);
    await interaction.editReply({
      content: `❌ Failed to post schedule: ${err}`,
    });
  }
}
