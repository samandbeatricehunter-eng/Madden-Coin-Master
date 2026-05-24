import type { ServerSettings } from "@workspace/db";

import * as help                    from "../../commands/stats/help.js";
import * as actions                  from "../../commands/actions.js";
import * as adminOperations          from "../../commands/admin/admin-operations.js";
import * as draftPresence            from "../../commands/league/draft-presence.js";
import * as adminLegend              from "../../commands/admin/admin-legend.js";
import * as adminLegendVault         from "../../commands/admin/admin-legendvault.js";
import * as adminCustomArcetypes     from "../../commands/admin/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "../../commands/admin/admin-customplayersettings.js";
import * as adminFixPlayerNames      from "../../commands/admin/admin-fixplayernames.js";
import * as adminServer              from "../../commands/admin/adminserver.js";
import * as adminTeamLogo            from "../../commands/admin/admin-team-logo.js";
import * as lottery                  from "../../commands/admin/lottery.js";

/**
 * Builds the list of slash command JSON payloads to register with Discord.
 * Pass `settings` to filter out commands for disabled features so they
 * disappear from the command picker automatically.
 * Pass `null` (default) to include every command regardless of settings.
 */
export function buildCommandJSON(settings: ServerSettings | null = null): object[] {
  const economy    = !settings || settings.coinEconomy;
  const legends    = economy  && (!settings || settings.legendsEnabled);
  const custom     = economy  && (!settings || settings.customSuperstarsEnabled);

  const entries: [{ data: { toJSON(): object } }, boolean][] = [
    [adminOperations,           true],
    [help,                      true],
    [actions,                   true],
    [draftPresence,             true],
    [adminServer,               true],
    [adminTeamLogo,             true],
    [lottery,                   true],
    [adminLegend,               legends],
    [adminLegendVault,          legends],
    [adminCustomArcetypes,      custom],
    [adminCustomPlayerSettings, custom],
    [adminFixPlayerNames,       custom],
  ];

  return entries
    .filter(([, include]) => include)
    .map(([m]) => m.data.toJSON());
}
