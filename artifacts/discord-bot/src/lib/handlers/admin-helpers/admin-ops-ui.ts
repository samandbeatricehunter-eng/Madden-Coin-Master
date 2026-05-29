import {
  ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import { buildAdminHubPage } from "../../menu/menu-hub.js";

// Back-compat helpers used by lib/handlers/admin-operations-handlers.ts.
// Phase 4.1 routes admin operations through /menu selectors instead of a
// standalone /admin-menu command.

export function buildAdminOpsEmbed(seasonNum?: number, weekStr?: string): EmbedBuilder {
  return buildAdminHubPage(seasonNum, weekStr).embed;
}

export function buildAdminOpsRows(): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return buildAdminHubPage().rows as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}
