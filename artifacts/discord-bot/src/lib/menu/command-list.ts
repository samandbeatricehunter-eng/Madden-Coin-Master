import type { ServerSettings } from "@workspace/db";

import * as actions from "../../commands/actions.js";
import * as gameday from "../../commands/gameday.js";
import * as cpustream from "../../commands/cpustream.js";

/**
 * Builds the list of slash command JSON payloads to register with Discord.
 * `/menu`, `/gameday`, and `/cpustream` are registered — all other features are exposed through the
 * menu hub buttons and selects.
 */
export function buildCommandJSON(_settings: ServerSettings | null = null): object[] {
  return [actions.data.toJSON(), gameday.data.toJSON(), cpustream.data.toJSON()];
}
