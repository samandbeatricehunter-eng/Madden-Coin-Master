import type { ServerSettings } from "@workspace/db";

import * as help                    from "../commands/help.js";
import * as actions                  from "../commands/actions.js";
import * as adminOperations          from "../commands/admin-operations.js";
import * as draftPresence            from "../commands/draft-presence.js";
import * as adminLegendVault         from "../commands/admin-legendvault.js";
import * as adminCustomArcetypes     from "../commands/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "../commands/admin-customplayersettings.js";
import * as adminFixPlayerNames      from "../commands/admin-fixplayernames.js";
import * as adminServer              from "../commands/adminserver.js";
import * as adminTeamLogo            from "../commands/admin-team-logo.js";

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
    [adminLegendVault,          legends],
    [adminCustomArcetypes,      custom],
    [adminCustomPlayerSettings, custom],
    [adminFixPlayerNames,       custom],
  ];

  return entries
    .filter(([, include]) => include)
    .map(([m]) => m.data.toJSON());
}
