import { Events, GuildMember, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";

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
      .setTitle("🏈 Getting Started")
      .setDescription(
        "Use the **/actions** command to get started:\n\n" +
        "• **View Open Teams** — browse all available teams and request the one you want\n" +
        "• **View Any Roster** — check out any team's players before deciding\n" +
        "• **Request Waitlist** — if your preferred team isn't available, add yourself to the waitlist\n\n" +
        "A commissioner will reach out once your request has been reviewed.",
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
