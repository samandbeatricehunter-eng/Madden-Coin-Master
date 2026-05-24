import { Events, GuildMember, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db/db-helpers.js";

export const name = Events.GuildMemberAdd;
export const once = false;

export async function execute(member: GuildMember): Promise<void> {
  const { guild } = member;
  const guildId   = guild.id;

  try {
    // Only fire if the server has been initialized (has at least one active season)
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

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("🏈 Getting Started — /menu Command Guide")
      .setDescription(
        "⚠️ **You will not have access to any private league channels until you've selected a team and been added by a Commissioner.**\n\n" +
        "Everything you need to get started is available through the **/menu** slash command. " +
        "Here's a quick rundown of what's available:\n\u200B",
      )
      .addFields(
        {
          name: "📋 Team Requests",
          value: [
            "🔴 **View Open Teams** — see every NFL team that's currently available to claim",
            "🟢 **View User Teams** — browse all active league members and their teams",
            "📬 **Request Open Team** — submit a team request directly to a commissioner",
            "📋 **Add to Waitlist** — join the waitlist if no team is available right now",
            "❌ **Remove from Waitlist** — remove yourself from the waitlist at any time",
          ].join("\n"),
          inline: false,
        },
        {
          name: "🔍 Browse the League",
          value: [
            "👥 **View Any Roster** — check out any team's current player roster",
            "📊 **Player Stats & Ratings** — view any player's season stats and attribute ratings",
            "🏟️ **Team Stats** — see any team's season offensive and defensive stats",
          ].join("\n"),
          inline: false,
        },
        {
          name: "📈 League Info",
          value: [
            "📈 **Standings** — current AFC and NFC standings",
            "🎯 **In The Hunt** — playoff picture and wild card race",
            "👀 **Teams to Watch** — highlighted storylines and must-see matchups",
          ].join("\n"),
          inline: false,
        },
        {
          name: "\u200B",
          value: "Once a commissioner links you to a team you'll unlock the full hub — coin economy, wagers, PR rankings, interview requests, and more.",
          inline: false,
        },
      );

    const lines = [
      `Welcome to the R.E.C. League, <@${member.id}>!`,
    ];
    if (rolePing) lines.push("", rolePing);

    await tc.send({ content: lines.join("\n"), embeds: [embed] });
  } catch (err) {
    console.error("[guildMemberAdd] Error posting welcome message:", err);
  }
}
