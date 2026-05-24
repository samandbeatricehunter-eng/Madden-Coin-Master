import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { loadEAConnection } from "../../lib/ea/ea-client.js";
import axios from "axios";

function getApiBase(): string {
  const domain = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim() ?? "";
  if (!domain) throw new Error("REPLIT_DOMAINS is not set — cannot reach API server");
  return `https://${domain}/api`;
}

function getWebhookKey(): string {
  const key = process.env["MADDEN_WEBHOOK_KEY"];
  if (!key) throw new Error("MADDEN_WEBHOOK_KEY is not set");
  return key;
}

export const data = new SlashCommandBuilder()
  .setName("admin-repair-teamlinks")
  .setDescription("Commissioner: re-link teams to Discord users using server nicknames — no EA re-export needed")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const guild   = interaction.guild;

  // ── Step 1: sync current server nicknames to DB ──────────────────────────────
  if (guild) {
    try {
      const members = await guild.members.fetch();
      const ops: Promise<any>[] = [];
      for (const [memberId, member] of members) {
        const nick = member.displayName;
        ops.push(
          db.update(usersTable)
            .set({ serverNickname: nick, updatedAt: new Date() })
            .where(and(eq(usersTable.discordId, memberId), eq(usersTable.guildId, guildId))),
        );
      }
      await Promise.all(ops);
    } catch (err) {
      console.error("[repair-teamlinks] Failed to sync nicknames:", err);
    }
  }

  // ── Step 2: call API repair endpoint ─────────────────────────────────────────
  const conn = await loadEAConnection(guildId);
  if (!conn) {
    await interaction.editReply({
      content: "❌ No EA connection found for this server. Use `/admin-league-data` → Start EA Connection first.",
    });
    return;
  }

  const { eaLeagueId, token } = conn;
  const apiBase = getApiBase();
  const key     = getWebhookKey();
  const url     = `${apiBase}/madden/${key}/${token.platform}/${eaLeagueId}/repair-teamlinks`;

  let result: { ok: boolean; message: string; details?: { updated?: number; unchanged?: number; seasonId?: number } };
  try {
    const resp = await axios.post(url, {}, { timeout: 30_000 });
    result = resp.data;
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? String(err);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Repair Failed")
        .setDescription(msg)],
    });
    return;
  }

  const updated   = result.details?.updated   ?? 0;
  const unchanged = result.details?.unchanged ?? 0;
  const seasonId  = result.details?.seasonId  ?? "?";

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(result.ok ? (updated > 0 ? Colors.Green : Colors.Yellow) : Colors.Red)
      .setTitle(result.ok ? "🔗 Team Links Repaired" : "❌ Repair Error")
      .setDescription(result.message)
      .addFields(
        { name: "Updated",   value: String(updated),   inline: true },
        { name: "Unchanged", value: String(unchanged), inline: true },
        { name: "Season",    value: String(seasonId),  inline: true },
      )
      .setFooter({ text: "Run /admin-linkteam view to verify the results." })
      .setTimestamp()],
  });
}
