import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";
import { db } from "@workspace/db";
import { franchiseDraftPicksTable, franchiseMcaTeamsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function getGcsBucket() {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) return null;
  const storage = new Storage({
    credentials: {
      type: "external_account",
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    } as any,
    projectId: "",
  });
  return storage.bucket(bucketId);
}

export const data = new SlashCommandBuilder()
  .setName("admin-debugpicks")
  .setDescription("Inspect MCA pick payloads and DB state to diagnose import issues")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!await isAdminUser(interaction.user.id)) {
    await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  // 1. Count picks currently in DB
  const countRows = await db.select({ cnt: sql<number>`COUNT(*)::int` })
    .from(franchiseDraftPicksTable);
  const pickCount = countRows[0]?.cnt ?? 0;

  // 2. Count MCA teams and their discord_id coverage
  const teamRows = await db.select({
    total: sql<number>`COUNT(*)::int`,
    withDiscord: sql<number>`COUNT(discord_id)::int`,
  }).from(franchiseMcaTeamsTable);
  const teamTotal = teamRows[0]?.total ?? 0;
  const teamWithDiscord = teamRows[0]?.withDiscord ?? 0;

  // 3. Recent picks sample
  const recentPicks = await db.select()
    .from(franchiseDraftPicksTable)
    .orderBy(desc(franchiseDraftPicksTable.importedAt))
    .limit(3);

  // 4. Try GCS listing
  const bucket = getGcsBucket();
  let allFiles: string[] = [];
  let gcsError: string | null = null;
  let samplePayload: string | null = null;

  if (!bucket) {
    gcsError = "Object storage not configured (DEFAULT_OBJECT_STORAGE_BUCKET_ID missing)";
  } else {
    try {
      const [files] = await bucket.getFiles({ prefix: "mca/" });
      allFiles = files.map(f => f.name);

      // Try to read the most recent pick-related file
      const pickFile = allFiles.find(f => f.includes("draftpick") || f.includes("draftPick") || f.includes("draft-pick"))
        ?? allFiles.find(f => f.includes("unknown"));
      if (pickFile) {
        try {
          const [contents] = await bucket.file(pickFile).download();
          const parsed = JSON.parse(contents.toString("utf-8"));
          const keys = Object.keys(parsed ?? {});
          const arrKey = keys.find(k => Array.isArray(parsed[k]));
          const sample = arrKey ? parsed[arrKey][0] : parsed;
          samplePayload = `**File:** \`${pickFile}\`\n**Keys:** ${keys.join(", ")}\n**Array key:** ${arrKey ?? "(none)"}\n**Sample:**\n\`\`\`json\n${JSON.stringify(sample, null, 2).slice(0, 400)}\`\`\``;
        } catch (e) {
          samplePayload = `Could not read ${pickFile}: ${e}`;
        }
      }
    } catch (e) {
      gcsError = String(e);
    }
  }

  const pickFiles = allFiles.filter(f =>
    f.includes("draftpick") || f.includes("draftPick") || f.includes("draft-pick") || f.includes("unknown"),
  );

  const embed = new EmbedBuilder()
    .setTitle("🔍 Draft Picks Diagnostic")
    .setColor(Colors.Orange)
    .addFields(
      { name: "📦 Picks in DB", value: String(pickCount), inline: true },
      { name: "👥 MCA Teams", value: `${teamTotal} total, ${teamWithDiscord} linked to Discord`, inline: true },
    );

  // MCA files list
  if (gcsError) {
    embed.addFields({ name: "❌ GCS Error", value: gcsError.slice(0, 500) });
  } else {
    embed.addFields({
      name: "📁 All MCA files saved",
      value: allFiles.length > 0
        ? allFiles.map(f => `\`${f}\``).join("\n").slice(0, 900)
        : "(none — nothing exported yet or GCS disabled)",
    });

    if (pickFiles.length > 0) {
      embed.addFields({
        name: "🏈 Pick / unknown files",
        value: pickFiles.map(f => `\`${f}\``).join("\n").slice(0, 500),
      });
    }

    if (samplePayload) {
      embed.addFields({ name: "📄 Sample pick payload", value: samplePayload.slice(0, 1024) });
    } else {
      embed.addFields({ name: "⚠️ No pick payloads found", value: "MCA has not sent any draft pick data to any known endpoint." });
    }
  }

  if (recentPicks.length > 0) {
    embed.addFields({
      name: "🗂️ Recent picks in DB",
      value: recentPicks.map(p =>
        `**${p.teamName}** — ${p.draftYear} Rd ${p.round} Pick ${p.pickNum ?? "?"} (discord: ${p.discordId ?? "none"})`
      ).join("\n"),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
