import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-resync-teams")
  .setDescription("Commissioner: Re-stamp team ownership, fix vault items, and correct per-guild W/L records")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const guildId = interaction.guildId!;

  // ── 1. Inventory: stamp team on all rows where team IS NULL ─────────────────
  // Uses comma-style FROM (not explicit JOIN) for broadest PostgreSQL compatibility
  // with UPDATE ... FROM. Scopes to the correct guild via seasons table.
  const invResult = await db.execute(sql`
    UPDATE inventory i
    SET    team = u.team
    FROM   economy_users u,
           seasons s
    WHERE  i.discord_id = u.discord_id
      AND  s.id         = i.season_id
      AND  s.guild_id   = u.guild_id
      AND  s.guild_id   = ${guildId}
      AND  i.team       IS NULL
      AND  u.team       IS NOT NULL
      AND  u.team       != ''
  `);
  const invCount = (invResult as { rowCount?: number }).rowCount ?? 0;

  // ── 2. Custom players: stamp team_name on all rows where team_name IS NULL ──
  const cpResult = await db.execute(sql`
    UPDATE custom_players cp
    SET    team_name = u.team
    FROM   economy_users u,
           seasons s
    WHERE  cp.discord_id = u.discord_id
      AND  s.id          = cp.season_id
      AND  s.guild_id    = u.guild_id
      AND  s.guild_id    = ${guildId}
      AND  cp.team_name  IS NULL
      AND  u.team        IS NOT NULL
      AND  u.team        != ''
  `);
  const cpCount = (cpResult as { rowCount?: number }).rowCount ?? 0;

  // ── 3. Force-sync permanent vault: re-stamp team even if already set ────────
  // Corrects rows stamped with the wrong team (e.g. after account transfers).
  const permResult = await db.execute(sql`
    UPDATE inventory i
    SET    team = u.team
    FROM   economy_users u,
           seasons s
    WHERE  i.discord_id      = u.discord_id
      AND  s.id              = i.season_id
      AND  s.guild_id        = u.guild_id
      AND  s.guild_id        = ${guildId}
      AND  i.legend_category = 'permanent'
      AND  u.team            IS NOT NULL
      AND  u.team            != ''
      AND  i.team            IS DISTINCT FROM u.team
  `);
  const permCount = (permResult as { rowCount?: number }).rowCount ?? 0;

  // ── 4. Retroactive W/L correction ───────────────────────────────────────────
  // Historical wins/losses in economy_users.all_time_h2h_wins/losses were being
  // written without a guildId filter, causing cross-guild contamination in
  // multi-server setups. This recalculates the correct values per guild by
  // summing from user_records WHERE the season belongs to THIS guild only.
  const wlResult = await db.execute(sql`
    UPDATE economy_users u
    SET    all_time_h2h_wins   = COALESCE(r.total_wins,   0),
           all_time_h2h_losses = COALESCE(r.total_losses, 0),
           updated_at          = NOW()
    FROM (
      SELECT
        ur.discord_id,
        SUM(ur.wins)   AS total_wins,
        SUM(ur.losses) AS total_losses
      FROM   user_records ur
      JOIN   seasons s ON s.id = ur.season_id
      WHERE  s.guild_id = ${guildId}
      GROUP  BY ur.discord_id
    ) r
    WHERE  u.discord_id = r.discord_id
      AND  u.guild_id   = ${guildId}
  `);
  const wlCount = (wlResult as { rowCount?: number }).rowCount ?? 0;

  // ── 5. Build reply ──────────────────────────────────────────────────────────
  const lines: string[] = [];
  if (invCount > 0)   lines.push(`🗂️ **${invCount}** inventory item(s) stamped with team (were null)`);
  if (cpCount > 0)    lines.push(`🧬 **${cpCount}** custom player(s) stamped with team (were null)`);
  if (permCount > 0)  lines.push(`🔒 **${permCount}** permanent vault item(s) re-synced to current team owner`);
  if (wlCount > 0)    lines.push(`📊 **${wlCount}** user W/L record(s) recalculated to this server's seasons only`);
  if (lines.length === 0) lines.push("✅ All items already have correct team associations and W/L records — nothing to update.");

  const embed = new EmbedBuilder()
    .setColor(lines.length === 1 && lines[0]!.startsWith("✅") ? Colors.Green : Colors.Gold)
    .setTitle("🔄 Team Resync Complete")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Run /admin-milestone-audit after this to correct any milestone payouts that were affected." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
