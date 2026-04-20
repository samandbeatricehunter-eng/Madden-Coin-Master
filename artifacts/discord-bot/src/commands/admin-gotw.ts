import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { runGotwPrompt, type MatchupsReplyFn } from "../lib/weekly-matchups-runner.js";
import { getRosterSeasonId } from "../lib/db-helpers.js";
import { franchiseMcaTeamsTable } from "@workspace/db";

export const data = new SlashCommandBuilder()
  .setName("admin-gotw")
  .setDescription("GOTW management commands (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── /admin-gotw post week:N ───────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("post")
      .setDescription("Re-trigger the GOTW selection prompt for a specific week")
      .addIntegerOption(o =>
        o.setName("week")
          .setDescription("Regular season week number (1–18)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(18)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member         = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── /admin-gotw post ──────────────────────────────────────────────────────
  if (sub === "post") {
    const weekNum  = interaction.options.getInteger("week", true);
    const weekIndex = weekNum - 1;

    const season = await getOrCreateActiveSeason(interaction.guildId!);

    const games = await db
      .select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  season.id),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      ));

    if (games.length === 0) {
      await interaction.editReply({
        content: `❌ No schedule found for Season ${season.seasonNumber} Week ${weekNum}. Run \`/franchiseupdate\` first.`,
      });
      return;
    }

    const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);
    const mcaTeams = await db
      .select({
        fullName:  franchiseMcaTeamsTable.fullName,
        nickName:  franchiseMcaTeamsTable.nickName,
        discordId: franchiseMcaTeamsTable.discordId,
      })
      .from(franchiseMcaTeamsTable)
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, rosterSeasonId),
        isNotNull(franchiseMcaTeamsTable.discordId),
      ));

    const teamToDiscord = new Map<string, string>();
    for (const t of mcaTeams) {
      if (t.discordId) {
        teamToDiscord.set(t.fullName.toLowerCase().trim(), t.discordId);
        teamToDiscord.set(t.nickName.toLowerCase().trim(), t.discordId);
      }
    }

    const replyFn: MatchupsReplyFn = async ({ content, components }) => {
      await interaction.editReply({ content, components: components ?? [] });
    };

    await runGotwPrompt({
      season,
      weekNum,
      teamToDiscord,
      games,
      baseContent: `📋 **GOTW Prompt — Season ${season.seasonNumber} Week ${weekNum}**`,
      replyFn,
    });

    return;
  }

}
