import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, addBalance, logTransaction, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { runGotwPrompt, type MatchupsReplyFn } from "../lib/weekly-matchups-runner.js";
import { getRosterSeasonId } from "../lib/db-helpers.js";
import { franchiseMcaTeamsTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";

const PLAYOFF_WEEKS = ["wildcard", "divisional", "conference", "superbowl"];

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
  )
  // ── /admin-gotw payout user1…user10 ──────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("payout")
      .setDescription("Award GOTW correct-guess bonuses in bulk")
      .addUserOption(o => o.setName("user1").setDescription("Correct guesser").setRequired(true))
      .addUserOption(o => o.setName("user2").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user3").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user4").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user5").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user6").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user7").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user8").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user9").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user10").setDescription("Correct guesser").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member         = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── /admin-gotw post ──────────────────────────────────────────────────────
  if (sub === "post") {
    const weekNum  = interaction.options.getInteger("week", true);
    const weekIndex = weekNum - 1;

    const season = await getOrCreateActiveSeason();

    // Fetch schedule games for the requested week
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

    // Build team→discordId from franchise_mca_teams (fullName + nickName)
    const rosterSeasonId = await getRosterSeasonId();
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

  // ── /admin-gotw payout ────────────────────────────────────────────────────
  if (sub === "payout") {
    const season      = await getOrCreateActiveSeason();
    const currentWeek = (season as any).currentWeek ?? "1";
    const weekDisplay = weekLabel(currentWeek);
    const isPlayoff   = PLAYOFF_WEEKS.includes(currentWeek);
    const bonus       = await getPayoutValue(isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS);
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
        { name: "Week",       value: weekDisplay,  inline: true },
        { name: "Bonus",      value: bonusLabel,   inline: true },
        { name: "Recipients", value: lines.join("\n") },
      )
      .setFooter({ text: `Issued by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
