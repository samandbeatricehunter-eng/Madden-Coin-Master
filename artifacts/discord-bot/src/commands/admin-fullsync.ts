import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel, GuildMember,
} from "discord.js";
import { runFullSync } from "../lib/full-sync-engine.js";

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";

export const data = new SlashCommandBuilder()
  .setName("admin-fullsync")
  .setDescription("Full sync: auto-link teams, process stored games, and award any missed payouts & milestones")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Collect guild members for username matching ───────────────────────────
  const guildMembers = new Map<string, { username: string; displayName: string }>();
  try {
    await interaction.guild?.members.fetch();
    interaction.guild?.members.cache.forEach((m: GuildMember) => {
      guildMembers.set(m.id, {
        username:    m.user.username,
        displayName: m.displayName,
      });
    });
  } catch { /* non-fatal — proceed without guild data */ }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setDescription("⏳ Running full league sync — auto-linking teams, scanning GCS files, syncing payouts & milestones…")],
  });

  // ── Run all four phases ───────────────────────────────────────────────────
  const report = await runFullSync(guildMembers);

  // ── Build embeds ──────────────────────────────────────────────────────────
  const embeds: EmbedBuilder[] = [];

  // Embed 1: Team Linking
  const linkEmbed = new EmbedBuilder()
    .setColor(report.stillUnlinked.length > 0 ? Colors.Yellow : Colors.Green)
    .setTitle("🔗 Phase 1 — Team Linking");

  if (report.autoLinked.length > 0) {
    linkEmbed.addFields({
      name: `✅ Auto-linked (${report.autoLinked.length})`,
      value: report.autoLinked
        .map(u => `**${u.team}** ↔ <@${u.discordId}> *(${u.method})*`)
        .join("\n").slice(0, 1024),
    });
  }

  if (report.stillUnlinked.length > 0) {
    linkEmbed.addFields({
      name: `⚠️ Still Unlinked (${report.stillUnlinked.length})`,
      value: report.stillUnlinked
        .map(u => `<@${u.discordId}> (${u.discordUsername}) — no team found`)
        .join("\n").slice(0, 1024) +
        "\n\nUse `/admin-linkteam set` to assign these players manually.",
    });
  }

  linkEmbed.addFields({
    name: "Already Linked",
    value: `${report.alreadyLinked} player${report.alreadyLinked !== 1 ? "s" : ""} were already correctly linked`,
    inline: true,
  });

  embeds.push(linkEmbed);

  // Embed 2: Game Processing
  const gameEmbed = new EmbedBuilder()
    .setColor(report.gamesProcessed > 0 ? Colors.Green : Colors.Blue)
    .setTitle("🏈 Phase 2 — Game Payouts")
    .addFields(
      { name: "Files Scanned",      value: String(report.filesFound.length),   inline: true },
      { name: "Games Paid Out",     value: String(report.gamesProcessed),       inline: true },
      { name: "Already Processed",  value: String(report.gamesDuplicate),       inline: true },
      { name: "CPU vs CPU (skip)",  value: String(report.gamesCpuVsCpu),        inline: true },
      { name: "Unregistered Teams", value: String(report.gamesUnregistered),    inline: true },
    );

  if (report.payoutLines.length > 0) {
    gameEmbed.addFields({
      name: "Payouts Issued",
      value: report.payoutLines.slice(0, 20).join("\n").slice(0, 1024) +
        (report.payoutLines.length > 20 ? `\n…and ${report.payoutLines.length - 20} more` : ""),
    });
  }

  if (report.unregisteredLines.length > 0) {
    gameEmbed.addFields({
      name: "⚠️ Unregistered Human Teams",
      value: report.unregisteredLines.join("\n").slice(0, 1024),
    });
  }

  if (report.filesFound.length === 0) {
    gameEmbed.setDescription(
      "No schedule files found in storage.\n" +
      "Export game data from the Madden Companion App (MCA) to populate this."
    );
  }

  embeds.push(gameEmbed);

  // Embed 3: Standings fallback + Milestones
  const milestoneEmbed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("📊 Phase 3 & 4 — Standings Fallback + Milestones");

  if (report.standingsFallback.length > 0) {
    milestoneEmbed.addFields({
      name: `Standings Fallback (${report.standingsFallback.length} teams)`,
      value: report.standingsFallback.join("\n").slice(0, 1024),
    });
  } else {
    milestoneEmbed.addFields({
      name: "Standings Fallback",
      value: "No standings file found or all teams already had game records.",
      inline: false,
    });
  }

  if (report.milestoneLines.length > 0) {
    milestoneEmbed.addFields({
      name: `🎯 Milestones Awarded (${report.milestoneLines.length})`,
      value: report.milestoneLines.join("\n").slice(0, 1024),
    });
  } else {
    milestoneEmbed.addFields({
      name: "Milestones",
      value: "✅ All milestones up to date — no missed bonuses found.",
    });
  }

  embeds.push(milestoneEmbed);

  // Embed 4: Errors (if any)
  if (report.errors.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Errors")
      .setDescription(report.errors.join("\n").slice(0, 4096)));
  }

  // ── Reply to admin ────────────────────────────────────────────────────────
  await interaction.editReply({ embeds: embeds.slice(0, 4) });

  // ── Notify commissioner channel about unlinked users ─────────────────────
  if (report.stillUnlinked.length > 0 && COMMISSIONER_CHANNEL_ID) {
    try {
      const ch = interaction.client.channels.cache.get(COMMISSIONER_CHANNEL_ID)
        ?? await interaction.client.channels.fetch(COMMISSIONER_CHANNEL_ID).catch(() => null);

      if (ch?.isTextBased()) {
        const unlinkedList = report.stillUnlinked
          .map(u => `• <@${u.discordId}> (${u.discordUsername})`)
          .join("\n");

        await (ch as TextChannel).send({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle("⚠️ Full Sync — Unlinked Players")
            .setDescription(
              `The following ${report.stillUnlinked.length} player${report.stillUnlinked.length !== 1 ? "s" : ""} ` +
              `could not be automatically linked to a team. Please assign them manually with \`/admin-linkteam set\`:\n\n` +
              unlinkedList
            )
            .setTimestamp()],
        });
      }
    } catch { /* non-fatal */ }
  }
}
