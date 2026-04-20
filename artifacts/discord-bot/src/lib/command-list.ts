import type { ServerSettings } from "@workspace/db";

import * as admin              from "../commands/admin.js";
import * as view               from "../commands/view.js";
import * as help               from "../commands/help.js";
import * as balance            from "../commands/balance.js";
import * as sendcoins          from "../commands/sendcoins.js";
import * as buyLegend         from "../commands/buy-legend.js";
import * as buyAttribute      from "../commands/buy-attribute.js";
import * as buyDevup          from "../commands/buy-devup.js";
import * as buyAgereset       from "../commands/buy-agereset.js";
import * as buyCustomPlayer   from "../commands/buy-customplayer.js";
import * as inventory          from "../commands/inventory.js";
import * as recentH2H          from "../commands/recentH2H.js";
import * as wager              from "../commands/wager.js";
import * as teamlist           from "../commands/teamlist.js";
import * as openteams          from "../commands/openteams.js";
import * as seasonschedule     from "../commands/seasonschedule.js";
import * as nextschedule       from "../commands/nextschedule.js";
import * as nextopp            from "../commands/nextopp.js";
import * as myRoster           from "../commands/my-roster.js";
import * as savings            from "../commands/savings.js";
import * as weeklyMatchups     from "../commands/weekly-matchups.js";
import * as standings          from "../commands/standings.js";
import * as h2hrecord          from "../commands/h2hrecord.js";
import * as customarticle      from "../commands/customarticle.js";
import * as webhookurl         from "../commands/webhookurl.js";
import * as viewpayouttiers    from "../commands/viewpayouttiers.js";
import * as interviewrequest   from "../commands/interviewrequest.js";
import * as advanceweek        from "../commands/advanceweek.js";
import * as statleaders        from "../commands/statleaders.js";
import * as availableupgrades  from "../commands/availableupgrades.js";
import * as viewFreeAgents     from "../commands/viewfreeagents.js";
import * as viewXp             from "../commands/viewxp.js";
import * as adminEosTestrun         from "../commands/admin-eos-testrun.js";
import * as adminStatReimport       from "../commands/admin-stat-reimport.js";
import * as adminEaConnect          from "../commands/admin-ea-connect.js";
import * as adminEaExport           from "../commands/admin-ea-export.js";
import * as adminCancelResendEos    from "../commands/admin-cancel-resend-eos.js";
import * as adminRebuildHistorical  from "../commands/admin-rebuild-historical.js";
import * as draftPresence           from "../commands/draft-presence.js";
import * as adminPlayoffs           from "../commands/admin-playoffs.js";
import * as adminResendArticle      from "../commands/admin-resendarticle.js";
import * as adminCatchup            from "../commands/admin-catchup.js";
import * as adminManualScore        from "../commands/admin-manualscore.js";
import * as adminReverseGame        from "../commands/admin-reverse-game.js";
import * as adminPostFullSeasonSchedule from "../commands/admin-postfullseasonschedule.js";
import * as adminRollbackFranchise  from "../commands/admin-rollback-franchise.js";
import * as adminResetSeasonStats   from "../commands/admin-reset-season-stats.js";
import * as endofseasonpayout       from "../commands/endofseasonpayout.js";
import * as adminSetPayouts         from "../commands/admin-setpayouts.js";
import * as adminSetStatTiers       from "../commands/admin-set-stat-tiers.js";
import * as adminStatTiers          from "../commands/admin-stat-tiers.js";
import * as adminSetMilestoneTier   from "../commands/admin-setmilestonetier.js";
import * as adminLegendVault        from "../commands/admin-legendvault.js";
import * as adminResyncTeams        from "../commands/admin-resync-teams.js";
import * as adminRepairTeamLinks   from "../commands/admin-repair-teamlinks.js";
import * as adminMilestoneAudit     from "../commands/admin-milestone-audit.js";
import * as adminCustomArcetypes    from "../commands/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "../commands/admin-customplayersettings.js";
import * as adminFixPlayerNames     from "../commands/admin-fixplayernames.js";
import * as adminEosReapprove       from "../commands/admin-eos-reapprove.js";
import * as adminSeason             from "../commands/admin-season.js";
import * as adminLinkTeam           from "../commands/admin-linkteam.js";
import * as adminRosterLegends      from "../commands/admin-roster-legends.js";
import * as adminInventory          from "../commands/admin-inventory.js";
import * as adminInitialize         from "../commands/admin-initialize.js";
import * as adminServer             from "../commands/adminserver.js";
import * as adminRules              from "../commands/admin-rules.js";
import * as adminTeamLogo          from "../commands/admin-team-logo.js";
import * as adminRepostBanners     from "../commands/admin-repost-banners.js";
import * as adminPayout            from "../commands/admin-payout.js";
import * as waitlist                from "../commands/waitlist.js";
import * as globalrecords          from "../commands/globalrecords.js";
import * as alltimeleaderboard     from "../commands/alltimeleaderboard.js";
import { seasonPRData, allTimePRData } from "../commands/records.js";

