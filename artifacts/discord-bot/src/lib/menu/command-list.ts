import type { ServerSettings } from "@workspace/db";

import * as actions from "../../commands/actions.js";

/**
 * Builds the list of slash command JSON payloads to register with Discord.
 * Phase 4.1 consolidates all interaction surfaces under /menu.
 */
export function buildCommandJSON(_settings: ServerSettings | null = null): object[] {
  return [actions.data.toJSON()];
}
