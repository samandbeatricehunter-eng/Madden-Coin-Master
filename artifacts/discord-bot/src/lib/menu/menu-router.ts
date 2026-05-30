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
import { getCommOfficeCounts, getGotwUnvotedCount, getGotyStatus } from "./notif-counts.js";

const COMMISSIONER_ROLE_NAME = "Commissioner";

async function loadContext(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<MenuCtx> {
  if (!interaction.guildId || !interaction.guild) {
    throw new Error("Missing guild context for loadContext");
  }
  const gid = interaction.guildId;
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

  const [commCounts, gotwUnvoted, goty] = await Promise.all([
    (isAdmin || isCommissioner)
      ? getCommOfficeCounts(gid).catch(() => null)
      : Promise.resolve(null),
    getGotwUnvotedCount(uid, season.id).catch(() => 0),
    getGotyStatus(uid, season.id).catch(() => ({ unvoted: 0, active: false })),
  ]);

  return {
    settings,
    isAdmin,
    isCommissioner,
    seasonNum: season.seasonNumber,
    weekStr: weekLabel(season.currentWeek),
    commOfficeTotal: commCounts?.total ?? 0,
    gotwUnvotedCount: gotwUnvoted ?? 0,
    gotyUnvotedCount: goty.unvoted,
    gotyActive: goty.active,
  };
}

/** Returns true if the interaction was handled. */
export async function handleMenuSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "This menu can only be used inside a server.", ephemeral: true }).catch(() => null);
    return true;
  }
  const id = interaction.customId;
  if (id !== "menu_cat" && id !== "menu_admin_cat" && id !== "menu_unlinked_cat") return false;

  const value = interaction.values[0] ?? "";

  // ── Leaf actions that own their own response lifecycle ─────────────────────
  // Media/GOTW actions were split out of actions-handlers during the canonical
  // pivot. Route them before the legacy ac_* dispatcher so they are not swallowed
  // by the old member-action router.
  if (id === "menu_cat") {
    const node = findNode(value);
    if (node?.kind === "action") {
      const action = node.action;

      if (action === "ac_competitive_rating") {
        const { renderCompetitiveRating } = await import("../competitive/competitive-ratings.js");
        await renderCompetitiveRating(interaction as any, 0);
        return true;
      }

      if (action === "ac_strength_of_schedule") {
        const { renderStrengthOfSchedule } = await import("../competitive/competitive-ratings.js");
        await renderStrengthOfSchedule(interaction as any, 0);
        return true;
      }

      if (action === "ac_active_streams") {
        const { renderActiveStreams } = await import("../media/media-room.js");
        await renderActiveStreams(interaction as any);
        return true;
      }

      if (action === "ac_goty_hub" || action === "ac_goty_vote") {
        const { renderGotyHub } = await import("../media/media-room.js");
        await renderGotyHub(interaction as any);
        return true;
      }

      if (action === "ac_poty_vote") {
        const { renderPotyVote } = await import("../media/play-of-the-year.js");
        await renderPotyVote(interaction as any);
        return true;
      }

      if (action === "ac_gotw_vote") {
        const { openGotwVote } = await import("../handlers/gotw-voting-handlers.js");
        await openGotwVote(interaction as any);
        return true;
      }

      const handled = await handleActionsInteraction(interaction, action);
      if (!handled) {
        await interaction.reply({ content: "❌ That action couldn't be opened. Try again.", ephemeral: true });
      }
      return true;
    }
  }

  // ── All navigation paths: acknowledge immediately, then do async work ─────
  // deferUpdate() satisfies Discord's 3-second window; editReply()/followUp()
  // update the message afterwards.
  await interaction.deferUpdate();

  const ctx = await loadContext(interaction);

  // ── menu_unlinked_cat ─────────────────────────────────────────────────────
  if (id === "menu_unlinked_cat") {
    if (value === MENU_UNLINKED_HOME_VALUE) {
      await interaction.editReply({
        embeds:     [buildUnlinkedMenuEmbed(ctx.seasonNum, ctx.weekStr)],
        components: buildUnlinkedMenuRows() as any,
        files:      buildMenuBannerAttachment(),
      });
      return true;
    }
    const ok = ["teams", "rosters", "league", "rankings", "rules"] as const;
    type UnlinkedCat = (typeof ok)[number];
    if (!ok.includes(value as UnlinkedCat)) {
      await interaction.followUp({ content: "❌ Unknown menu option (this menu may have expired).", ephemeral: true });
      return true;
    }
    const page = buildUnlinkedCategoryPage(value as UnlinkedCat, ctx);
    await interaction.editReply({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  // ── menu_admin_cat ────────────────────────────────────────────────────────
  if (id === "menu_admin_cat") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.followUp({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const validAdmin: AdminCategoryId[] = [
      "commissioner_office", "gameday_review",
      "league_data", "ao_payouts", "user_data", "store", "server", "troubleshoot",
    ];
    if (!validAdmin.includes(value as AdminCategoryId)) {
      await interaction.followUp({ content: "❌ Unknown admin option (this menu may have expired).", ephemeral: true });
      return true;
    }
    if (value === "commissioner_office") {
      const { buildCommOfficeEmbed, buildCommOfficeRows } = await import("../handlers/pending-inbox-handlers.js");
      const counts = await getCommOfficeCounts(interaction.guildId!).catch(() => null);
      await interaction.editReply({
        embeds:     [buildCommOfficeEmbed()],
        components: buildCommOfficeRows(counts ?? undefined) as any,
        files:      [],
      });
      return true;
    }
    const page = buildAdminCategoryPage(value as AdminCategoryId, ctx.seasonNum, ctx.weekStr);
    await interaction.editReply({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  // ── menu_cat — main tree navigation ──────────────────────────────────────

  if (value === MENU_HOME_VALUE) {
    await interaction.editReply({
      embeds:     [buildMenuHubEmbed(ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr)],
      components: buildMenuHubRows(ctx) as any,
      files:      buildMenuBannerAttachment(),
    });
    return true;
  }

  if (value === MENU_ADMIN_HOME_VALUE) {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.followUp({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr, ctx.commOfficeTotal);
    await interaction.editReply({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  const node = findNode(value);
  if (!node) {
    await interaction.followUp({ content: "❌ Unknown menu option (this menu may have expired).", ephemeral: true });
    return true;
  }

  if (node.visible && !node.visible(ctx)) {
    await interaction.followUp({ content: "❌ That option isn't available right now.", ephemeral: true });
    return true;
  }

  if (node.kind === "ops") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.followUp({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr, ctx.commOfficeTotal);
    await interaction.editReply({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  if (node.kind === "branch" || node.kind === "placeholder") {
    const page = buildBranchPage(node, ctx);
    let embeds: any[] = [page.embed];

    if (node.path === "financials") {
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

    await interaction.editReply({ embeds, components: page.rows as any, files: [] });
    return true;
  }

  if (node.kind === "action") {
    const action = node.action;

    if (action === "ac_active_streams") {
      const { renderActiveStreams } = await import("../media/media-room.js");
      await renderActiveStreams(interaction as any);
      return true;
    }

    if (action === "ac_goty_hub") {
      const { renderGotyHub } = await import("../media/media-room.js");
      await renderGotyHub(interaction as any);
      return true;
    }

    if (action === "ac_poty_vote") {
      const { renderPotyVote } = await import("../media/play-of-the-year.js");
      await renderPotyVote(interaction as any);
      return true;
    }

    if (action === "ac_view_roles") {
      const { renderLeagueRoles } = await import("../roles/league-roles.js");
      await renderLeagueRoles(interaction as any, 0);
      return true;
    }

    const handled = await handleActionsInteraction(interaction, action);
    if (handled) return true;
  }

  return false;
}

/** Returns true if the interaction was handled. */
export async function handleMenuButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (id !== "menu_back" && id !== "menu_admin_back") return false;

  // Acknowledge immediately before async work
  await interaction.deferUpdate();

  const ctx = await loadContext(interaction);

  if (id === "menu_admin_back") {
    if (!ctx.isAdmin && !ctx.isCommissioner) {
      await interaction.followUp({ content: "❌ Admins or Commissioners only.", ephemeral: true });
      return true;
    }
    const page = buildAdminHubPage(ctx.seasonNum, ctx.weekStr, ctx.commOfficeTotal);
    await interaction.editReply({ embeds: [page.embed], components: page.rows as any, files: [] });
    return true;
  }

  await interaction.editReply({
    embeds:     [buildMenuHubEmbed(ctx.settings, ctx.isAdmin, ctx.seasonNum, ctx.weekStr)],
    components: buildMenuHubRows(ctx) as any,
    files:      buildMenuBannerAttachment(),
  });
  return true;
}
