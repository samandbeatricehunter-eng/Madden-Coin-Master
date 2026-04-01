import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonStatTierConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { addBalance, logTransaction, getOrCreateActiveSeason, getUserByDiscordId } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, evaluateTier } from "../lib/stat-categories.js";

// ── Command ─────────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("endofseasonpayout")
  .setDescription("Admin: manually enter a team's end-of-season stats and issue tier-based payouts")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── Team selection ─────────────────────────────────────────────────────────
  .addUserOption(o => o
    .setName("user")
    .setDescription("The Discord user (team owner) to pay out")
    .setRequired(true))
  // ── Offensive stats ────────────────────────────────────────────────────────
  .addNumberOption(o => o
    .setName("off_pass_yds")
    .setDescription("Offensive Passing Yards (total)")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("off_rush_yds")
    .setDescription("Offensive Rushing Yards (total)")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("off_pass_tds")
    .setDescription("Offensive Passing TDs (total)")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("off_rush_tds")
    .setDescription("Offensive Rushing TDs (total)")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("off_pts_scored")
    .setDescription("Total Points Scored")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("off_redzone_pct")
    .setDescription("Offensive Red Zone % (e.g. 68.5)")
    .setRequired(false))
  // ── Defensive stats ────────────────────────────────────────────────────────
  .addNumberOption(o => o
    .setName("def_rush_yds")
    .setDescription("Defensive Rushing Yards Allowed")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("def_pass_yds")
    .setDescription("Defensive Passing Yards Allowed")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("def_ints")
    .setDescription("Defensive Interceptions")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("def_redzone_pct")
    .setDescription("Defensive Red Zone % Allowed (e.g. 42.1)")
    .setRequired(false))
  .addNumberOption(o => o
    .setName("def_pts_allowed")
    .setDescription("Total Points Allowed")
    .setRequired(false))
  // ── Options ────────────────────────────────────────────────────────────────
  .addBooleanOption(o => o
    .setName("dry_run")
    .setDescription("Preview payouts without awarding coins (default: false)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user", true);
  const dryRun     = interaction.options.getBoolean("dry_run") ?? false;

  // ── Collect entered stat values ──────────────────────────────────────────
  const enteredStats: Record<string, number> = {};
  for (const cat of STAT_CATEGORIES) {
    const val = interaction.options.getNumber(cat.key);
    if (val != null) enteredStats[cat.key] = val;
  }

  if (Object.keys(enteredStats).length === 0) {
    await interaction.editReply({
      content: "❌ You must enter at least one stat value. All fields are optional but at least one is required.",
    });
    return;
  }

  // ── Look up user in DB ───────────────────────────────────────────────────
  const user = await getUserByDiscordId(targetUser.id);
  if (!user) {
    await interaction.editReply({
      content: `❌ <@${targetUser.id}> is not registered in the bot. Use \`/admin-setuser\` to register them first.`,
    });
    return;
  }

  const season = await getOrCreateActiveSeason();

  // ── Load tier configs ────────────────────────────────────────────────────
  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  // Validate that all entered categories have tiers configured
  const missingCategories: string[] = [];
  for (const cat of STAT_CATEGORIES) {
    if (!(cat.key in enteredStats)) continue; // not entered, skip
    const tiers = tiersByCategory.get(cat.key) ?? [];
    const tierNums = new Set(tiers.map(t => t.tier));
    const missingTiers = [1, 2, 3, 4].filter(n => !tierNums.has(n));
    if (missingTiers.length > 0) {
      missingCategories.push(`**${cat.label}** — missing tiers: ${missingTiers.join(", ")}`);
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

  // ── Evaluate each entered stat ───────────────────────────────────────────
  const resultLines: string[] = [];
  let totalCoins = 0;
  const txnDetails: string[] = [];

  for (const cat of STAT_CATEGORIES) {
    if (!(cat.key in enteredStats)) continue;

    const statValue = enteredStats[cat.key];
    const tiers     = tiersByCategory.get(cat.key) ?? [];
    const result    = evaluateTier(tiers, statValue, cat.direction);

    if (result) {
      resultLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → Tier ${result.tier} (+${result.payout} coins)`);
      txnDetails.push(`${cat.label}: ${statValue} ${cat.unit} → Tier ${result.tier} (+${result.payout})`);
      totalCoins += result.payout;
    } else {
      resultLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → No qualifying tier`);
    }
  }

  // ── Issue payout ─────────────────────────────────────────────────────────
  if (totalCoins > 0 && !dryRun) {
    await addBalance(user.discordId, totalCoins);
    await logTransaction(
      user.discordId, totalCoins, "addcoins",
      `End-of-season stat bonus (Season ${season.id}): ${txnDetails.join(" | ")}`,
    );
  }

  // ── Build result embed ───────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(dryRun ? "🧪 End-of-Season Payout — DRY RUN" : "🏆 End-of-Season Payout Issued!")
    .setColor(dryRun ? Colors.Yellow : Colors.Gold)
    .setDescription(
      `**Team:** <@${targetUser.id}> (${user.team ?? "No team set"})\n\n` +
      (resultLines.length ? resultLines.join("\n") : "*No stats entered.*"),
    )
    .addFields(
      { name: "Season",             value: `Season ${season.id}`,                        inline: true },
      { name: "Total Coins Earned", value: `${totalCoins}`,                               inline: true },
      { name: "Mode",               value: dryRun ? "DRY RUN (no coins awarded)" : "LIVE", inline: true },
    )
    .setFooter({ text: dryRun ? "Run without dry_run=true to award coins." : "Coins have been added to their balance." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
