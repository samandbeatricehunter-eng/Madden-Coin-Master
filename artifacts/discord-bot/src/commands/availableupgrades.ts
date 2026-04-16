import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, purchasesTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getLegendPurchaseHistory, getSeasonRules, getCoreAttributes,
} from "../lib/db-helpers.js";
import { LIMITS } from "../lib/constants.js";
import { getServerSettings } from "../lib/server-settings.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("availableupgrades")
  .setDescription("Check how many upgrades you (or another user) have used this season")
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Admin: look up another user's upgrade counts")
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("Admin: look up by NFL team name")
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    NFL_TEAMS.filter(t => t.toLowerCase().startsWith(focused)).slice(0, 25).map(t => ({ name: t, value: t }))
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }

  const targetUser = interaction.options.getUser("user");
  const teamName   = interaction.options.getString("team")?.trim();

  const lookupOther = targetUser || teamName;
  if (lookupOther) {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const isAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
    if (!isAdmin) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Admin Only").setDescription("Only commissioners can look up other users' upgrade counts.")],
      });
    }
  }

  let discordId = interaction.user.id;
  let username  = interaction.user.username;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Team Not Found").setDescription(`No user is assigned to **${teamName}**.`)],
      });
    }
    discordId = found.discordId;
    username  = found.discordUsername;
  } else if (targetUser) {
    discordId = targetUser.id;
    username  = targetUser.username;
    await getOrCreateUser(discordId, username, interaction.guildId!);
  } else {
    await getOrCreateUser(discordId, username, interaction.guildId!);
  }

  const season  = await getOrCreateActiveSeason(interaction.guildId!);
  const stats   = await getSeasonStats(discordId, season.id);
  const rules   = await getSeasonRules(season);
  const coreSet = getCoreAttributes(season);
  const legendHistory = await getLegendPurchaseHistory(discordId);

  // ── Fetch all non-refunded attribute purchases for this user this season ────
  const attrPurchases = await db
    .select({
      playerName:    purchasesTable.playerName,
      playerPosition: purchasesTable.playerPosition,
      attributeName: purchasesTable.attributeName,
    })
    .from(purchasesTable)
    .where(and(
      eq(purchasesTable.discordId, discordId),
      eq(purchasesTable.seasonId, season.id),
      eq(purchasesTable.purchaseType, "attribute"),
      ne(purchasesTable.status, "refunded"),
    ));

  // ── Build per-player core attribute usage map ────────────────────────────────
  // playerKey → Set of core attr names already used
  const playerCoreUsed = new Map<string, { label: string; usedCores: Set<string> }>();
  for (const row of attrPurchases) {
    if (!row.playerName || !row.attributeName) continue;
    if (!coreSet.has(row.attributeName as any)) continue;

    const key   = `${row.playerName}||${row.playerPosition ?? ""}`;
    const label = row.playerPosition ? `${row.playerName} (${row.playerPosition})` : row.playerName;
    if (!playerCoreUsed.has(key)) {
      playerCoreUsed.set(key, { label, usedCores: new Set() });
    }
    playerCoreUsed.get(key)!.usedCores.add(row.attributeName);
  }

  const coreUsed    = stats.coreAttrPurchased;
  const coreLeft    = Math.max(0, rules.coreAttrCap - coreUsed);
  const nonCoreUsed = stats.nonCoreAttrPurchased;
  const nonCoreLeft = Math.max(0, rules.nonCoreAttrCap - nonCoreUsed);
  const devUpsLeft  = Math.max(0, rules.devUpsCap - stats.devUpsPurchased);
  const ageResetsLeft = Math.max(0, rules.ageResetsCap - stats.ageResetsPurchased);
  const legendsLeft = Math.max(0, LIMITS.legendsAllTime - legendHistory.total);

  const hasAttrOverride = season.coreAttrCostOverride !== null || season.coreAttrCapOverride !== null ||
                          season.nonCoreAttrCostOverride !== null || season.nonCoreAttrCapOverride !== null;
  const attrOverrideNote = hasAttrOverride ? "\n⚠️ *Custom attribute rules are active this season.*" : "";

  const hasDevOverride    = season.devUpsCapOverride !== null || season.devUpsCostOverride !== null;
  const hasAgeResOverride = season.ageResetsCapOverride !== null || season.ageResetsCostOverride !== null;
  const devNote    = hasDevOverride    ? " *(season override)*" : "";
  const ageResNote = hasAgeResOverride ? " *(season override)*" : "";

  const label = lookupOther ? `${username}'s` : "Your";

  // ── Per-player core attr breakdown text ──────────────────────────────────────
  let coreBreakdown = "";
  if (playerCoreUsed.size > 0) {
    const lines = [...playerCoreUsed.values()].map(({ label: pLabel, usedCores }) => {
      const used = [...usedCores].join(", ");
      return `> 📌 **${pLabel}**: ${used}`;
    });
    coreBreakdown = `\n\n**Already upgraded this season (locked):**\n${lines.join("\n")}`;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 ${label} Upgrades — Season ${season.seasonNumber}`)
    .addFields(
      {
        name: "⭐ Core Attribute Upgrades",
        value:
          `Used: **${coreUsed}/${rules.coreAttrCap}** | Remaining: **${coreLeft}**\n` +
          `Cost: **${rules.coreAttrCost} coins/pt** · Limit: **1pt per attribute per player per season**\n` +
          `*(Speed, Accel, Agility, COD, Strength, Jumping, Throw Power, Awareness, Stamina)*` +
          attrOverrideNote +
          coreBreakdown,
        inline: false,
      },
      {
        name: "🎯 Non-Core Attribute Upgrades",
        value:
          `Used: **${nonCoreUsed}/${rules.nonCoreAttrCap}** | Remaining: **${nonCoreLeft}**\n` +
          `Cost: **${rules.nonCoreAttrCost} coins/pt**\n` +
          `*(All other attributes — up to 10 pts per purchase)*`,
        inline: false,
      },
      {
        name: "📈 Dev Upgrades",
        value: `Used: **${stats.devUpsPurchased}/${rules.devUpsCap}** | Remaining: **${devUpsLeft}**${devNote}\nCost: **${rules.devUpsCost} coins**`,
        inline: true,
      },
      {
        name: "🔄 Age Resets",
        value: `Used: **${stats.ageResetsPurchased}/${rules.ageResetsCap}** | Remaining: **${ageResetsLeft}**${ageResNote}\nCost: **${rules.ageResetCost} coins**`,
        inline: true,
      },
      {
        name: "🏆 Legend Purchases (All Time)",
        value: `Used: **${legendHistory.total}/${LIMITS.legendsAllTime}** | Remaining: **${legendsLeft}**`,
        inline: false,
      },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
