import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonStatTierConfigsTable, pendingEosPayoutsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateActiveSeason, getUserByDiscordId } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, evaluateTier } from "../lib/stat-categories.js";

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";

export const data = new SlashCommandBuilder()
  .setName("endofseasonpayout")
  .setDescription("Admin: calculate end-of-season tier payouts and post to commissioner log for approval")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o
    .setName("user")
    .setDescription("The Discord user (team owner) to pay out")
    .setRequired(true))
  .addNumberOption(o => o.setName("off_pass_yds").setDescription("Offensive Passing Yards (total)").setRequired(false))
  .addNumberOption(o => o.setName("off_rush_yds").setDescription("Offensive Rushing Yards (total)").setRequired(false))
  .addNumberOption(o => o.setName("off_pass_tds").setDescription("Offensive Passing TDs (total)").setRequired(false))
  .addNumberOption(o => o.setName("off_rush_tds").setDescription("Offensive Rushing TDs (total)").setRequired(false))
  .addNumberOption(o => o.setName("off_pts_scored").setDescription("Total Points Scored").setRequired(false))
  .addNumberOption(o => o.setName("off_redzone_pct").setDescription("Offensive Red Zone % (e.g. 68.5)").setRequired(false))
  .addNumberOption(o => o.setName("def_rush_yds").setDescription("Defensive Rushing Yards Allowed").setRequired(false))
  .addNumberOption(o => o.setName("def_pass_yds").setDescription("Defensive Passing Yards Allowed").setRequired(false))
  .addNumberOption(o => o.setName("def_ints").setDescription("Defensive Interceptions").setRequired(false))
  .addNumberOption(o => o.setName("def_redzone_pct").setDescription("Defensive Red Zone % Allowed (e.g. 42.1)").setRequired(false))
  .addNumberOption(o => o.setName("def_pts_allowed").setDescription("Total Points Allowed").setRequired(false))
  .addBooleanOption(o => o
    .setName("dry_run")
    .setDescription("Preview payout breakdown without posting to commissioner (default: false)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user", true);
  const dryRun     = interaction.options.getBoolean("dry_run") ?? false;

  const enteredStats: Record<string, number> = {};
  for (const cat of STAT_CATEGORIES) {
    const val = interaction.options.getNumber(cat.key);
    if (val != null) enteredStats[cat.key] = val;
  }

  if (Object.keys(enteredStats).length === 0) {
    await interaction.editReply({ content: "❌ Enter at least one stat value." });
    return;
  }

  const user = await getUserByDiscordId(targetUser.id);
  if (!user) {
    await interaction.editReply({
      content: `❌ <@${targetUser.id}> is not registered. Use \`/admin-setuser\` first.`,
    });
    return;
  }

  const season = await getOrCreateActiveSeason();

  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  const missingCategories: string[] = [];
  for (const cat of STAT_CATEGORIES) {
    if (!(cat.key in enteredStats)) continue;
    const tiers = tiersByCategory.get(cat.key) ?? [];
    const tierNums = new Set(tiers.map(t => t.tier));
    const missing = [1, 2, 3, 4].filter(n => !tierNums.has(n));
    if (missing.length > 0) {
      missingCategories.push(`**${cat.label}** — missing tiers: ${missing.join(", ")}`);
    }
  }

  if (missingCategories.length > 0) {
    await interaction.editReply({
      content:
        `❌ Some stat tier configs are not set for Season ${season.id}. ` +
        `Use \`/admin-set-stat-tier\` to configure:\n` +
        missingCategories.map(m => `• ${m}`).join("\n"),
    });
    return;
  }

  // ── Evaluate each stat ────────────────────────────────────────────────────
  type BreakdownRow = { label: string; statValue: number; unit: string; tier: number; coins: number };
  const breakdown: BreakdownRow[] = [];
  const displayLines: string[] = [];
  let totalCoins = 0;

  for (const cat of STAT_CATEGORIES) {
    if (!(cat.key in enteredStats)) continue;
    const statValue = enteredStats[cat.key]!;
    const tiers     = tiersByCategory.get(cat.key) ?? [];
    const result    = evaluateTier(tiers, statValue, cat.direction);

    if (result) {
      displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → Tier ${result.tier} (+${result.payout} coins)`);
      breakdown.push({ label: cat.label, statValue, unit: cat.unit, tier: result.tier, coins: result.payout });
      totalCoins += result.payout;
    } else {
      displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → No qualifying tier`);
    }
  }

  // ── Dry run: just show the preview ───────────────────────────────────────
  if (dryRun) {
    const embed = new EmbedBuilder()
      .setTitle("🧪 End-of-Season Payout — DRY RUN")
      .setColor(Colors.Yellow)
      .setDescription(
        `**Team:** <@${targetUser.id}> (${user.team ?? "No team set"})\n\n` +
        (displayLines.length ? displayLines.join("\n") : "*No stats entered.*"),
      )
      .addFields(
        { name: "Season",             value: `Season ${season.id}`, inline: true },
        { name: "Total Coins (if approved)", value: `${totalCoins}`,       inline: true },
        { name: "Mode",               value: "DRY RUN — no coins will be awarded", inline: true },
      )
      .setFooter({ text: "Run without dry_run=true to post for commissioner approval." })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Create pending payout record ─────────────────────────────────────────
  const [pending] = await db.insert(pendingEosPayoutsTable).values({
    discordId: targetUser.id,
    teamName:  user.team ?? null,
    seasonId:  season.id,
    statBreakdown: breakdown,
    totalCoins,
    status: "pending",
  }).returning();

  if (!pending) {
    await interaction.editReply({ content: "❌ Failed to create payout record. Please try again." });
    return;
  }

  // ── Build commissioner embed ──────────────────────────────────────────────
  const commEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏆 End-of-Season Payout — Pending Approval")
    .setDescription(
      `**Team:** <@${targetUser.id}> (${user.team ?? "No team set"})\n\n` +
      (displayLines.length ? displayLines.join("\n") : "*No qualifying tiers.*"),
    )
    .addFields(
      { name: "Season",      value: `Season ${season.id}`,          inline: true },
      { name: "Total Coins", value: `**${totalCoins.toLocaleString()} coins**`, inline: true },
      { name: "Status",      value: "⏳ Pending commissioner approval",          inline: false },
    )
    .setFooter({ text: `Payout ID: ${pending.id} • Calculated by ${interaction.user.username}` })
    .setTimestamp();

  const commRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`eos_approve:${pending.id}:${targetUser.id}`)
      .setLabel(`✅ Approve (${totalCoins} coins)`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`eos_edit:${pending.id}`)
      .setLabel("✏️ Edit Amount")
      .setStyle(ButtonStyle.Secondary),
  );

  // ── Post to commissioner channel ─────────────────────────────────────────
  let commMessageId: string | null = null;
  if (COMMISSIONER_CHANNEL_ID) {
    try {
      const ch = await interaction.client.channels.fetch(COMMISSIONER_CHANNEL_ID);
      if (ch?.isTextBased()) {
        const msg = await (ch as TextChannel).send({
          embeds: [commEmbed],
          components: [commRow],
        });
        commMessageId = msg.id;
        await db.update(pendingEosPayoutsTable)
          .set({ commissionerMessageId: msg.id })
          .where(eq(pendingEosPayoutsTable.id, pending.id));
      }
    } catch (err) { console.error("Failed to post EOS payout to commissioner channel:", err); }
  }

  const replyEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Payout Posted for Approval")
    .setDescription(
      `Payout for <@${targetUser.id}> (**${totalCoins} coins**) has been posted to the commissioner log.\n` +
      `A commissioner must click **Approve** before coins are awarded.` +
      (commMessageId ? "" : "\n⚠️ Could not reach the commissioner channel — check the channel ID."),
    )
    .addFields({ name: "Payout ID", value: `#${pending.id}`, inline: true })
    .setTimestamp();

  await interaction.editReply({ embeds: [replyEmbed] });
}