/**
 * Builds the list of slash command JSON payloads to register with Discord.
 * Pass `settings` to filter out commands for disabled features so they
 * disappear from the command picker automatically.
 * Pass `null` (default) to include every command regardless of settings.
 */
export function buildCommandJSON(settings: ServerSettings | null = null): object[] {
  // Feature flags — default to true when no settings provided
  const economy    = !settings || settings.coinEconomy;
  const legends    = economy  && (!settings || settings.legendsEnabled);
  const custom     = economy  && (!settings || settings.customSuperstarsEnabled);
  const attrUp     = economy  && (!settings || settings.attributeUpgradesEnabled);
  const devUp      = economy  && (!settings || settings.devUpgradesEnabled);
  const ageReset   = economy  && (!settings || settings.ageResetsEnabled);
  const anyUpgrade = attrUp || devUp || ageReset;
  const wagersOn     = economy && (!settings || settings.wagerEnabled);

  // [module, include?]
  const entries: [{ data: { toJSON(): object } }, boolean][] = [
    // ── Always visible ──────────────────────────────────────────────────────
    [admin,              true],
    [view,               true],
    [help,               true],
    [teamlist,           true],
    [openteams,          true],
    [seasonschedule,     true],
    [nextschedule,       true],
    [nextopp,            true],
    [myRoster,           true],
    [weeklyMatchups,     true],
    [standings,          true],
    [h2hrecord,          true],
    [recentH2H,          true],
    [customarticle,      true],
    [webhookurl,         true],
    [interviewrequest,   true],
    [advanceweek,        true],
    [statleaders,        true],
    [viewFreeAgents,     true],
    [adminEosTestrun,    true],
    [adminStatReimport,  true],
    [adminEaConnect,     true],
    [adminEaExport,      true],
    [adminCancelResendEos,   true],
    [adminRebuildHistorical, true],
    [draftPresence,      true],
    [adminPlayoffs,      true],
    [adminResendArticle, true],
    [adminCatchup,       true],
    [adminPayout,        true],
    [adminManualScore,   true],
    [adminReverseGame,   true],
    [adminPostFullSeasonSchedule, true],
    [adminRollbackFranchise, true],
    [adminResetSeasonStats,  true],
    [adminEosReapprove,  true],
    [adminSeason,        true],
    [adminLinkTeam,         true],
    [adminRosterLegends,    true],
    [adminInventory,        true],
    [adminInitialize,    true],
    [adminServer,        true],
    [adminRules,         true],
    [adminTeamLogo,      true],
    [adminRepostBanners, true],
    [waitlist,           true],
    [globalrecords,         true],
    [alltimeleaderboard,    true],
    [adminSetStatTiers,  true],
    [adminStatTiers,     true],

    // ── Economy — hidden when coinEconomy is off ─────────────────────────────
    [balance,         economy],
    [sendcoins,       economy],
    [inventory,       economy],

    // ── Purchase commands — each toggled by its own feature flag ─────────────
    [buyLegend,       legends],
    [buyAttribute,    attrUp],
    [buyDevup,        devUp],
    [buyAgereset,     ageReset],
    [buyCustomPlayer, custom],
    [savings,         economy],
    [viewpayouttiers, economy],
    [viewXp,          economy],
    [endofseasonpayout,   economy],
    [adminSetPayouts,     economy],
    [adminSetMilestoneTier, economy],

    // ── Feature-specific ─────────────────────────────────────────────────────
    [availableupgrades,          anyUpgrade],
    [wager,                      wagersOn],
    [adminLegendVault,           legends],
    [adminResyncTeams,           true],
    [adminRepairTeamLinks,       true],
    [adminMilestoneAudit,        true],
    [adminCustomArcetypes,       custom],
    [adminCustomPlayerSettings,  custom],
    [adminFixPlayerNames,        custom],
  ];

  const commands = entries
    .filter(([, include]) => include)
    .map(([m]) => m.data.toJSON());

  // Records commands are named exports, not modules
  commands.push(seasonPRData.toJSON(), allTimePRData.toJSON());

  return commands;
}
