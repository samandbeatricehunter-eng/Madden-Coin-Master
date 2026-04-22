import type { ServerSettings } from "@workspace/db";

import * as admin              from "../commands/admin.js";
import * as help               from "../commands/help.js";
import * as h2hrecord          from "../commands/h2hrecord.js";
import * as actions                 from "../commands/actions.js";
import * as adminOperations         from "../commands/admin-operations.js";
import * as adminEosTestrun         from "../commands/admin-eos-testrun.js";
import * as adminCancelResendEos    from "../commands/admin-cancel-resend-eos.js";
import * as adminRebuildHistorical  from "../commands/admin-rebuild-historical.js";
import * as draftPresence           from "../commands/draft-presence.js";
import * as adminResendArticle      from "../commands/admin-resendarticle.js";
import * as adminCatchup            from "../commands/admin-catchup.js";
import * as adminRollbackFranchise  from "../commands/admin-rollback-franchise.js";
import * as adminResetSeasonStats   from "../commands/admin-reset-season-stats.js";
import * as endofseasonpayout       from "../commands/endofseasonpayout.js";
import * as adminSetStatTiers       from "../commands/admin-set-stat-tiers.js";
import * as adminStatTiers          from "../commands/admin-stat-tiers.js";
import * as adminLegendVault        from "../commands/admin-legendvault.js";
import * as adminRepairTeamLinks   from "../commands/admin-repair-teamlinks.js";
import * as adminMilestoneAudit     from "../commands/admin-milestone-audit.js";
import * as adminCustomArcetypes    from "../commands/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "../commands/admin-customplayersettings.js";
import * as adminFixPlayerNames     from "../commands/admin-fixplayernames.js";
import * as adminEosReapprove       from "../commands/admin-eos-reapprove.js";
import * as adminSeason             from "../commands/admin-season.js";
import * as adminLinkTeam           from "../commands/admin-linkteam.js";
import * as adminInventory          from "../commands/admin-inventory.js";
import * as adminInitialize         from "../commands/admin-initialize.js";
import * as adminServer             from "../commands/adminserver.js";
import * as adminTeamLogo          from "../commands/admin-team-logo.js";
import * as adminRepostBanners     from "../commands/admin-repost-banners.js";
import * as globalrecords          from "../commands/globalrecords.js";

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
  // [module, include?]
  const entries: [{ data: { toJSON(): object } }, boolean][] = [
    // ── Always visible ──────────────────────────────────────────────────────
    [admin,              true],
    [actions,            true],
    [adminOperations,    true],
    [help,               true],
    [h2hrecord,          true],
    [adminEosTestrun,    true],
    [adminCancelResendEos,   true],
    [adminRebuildHistorical, true],
    [draftPresence,      true],
    [adminResendArticle, true],
    [adminCatchup,       true],
    [adminRollbackFranchise, true],
    [adminResetSeasonStats,  true],
    [adminEosReapprove,  true],
    [adminSeason,        true],
    [adminLinkTeam,         true],
    [adminInventory,        true],
    [adminInitialize,    true],
    [adminServer,        true],
    [adminTeamLogo,      true],
    [adminRepostBanners, true],
    [globalrecords,         true],
    [adminSetStatTiers,  true],
    [adminStatTiers,     true],

    // ── Economy — hidden when coinEconomy is off ─────────────────────────────
    [endofseasonpayout,   economy],
    // ── Feature-specific ─────────────────────────────────────────────────────
    [adminLegendVault,           legends],
    [adminRepairTeamLinks,       true],
    [adminMilestoneAudit,        true],
    [adminCustomArcetypes,       custom],
    [adminCustomPlayerSettings,  custom],
    [adminFixPlayerNames,        custom],
  ];

  void anyUpgrade;

  const commands = entries
    .filter(([, include]) => include)
    .map(([m]) => m.data.toJSON());

  return commands;
}
