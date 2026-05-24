/**
 * Routes the new menu_* navigation interactions:
 *   - menu_cat          (string select) → navigate or dispatch a leaf action
 *   - menu_admin_cat    (string select) → show admin category sub-page
 *   - menu_unlinked_cat (string select) → unlinked-user flat categories
 *   - menu_back         (button)        → return to main hub (from admin sub-pages)
 *   - menu_admin_back   (button)        → return to admin hub
 *
 * Leaf action options re-dispatch to handleActionsInteraction(interaction, overrideId).
 */
import {
  ButtonInteraction, StringSelectMenuInteraction,
  PermissionFlagsBits,
} from "discord.js";
import {
  buildMenuHubEmbed, buildMenuHubRows,
  buildBranchPage, buildAdminHubPage, buildAdminCategoryPage,
  buildUnlinkedCategoryPage,
  buildUnlinkedMenuEmbed, buildUnlinkedMenuRows,
  buildMenuBannerAttachment,
  findNode,
  MENU_HOME_VALUE, MENU_ADMIN_HOME_VALUE, MENU_UNLINKED_HOME_VALUE,
  type AdminCategoryId, type MenuCtx,
} from "./menu-hub.js";
import { getServerSettings } from "../db/server-settings.js";
import { getOrCreateActiveSeason, isAdminUser, getOrCreateUser, getSeasonRules } from "../db/db-helpers.js";
import { weekLabel } from "../helpers/week-helpers.js";
import { buildTransactionsEmbed } from "../discord/user-stats-embed.js";
import { handleActionsInteraction } from "../handlers/actions-handlers.js";

const COMMISSIONER_ROLE_NAME = "Commissioner";

async function loadContext(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<MenuCtx> {
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
  const isCommissioner =
    member?.roles.cache.some((r) => r.name === COMMISSIONER_ROLE_NAME) ?? false;
  return {
    settings,
    isAdmin,
    isCommissioner,
    seasonNum: season.seasonNumber,
    weekStr: weekLabel(season.currentWeek),
  };
}

/** Returns true if the interaction was handled. */
export async function handleMenuSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (id !== "menu_cat" && id !== "menu_admin_cat" && id !== "menu_unlinked_cat") return false;

  const ctx = await loadContext(interaction);
  const value = interaction.values[0] ?? "";

  // ── Unlinked user flat categories ─────────────────────────────────────────
  if (id === "menu_unlinked_cat") {
    if (value === MENU_UNLINKED_HOME_VALUE) {
      await interaction.update({
        embeds:     [buildUnlinkedMenuEmbed(ctx.seasonNum, ctx.weekStr)],
        components: buildUnlinkedMenuRows() as any,
        files:      [buildMenuBannerAttachment()],
      });
      return true;
    }
    const ok = ["teams", "rosters", "league", "rankings", "rules"] as const;
    type UnlinkedCat = (typeof ok)[number];
    if (!ok.includes(value as UnlinkedCat)) {
      await interaction.reply({ content: "❌ Unknown menu option (this menu may have expired).", ephemeral: true });
      return true;
    }
    const page = buildUnlinkedCategoryPage(value as UnlinkedCat, ctx);
    await interaction.update({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  // ── Admin nested category selector (existing flow) ────────────────────────
  if (id === "menu_admin_cat") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.reply({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const validAdmin: AdminCategoryId[] = [
      "week", "ao_payouts", "post", "league_data", "user_data", "store", "server", "troubleshoot",
    ];
    if (!validAdmin.includes(value as AdminCategoryId)) {
      await interaction.reply({ content: "❌ Unknown admin option (this menu may have expired).", ephemeral: true });
      return true;
    }
    const page = buildAdminCategoryPage(value as AdminCategoryId, ctx.seasonNum, ctx.weekStr);
    await interaction.update({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  // ── menu_cat — main tree navigation + leaf dispatch ───────────────────────

  // Back-to-main-menu option
  if (value === MENU_HOME_VALUE) {
    await interaction.update({
      embeds:     [buildMenuHubEmbed(ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr)],
      components: buildMenuHubRows(ctx) as any,
      files:      [buildMenuBannerAttachment()],
    });
    return true;
  }

  // Back-to-admin-hub option (used from admin sub-page nav selectors)
  if (value === MENU_ADMIN_HOME_VALUE) {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.reply({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr);
    await interaction.update({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  const node = findNode(value);
  if (!node) {
    await interaction.reply({ content: "❌ Unknown menu option (this menu may have expired).", ephemeral: true });
    return true;
  }

  // Visibility check
  if (node.visible && !node.visible(ctx)) {
    await interaction.reply({ content: "❌ That option isn't available right now.", ephemeral: true });
    return true;
  }

  if (node.kind === "ops") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.reply({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr);
    await interaction.update({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  if (node.kind === "branch" || node.kind === "placeholder") {
    // Economy & Social legacy: if user is on a "gm" branch, optionally append
    // the transactions embed. For now keep sub-pages clean (banner removed).
    const page = buildBranchPage(node, ctx);

    // Append transactions embed when entering the Bank or GM root for at-a-glance.
    let embeds: any[] = [page.embed];
    if (node.path === "gm") {
      try {
        const gid = interaction.guildId!;
        const uid = interaction.user.id;
        const [user, season, member] = await Promise.all([
          getOrCreateUser(uid, interaction.user.username, gid),
          getOrCreateActiveSeason(gid),
          interaction.guild?.members.fetch(uid).catch(() => null),
        ]);
        void user;
        const rules = await getSeasonRules(season);
        const displayName =
          (member as import("discord.js").GuildMember | null)?.nickname
            ?? interaction.user.displayName
            ?? interaction.user.username;
        const txEmbed = await buildTransactionsEmbed(
          uid, gid, season, ctx.settings, rules,
          interaction.user.displayAvatarURL(), displayName,
        );
        embeds.push(txEmbed);
      } catch (err) {
        console.error("[menu-router] Failed to build transactions embed for gm:", err);
      }
    }

    await interaction.update({ embeds, components: page.rows as any, files: [] });
    return true;
  }

  // Leaf action — dispatch to the existing ac_ handler with the chosen acId.
  if (node.kind === "action") {
    const handled = await handleActionsInteraction(interaction, node.action);
    if (!handled) {
      await interaction.reply({ content: "❌ That action couldn't be opened. Try again.", ephemeral: true });
    }
    return true;
  }

  return false;
}

/** Returns true if the interaction was handled. */
export async function handleMenuButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (id !== "menu_back" && id !== "menu_admin_back") return false;

  const ctx = await loadContext(interaction);

  if (id === "menu_admin_back") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.reply({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr);
    await interaction.update({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  // menu_back → main hub (banner + selector)
  await interaction.update({
    embeds:     [buildMenuHubEmbed(ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr)],
    components: buildMenuHubRows(ctx) as any,
    files:      [buildMenuBannerAttachment()],
  });
  return true;
}
