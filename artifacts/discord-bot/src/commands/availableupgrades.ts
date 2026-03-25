import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getLegendPurchaseHistory, getSeasonRules,
} from "../lib/db-helpers.js";
import { LIMITS } from "../lib/constants.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("availableupgrades")
  .setDescription("Check how many upgrades you (or another user) have used this season")
  // ── Optional admin lookup ─────────────────────────────────────────────────
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

  const targetUser = interaction.options.getUser("user");
  const teamName   = interaction.options.getString("team")?.trim();

  // If looking up someone else, require admin
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

  // Resolve the target
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
    await getOrCreateUser(discordId, username);
  } else {
    await getOrCreateUser(discordId, username);
  }

  const season = await getOrCreateActiveSeason();
  const stats  = await getSeasonStats(discordId, season.id);
  const rules  = await getSeasonRules(season);
  const legendHistory = await getLegendPurchaseHistory(discordId);

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

  const hasCapOverride = season.devUpsCapOverride !== null || season.ageResetsCapOverride !== null;
  const capNote = hasCapOverride ? " *(season override)*" : "";

  const label = lookupOther ? `${username}'s` : "Your";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 ${label} Upgrades — Season ${season.seasonNumber}`)
    .addFields(
      {
        name: "⚡ Core Attribute Upgrades",
        value:
          `Used: **${coreUsed}/${rules.coreAttrCap}** | Remaining: **${coreLeft}**\n` +
          `Cost: **${rules.coreAttrCost} coins/pt**\n` +
          `*(Speed, Acceleration, Agility, COD, Strength, Jumping, Throw Power, Awareness, Stamina)*${attrOverrideNote}`,
        inline: false,
      },
      {
        name: "🎯 Non-Core Attribute Upgrades",
        value:
          `Used: **${nonCoreUsed}/${rules.nonCoreAttrCap}** | Remaining: **${nonCoreLeft}**\n` +
          `Cost: **${rules.nonCoreAttrCost} coins/pt**\n` +
          `*(All other attributes)*`,
        inline: false,
      },
      {
        name: "📈 Dev Upgrades",
        value: `Used: **${stats.devUpsPurchased}/${rules.devUpsCap}** | Remaining: **${devUpsLeft}**${capNote}\nCost: **250 coins**`,
        inline: true,
      },
      {
        name: "🔄 Age Resets",
        value: `Used: **${stats.ageResetsPurchased}/${rules.ageResetsCap}** | Remaining: **${ageResetsLeft}**${capNote}\nCost: **250 coins**`,
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
