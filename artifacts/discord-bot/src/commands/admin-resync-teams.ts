import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-resync-teams")
  .setDescription("Commissioner: Re-stamp team ownership on all inventory items and custom players that are missing it")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  // ── 1. Inventory: stamp team on all rows where team IS NULL ─────────────────
  // Joins through seasons to scope team lookup to the correct guild — prevents
  // cross-server contamination in multi-guild setups.
  const invResult = await db.execute(sql`
    UPDATE inventory
    SET    team = u.team
    FROM   economy_users u
    JOIN   seasons s ON s.id = inventory.season_id AND s.guild_id = u.guild_id
    WHERE  inventory.discord_id = u.discord_id
      AND  inventory.team       IS NULL
      AND  u.team               IS NOT NULL
      AND  u.team               != ''
  `);
  const invCount = (invResult as { rowCount?: number }).rowCount ?? 0;

  // ── 2. Custom players: stamp team_name on all rows where team_name IS NULL ──
  const cpResult = await db.execute(sql`
    UPDATE custom_players
    SET    team_name = u.team
    FROM   economy_users u
    JOIN   seasons s ON s.id = custom_players.season_id AND s.guild_id = u.guild_id
    WHERE  custom_players.discord_id = u.discord_id
      AND  custom_players.team_name  IS NULL
      AND  u.team                    IS NOT NULL
      AND  u.team                    != ''
  `);
  const cpCount = (cpResult as { rowCount?: number }).rowCount ?? 0;

  // ── 3. Force-sync permanent vault: re-stamp team even if already set ────────
  // This corrects any rows that were stamped with the WRONG team (e.g. after a
  // user's team changed). Only touches permanent-vault legend/custom items.
  const permResult = await db.execute(sql`
    UPDATE inventory
    SET    team = u.team
    FROM   economy_users u
    JOIN   seasons s ON s.id = inventory.season_id AND s.guild_id = u.guild_id
    WHERE  inventory.discord_id       = u.discord_id
      AND  inventory.legend_category  = 'permanent'
      AND  u.team                     IS NOT NULL
      AND  u.team                     != ''
      AND  inventory.team             IS DISTINCT FROM u.team
  `);
  const permCount = (permResult as { rowCount?: number }).rowCount ?? 0;

  const lines: string[] = [];
  if (invCount > 0)   lines.push(`🗂️ **${invCount}** inventory item(s) stamped with team (were null)`);
  if (cpCount > 0)    lines.push(`🧬 **${cpCount}** custom player(s) stamped with team (were null)`);
  if (permCount > 0)  lines.push(`🔒 **${permCount}** permanent vault item(s) re-synced to current team owner`);
  if (lines.length === 0) lines.push("✅ All items already have correct team associations — nothing to update.");

  const embed = new EmbedBuilder()
    .setColor(lines.length === 1 && lines[0]!.startsWith("✅") ? Colors.Green : Colors.Gold)
    .setTitle("🔄 Team Resync Complete")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Legends and custom players now follow the franchise, not the Discord account." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
