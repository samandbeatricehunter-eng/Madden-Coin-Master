import { Events, GuildMember, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonsTable } from "@workspace/db";
import { isNotNull, and, eq } from "drizzle-orm";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { NFL_TEAMS } from "../lib/constants.js";

export const name = Events.GuildMemberAdd;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  const { guild } = member;
  const guildId   = guild.id;

  try {
    // Only fire if the server has been initialized (has at least one season)
    const [season] = await db
      .select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .limit(1);
    if (!season) return;

    // Locate #welcome channel
    const welcomeId = await getGuildChannel(guildId, CHANNEL_KEYS.WELCOME).catch(() => null);
    if (!welcomeId) return;

    const welcomeCh = guild.channels.cache.get(welcomeId)
      ?? await guild.client.channels.fetch(welcomeId).catch(() => null);
    if (!welcomeCh?.isTextBased()) return;

    const tc = welcomeCh as TextChannel;

    // Find Commissioner and Co-Commissioner role mentions
    const commRole   = guild.roles.cache.find(r => r.name === "Commissioner");
    const coCommRole = guild.roles.cache.find(r => r.name === "Co-Commissioner");
    const rolePing   = [commRole, coCommRole].filter(Boolean).map(r => `<@&${r!.id}>`).join(" ");

    // Delete old open-teams bot posts in #welcome
    const existing = await tc.messages.fetch({ limit: 50 }).catch(() => null);
    if (existing) {
      for (const msg of existing.values()) {
        if (msg.author.id !== guild.client.user!.id) continue;
        const isOpenTeamPost = msg.embeds.some(e =>
          e.title?.startsWith("🏈 Open Teams") || e.title?.startsWith("🏈 League Teams"),
        );
        if (isOpenTeamPost) await msg.delete().catch(() => null);
      }
    }

    // Build open-teams embed
    const takenRows = await db
      .select({ team: usersTable.team, discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

    const taken = new Set(
      takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string),
    );
    const openTeams = NFL_TEAMS.filter(t => !taken.has(t));

    const openEmbed = openTeams.length > 0
      ? new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`🏈 Open Teams (${openTeams.length} available)`)
          .setDescription(openTeams.map(t => `• ${t}`).join("\n"))
          .setTimestamp()
      : new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle("🏈 Open Teams")
          .setDescription("All 32 NFL teams are currently assigned to league members!")
          .setTimestamp();

    // Post welcome message + open teams (tagging comm roles)
    const welcomeText = [
      `Welcome to the R.E.C. League, <@${member.id}>!`,
      "",
      "Please take a look at the Open Teams list below and notify a commissioner when you've decided who you want.",
      "If there are no available teams, but you want to be added to the waitlist, just tag a commissioner and they'll get you added.",
      "",
      rolePing ? `${rolePing}` : "",
    ].filter(l => l !== undefined).join("\n").trim();

    await tc.send({ content: welcomeText, embeds: [openEmbed] });
  } catch (err) {
    console.error("[guildMemberAdd] Error posting welcome message:", err);
  }
}
