/**
 * Routes the new menu_* navigation interactions:
 *   - menu_cat        (string select)  → show user category sub-page
 *   - menu_admin_cat  (string select)  → show admin category sub-page
 *   - menu_back       (button)         → return to main hub
 *   - menu_admin_back (button)         → return to admin hub
 *
 * All action buttons inside category pages use the existing ac_ / ao_ prefixed
 * IDs, so they continue to be handled by handleActionsInteraction /
 * handleAdminOperationsInteraction.
 */
import {
  ButtonInteraction, StringSelectMenuInteraction,
  PermissionFlagsBits,
} from "discord.js";
import {
  buildMenuHubEmbed, buildMenuHubRows,
  buildUserCategoryPage, buildAdminHubPage, buildAdminCategoryPage,
  buildMenuBannerAttachment,
  type UserCategoryId, type AdminCategoryId,
} from "./menu-hub.js";
import { getServerSettings } from "./server-settings.js";
import { getOrCreateActiveSeason, isAdminUser, getOrCreateUser, getSeasonRules } from "./db-helpers.js";
import { weekLabel } from "./week-helpers.js";
import { buildTransactionsEmbed } from "./user-stats-embed.js";

async function loadContext(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;
  const [settings, season, member, dbAdmin] = await Promise.all([
    getServerSettings(gid),
    getOrCreateActiveSeason(gid),
    interaction.guild?.members.fetch(uid).catch(() => null),
    isAdminUser(uid, gid),
  ]);
  const isAdmin =
    (member?.permissions.has(PermissionFlagsBits.Administrator) ?? false) || dbAdmin;
  return {
    settings,
    isAdmin,
    seasonNum: season.seasonNumber,
    weekStr: weekLabel(season.currentWeek),
  };
}

/** Returns true if the interaction was handled. */
export async function handleMenuSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (id !== "menu_cat" && id !== "menu_admin_cat") return false;

  const ctx = await loadContext(interaction);
  const value = interaction.values[0] ?? "";

  const VALID_USER_CATS: UserCategoryId[] = [
    "economy", "rosters", "league", "rankings", "payouts", "rules", "teams", "admin",
  ];
  const VALID_ADMIN_CATS: AdminCategoryId[] = [
    "week", "ao_payouts", "post", "league_data", "user_data", "store", "server", "troubleshoot",
  ];

  if (id === "menu_cat") {
    if (!VALID_USER_CATS.includes(value as UserCategoryId)) {
      await interaction.reply({ content: "❌ Unknown menu option (this menu may have expired).", ephemeral: true });
      return true;
    }
    if (value === "admin" && !ctx.isAdmin) {
      await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      return true;
    }
    const page = buildUserCategoryPage(
      value as UserCategoryId, ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr,
    );

    // Economy & Social — append the transactions/purchases embed.
    const embeds = [page.embed];
    if (value === "economy") {
      const gid = interaction.guildId!;
      const uid = interaction.user.id;
      try {
        const [user, season, member] = await Promise.all([
          getOrCreateUser(uid, interaction.user.username, gid),
          getOrCreateActiveSeason(gid),
          interaction.guild?.members.fetch(uid).catch(() => null),
        ]);
        const rules = await getSeasonRules(season);
        const displayName =
          (member as import("discord.js").GuildMember | null)?.nickname
            ?? interaction.user.displayName
            ?? interaction.user.username;
        void user; // user not needed by buildTransactionsEmbed
        const txEmbed = await buildTransactionsEmbed(
          uid, gid, season, ctx.settings, rules,
          interaction.user.displayAvatarURL(), displayName,
        );
        embeds.push(txEmbed);
      } catch (err) {
        console.error("[menu-router] Failed to build transactions embed for economy:", err);
      }
    }

    await interaction.update({ embeds, components: page.rows as any });
    return true;
  }

  // menu_admin_cat
  if (!ctx.isAdmin) {
    await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    return true;
  }
  if (!VALID_ADMIN_CATS.includes(value as AdminCategoryId)) {
    await interaction.reply({ content: "❌ Unknown admin option (this menu may have expired).", ephemeral: true });
    return true;
  }
  const page = buildAdminCategoryPage(value as AdminCategoryId, ctx.seasonNum, ctx.weekStr);
  await interaction.update({ embeds: [page.embed], components: page.rows as any });
  return true;
}

/** Returns true if the interaction was handled. */
export async function handleMenuButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (id !== "menu_back" && id !== "menu_admin_back") return false;

  const ctx = await loadContext(interaction);

  if (id === "menu_admin_back") {
    if (!ctx.isAdmin) {
      await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr);
    await interaction.update({ embeds: [page.embed], components: page.rows as any });
    return true;
  }

  // menu_back → main hub (banner + selector)
  await interaction.update({
    embeds:     [buildMenuHubEmbed(ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr)],
    components: buildMenuHubRows(ctx.settings, ctx.isAdmin) as any,
    files:      [buildMenuBannerAttachment()],
  });
  return true;
}
