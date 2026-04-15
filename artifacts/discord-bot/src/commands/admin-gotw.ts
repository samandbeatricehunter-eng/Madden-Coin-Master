import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, usersTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { isAdminUser, addBalance, logTransaction, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { runGotwPrompt, type MatchupsReplyFn } from "../lib/weekly-matchups-runner.js";
import { getRosterSeasonId } from "../lib/db-helpers.js";
import { franchiseMcaTeamsTable } from "@workspace/db";

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
  // ── /admin-gotw payout user1…user24 [all] ────────────────────────────────
  .addSubcommand(sub => {
    sub
      .setName("payout")
      .setDescription("Award GOTW correct-guess bonuses in bulk (up to 24 users, or use 'all' to pay everyone)")
      .addBooleanOption(o =>
        o.setName("all")
          .setDescription("Pay every registered member currently linked to a team")
          .setRequired(false)
      );
    for (let i = 1; i <= 24; i++) {
      sub.addUserOption(o =>
        o.setName(`user${i}`)
          .setDescription("Correct guesser")
          .setRequired(false)
      );
    }
    return sub;
  });

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

  // ── /admin-gotw payout  (also handles routing from /admin payout_gotw) ───
  if (sub === "payout" || sub === "payout_gotw") {
    const season      = await getOrCreateActiveSeason(interaction.guildId!);
    const currentWeek = (season as any).currentWeek ?? "1";
    const weekDisplay = weekLabel(currentWeek);
    const isPlayoff   = PLAYOFF_WEEKS.includes(currentWeek);
    const bonus       = await getPayoutValue(isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS);
    const bonusLabel  = isPlayoff
      ? `+${bonus} coins (postseason — all games are GOTW)`
      : `+${bonus} coins (regular season)`;

    const payAll = interaction.options.getBoolean("all") ?? false;

    let recipients: { id: string }[] = [];

    if (payAll) {
      // Fetch every registered member linked to a real team (not a placeholder)
      const rows = await db
        .select({ discordId: usersTable.discordId })
        .from(usersTable)
        .where(and(
          eq(usersTable.guildId, interaction.guildId!),
          isNotNull(usersTable.team),
        ));
      recipients = rows
        .filter(r => !r.discordId.startsWith("unlinked_"))
        .map(r => ({ id: r.discordId }));

      if (recipients.length === 0) {
        await interaction.editReply({ content: "❌ No registered members are currently linked to a team." });
        return;
      }
    } else {
      for (let i = 1; i <= 24; i++) {
        const user = interaction.options.getUser(`user${i}`);
        if (!user) break;
        recipients.push(user);
      }
      if (recipients.length === 0) {
        await interaction.editReply({ content: "❌ No users provided. Specify at least one user or set `all: True`." });
        return;
      }
    }

    const lines: string[] = [];
    for (const recipient of recipients) {
      await addBalance(recipient.id, bonus, interaction.guildId!);
      await logTransaction(recipient.id, bonus, "addcoins", `GOTW correct guess bonus — ${weekDisplay}`, interaction.guildId!, interaction.user.id);
      lines.push(`✅ <@${recipient.id}> → +**${bonus} coins**`);
      try {
        const discordUser = await interaction.client.users.fetch(recipient.id);
        await discordUser.send(
          `🏈 **GOTW Correct Guess Bonus!** Your prediction for **${weekDisplay}**'s Game of the Week was correct!\n` +
          `**+${bonus} coins** added to your balance.`
        ).catch(() => {});
      } catch (_) {}
    }

    // Split the recipients list if it's too long for one embed field
    const MAX_FIELD_LEN = 1024;
    const chunks: string[][] = [[]];
    for (const line of lines) {
      const current = chunks[chunks.length - 1]!;
      if ((current.join("\n") + "\n" + line).length > MAX_FIELD_LEN) {
        chunks.push([line]);
      } else {
        current.push(line);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🏈 GOTW Correct Guess Bonuses Issued")
      .addFields(
        { name: "Week",  value: weekDisplay, inline: true },
        { name: "Bonus", value: bonusLabel,  inline: true },
        { name: "Mode",  value: payAll ? "All linked members" : `${recipients.length} selected user(s)`, inline: true },
      );

    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({
        name: chunks.length === 1 ? "Recipients" : `Recipients (${i + 1}/${chunks.length})`,
        value: chunks[i]!.join("\n"),
      });
    }

    embed
      .setFooter({ text: `Issued by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
