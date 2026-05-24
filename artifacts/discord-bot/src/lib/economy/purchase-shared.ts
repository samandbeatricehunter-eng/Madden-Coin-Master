/**
 * Shared helpers used across the individual purchase commands
 * (buy-legend, buy-attribute, buy-devup, buy-agereset, buy-customplayer).
 */

import {
  ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, franchiseRostersTable, franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { getGuildChannel, CHANNEL_KEYS } from "../db/db-helpers.js";
import { errorEmbed } from "../discord/embeds.js";

export const DEV_LABEL: Record<number, string> = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };

// ── Insufficient-funds reply ───────────────────────────────────────────────────
export function insufficientFunds(
  interaction: ChatInputCommandInteraction,
  cost: number,
  balance: number,
) {
  return interaction.editReply({
    embeds: [errorEmbed(
      "Insufficient Funds",
      `You need **${cost.toLocaleString()} coins** but only have **${balance.toLocaleString()} coins**. ` +
      `You're short by **${(cost - balance).toLocaleString()} coins**.`,
    )],
  });
}

// ── Commissioner notification ──────────────────────────────────────────────────
export async function sendCommissionerNotification(
  interaction: ChatInputCommandInteraction,
  type: string,
  purchaseId: number,
  details: Record<string, string | number | undefined>,
) {
  try {
    const gid = interaction.guildId!;

    // Route to the appropriate log channel based on purchase type
    const isUpgrade    = type === "dev_upgrade" || type === "age_reset" || type === "attribute"
      || type === "contract_extension" || type === "salary_reduction" || type === "bonus_reduction";
    const isDraftBuy   = type === "legend" || type.startsWith("custom_player");

    let channelId: string | null = null;
    if (isUpgrade) {
      channelId = await getGuildChannel(gid, CHANNEL_KEYS.UPGRADES_LOG)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER)
        ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? null;
    } else if (isDraftBuy) {
      channelId = await getGuildChannel(gid, CHANNEL_KEYS.DRAFT_PURCHASES_LOG)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER)
        ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? null;
    } else {
      channelId = await getGuildChannel(gid, CHANNEL_KEYS.TRANSACTION_LOG)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.TRANSACTIONS)
        ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER)
        ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? null;
    }
    if (!channelId) return;
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    let title        = "";
    let description  = "";
    let buttonLabel  = "✅ Mark as Applied";

    if (type === "legend") {
      title = "🏆 Legend Purchase Request";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        `**Legend:** ${details["legendName"]} (${details["legendPosition"]})`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Once you've added this player to the draft pool, click the button below to notify the member.",
      ].join("\n");
      buttonLabel = "✅ Added to Draft Pool";
    } else if (type === "dev_upgrade") {
      const costPer  = details["costPer"];
      const fromDev  = details["currentDevLabel"] ?? "?";
      const toDev    = details["devUpType"] ?? "?";
      title = "📈 Dev Upgrade Request";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Dev Level:** ${fromDev} → ${toDev}`,
        `**Cost:** ${costPer} coins`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].filter(Boolean).join("\n");
    } else if (type === "age_reset") {
      const costPer   = details["costPer"];
      const ageBefore = details["currentAge"] ? `${details["currentAge"]} → 23` : "→ 23";
      title = "🔄 Age Reset Request";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Age:** ${ageBefore}`,
        `**Cost:** ${costPer} coins`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].filter(Boolean).join("\n");
    } else if (type.startsWith("custom_player")) {
      title = `🎨 Custom Player Request — ${details["tier"]}`;
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Tier:** ${details["tier"]}`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].join("\n");
    } else if (type === "contract_extension") {
      title = "📝 Contract Extension Request (1YR)";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Cost:** ${details["costPer"]} coins`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].filter(Boolean).join("\n");
    } else if (type === "salary_reduction") {
      title = "💸 Salary Reduction Request";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Cost:** ${details["costPer"]} coins`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].filter(Boolean).join("\n");
    } else if (type === "bonus_reduction") {
      title = "💰 Bonus Reduction Request";
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
        `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
        `**Cost:** ${details["costPer"]} coins`,
        `**Purchase ID:** #${purchaseId}`,
        "",
        "Click the button below once this has been applied in-game.",
      ].filter(Boolean).join("\n");
    } else if (type.startsWith("training_")) {
      const tierLabel = type === "training_gold" ? "🥇 Gold" : type === "training_silver" ? "🥈 Silver" : "🥉 Bronze";
      const goalLabel = details["trainingGoal"] === "speed"    ? "⚡ Speed"
                      : details["trainingGoal"] === "power"    ? "💪 Power"
                      : details["trainingGoal"] === "position" ? "🎯 Position Focused"
                      : "⚖️ Balanced";
      const lotteryBlock = details["trainingResults"]
        ? String(details["trainingResults"])
        : details["attributeName"] ? `+${details["points"] ?? "?"} ${details["attributeName"]}` : "—";
      const applyLine = details["attributeName"]
        ? `Apply the above attribute upgrades to **${details["playerName"] ?? "their chosen player"}**.`
        : `Apply the training upgrades for **${details["playerName"] ?? "their chosen player"}**.`;
      title = `🎓 Training Package — ${tierLabel}`;
      description = [
        `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
        `**Tier:** ${tierLabel}`,
        details["trainingGoal"] ? `**Training Goal:** ${goalLabel}` : null,
        details["playerName"] ? `**Player:** ${details["playerName"]}${details["playerPos"] ? ` (${details["playerPos"]})` : ""}` : null,
        "",
        `**🎲 Lottery Results:**\n${lotteryBlock}`,
        "",
        `**Purchase ID:** #${purchaseId}`,
        "",
        applyLine,
      ].filter(v => v !== null).join("\n");
      buttonLabel = "✅ Applied in Game";
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_purchase:${purchaseId}:${interaction.user.id}:${type}`)
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`refund_purchase:${purchaseId}:${interaction.user.id}:${type}`)
        .setLabel("🔄 Refund")
        .setStyle(ButtonStyle.Danger),
    );

    await (channel as TextChannel).send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("Commissioner notification failed (purchase still completed):", err);
  }
}

// ── Roster row lookup (shared by autocomplete in devup / agereset / attribute) ─
export type RosterField = {
  position?: string;
  firstName?: string;
  lastName?: string;
  devTrait?: number;
  overall?: number;
  age?: number;
};

export async function getRosterRows<T extends Record<string, any>>(
  interaction: AutocompleteInteraction | ChatInputCommandInteraction,
  seasonId: number,
  fields: T,
): Promise<T[]> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  // Primary: direct discord_id match on roster rows (fastest, works after cascade)
  const baseWhere = and(
    eq(franchiseRostersTable.seasonId, seasonId),
    eq(franchiseRostersTable.discordId, userId),
  );
  const direct = await (db.select(fields).from(franchiseRostersTable).where(baseWhere) as any) as T[];
  if (direct.length > 0) return direct;

  // Fallback 1: look up team via discord_id on MCA teams — reliable, no name-matching needed.
  // Handles cases where roster rows weren't cascaded yet (e.g. team linked after roster import).
  const [teamByDiscord] = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      eq(franchiseMcaTeamsTable.discordId, userId),
    ))
    .limit(1);

  if (teamByDiscord) {
    const byTeam = await (db.select(fields).from(franchiseRostersTable).where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamId, teamByDiscord.teamId),
    )) as any) as T[];
    if (byTeam.length > 0) return byTeam;
  }

  // Fallback 2: resolve via team name stored in economy_users (handles edge cases
  // where the user's discord_id is not yet linked in franchise_mca_teams)
  const [userRow] = await db
    .select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, userId), eq(usersTable.guildId, guildId)))
    .limit(1);
  if (!userRow?.team) return [];

  const teamSearch  = userRow.team.trim();
  const teamEntries = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      or(
        ilike(franchiseMcaTeamsTable.fullName, `%${teamSearch}%`),
        ilike(franchiseMcaTeamsTable.nickName, `%${teamSearch}%`),
      ),
    ));
  if (teamEntries.length === 0) return [];

  const teamIds = teamEntries.map(t => t.teamId);
  return (db.select(fields).from(franchiseRostersTable).where(and(
    eq(franchiseRostersTable.seasonId, seasonId),
    teamIds.length === 1
      ? eq(franchiseRostersTable.teamId, teamIds[0]!)
      : sql`${franchiseRostersTable.teamId} = ANY(ARRAY[${sql.join(teamIds.map(id => sql`${id}`), sql`, `)}])`,
  )) as any) as T[];
}
