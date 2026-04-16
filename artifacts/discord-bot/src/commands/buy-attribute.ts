import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { franchiseRostersTable } from "@workspace/db";
import { ATTRIBUTES, CORE_ATTRIBUTES } from "../lib/constants.js";
import { getRosterSeasonId } from "../lib/db-helpers.js";
import { getRosterRows, DEV_LABEL } from "../lib/purchase-shared.js";
import { startAttributeUp } from "./attribute-up-interactions.js";
import { getServerSettings } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("buy-attribute")
  .setDescription("Upgrade a player attribute — pick attribute/quantity here or use the interactive UI")
  .addStringOption(opt =>
    opt.setName("position")
      .setDescription("Player's position on the roster")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("player")
      .setDescription("Player to upgrade attributes for (from autocomplete)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("attribute")
      .setDescription("Attribute to upgrade (optional — omit to browse all attributes interactively)")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addIntegerOption(opt =>
    opt.setName("quantity")
      .setDescription("How many points to upgrade (core ⭐ attrs: max 1 | non-core attrs: max 10)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(10),
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Team owner (defaults to yourself)")
      .setRequired(false),
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const focused        = interaction.options.getFocused(true);
    const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);

    if (focused.name === "attribute") {
      const settings = await getServerSettings(interaction.guildId!);
      const legacyMode = settings.legacyCoreAttrMode ?? false;
      const q = focused.value.toLowerCase();
      const choices = ATTRIBUTES
        .filter(a => a.toLowerCase().includes(q))
        .slice(0, 25)
        .map(a => {
          const isCore = CORE_ATTRIBUTES.has(a as any);
          if (!isCore) return { name: a, value: a };
          const label = legacyMode
            ? `⭐ ${a} (Core)`
            : `⭐ ${a} (Core — 1pt max, once per player/season)`;
          return { name: label, value: a };
        });
      await interaction.respond(choices);
      return;
    }

    if (focused.name === "position") {
      const rows = await getRosterRows(interaction, rosterSeasonId, { position: franchiseRostersTable.position });
      const positions = [...new Set(rows.map((r: any) => r.position as string).filter(Boolean))].sort();
      const q = focused.value.toLowerCase();
      const choices = positions
        .filter(p => p.toLowerCase().startsWith(q))
        .slice(0, 25)
        .map(p => ({ name: p, value: p }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === "player") {
      const positionFilter = interaction.options.getString("position");
      const rows = await getRosterRows(interaction, rosterSeasonId, {
        firstName: franchiseRostersTable.firstName,
        lastName:  franchiseRostersTable.lastName,
        devTrait:  franchiseRostersTable.devTrait,
        overall:   franchiseRostersTable.overall,
        position:  franchiseRostersTable.position,
      });
      const q = focused.value.toLowerCase();
      const eligible = rows.filter((r: any) => {
        if (positionFilter && r.position.toUpperCase() !== positionFilter.toUpperCase()) return false;
        return true;
      });
      const choices = eligible
        .filter((r: any) => `${r.firstName} ${r.lastName}`.toLowerCase().includes(q))
        .slice(0, 25)
        .map((r: any) => ({
          name:  `${r.firstName} ${r.lastName} (${r.overall} OVR • ${DEV_LABEL[r.devTrait] ?? "?"})`,
          value: `${r.firstName} ${r.lastName}`,
        }));
      await interaction.respond(choices);
      return;
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  return startAttributeUp(interaction);
}
