import { Events, MessageReaction, User } from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { handleReactionPanelAdd } from "../lib/gameday/reaction-panels/service.js";

export const name = Events.MessageReactionAdd;
export const once = false;

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

async function commissionerMention(guild: any): Promise<string> {
  const role = guild?.roles?.cache?.find((r: any) => /commissioner|co[-\s]?commissioner|commish|league\s*architect|competition\s*council/i.test(r.name));
  return role ? `<@&${role.id}>` : "League Architect / Competition Council";
}

export async function execute(reaction: MessageReaction, user: User): Promise<void> {
  if (user.bot) return;
  if (await handleReactionPanelAdd(reaction, user).catch((err) => { console.error("[reaction-panel] failed:", err); return false; })) return;

  const emoji = reaction.emoji.name;
  if (emoji !== "🇫" && emoji !== "🇼") return;

  if (reaction.partial) {
    reaction = await reaction.fetch().catch(() => reaction);
  }
  const message = reaction.message;
  const guild = message.guild;
  if (!guild) return;

  const rows = await rowsOf<any>(sql`
    select *
    from gameday_issue_reports
    where guild_id = ${guild.id}
      and message_id = ${message.id}
      and issue_type = 'connection_issue'
      and status = 'pending'
    order by created_at desc
    limit 1
  `);
  const issue = rows[0];
  if (!issue) return;

  const userId = user.id;
  if (userId !== issue.requested_by && userId !== issue.opponent_discord_id) return;

  const requestType = emoji === "🇫" ? "fair_sim" : "force_win";
  const label = emoji === "🇫" ? "Fair Sim" : "Force Win";
  const commish = await commissionerMention(guild);

  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${issue.guild_id}, ${issue.season_id}, ${issue.week_index}, ${issue.matchup_key}, ${requestType},
      ${userId}, ${userId === issue.requested_by ? issue.opponent_discord_id : issue.requested_by}, ${`Connection issue reaction request: ${label}`}, 'pending'
    )
  `);

  await db.execute(sql`
    update gameday_issue_reports
    set status = ${requestType === "fair_sim" ? "fair_sim_requested" : "force_win_requested"}, updated_at = now()
    where id = ${issue.id}
  `);

  if (message.channel?.isTextBased()) {
    await message.channel.send(`${commish}\n${emoji} **Connection Issue Escalated — ${label} Requested**\n<@${userId}> requested **${label}** after the connection issue. Commissioner review required.`).catch(() => null);
  }
}
