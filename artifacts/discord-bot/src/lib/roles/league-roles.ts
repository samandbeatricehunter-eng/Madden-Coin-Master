import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  Guild,
  GuildMember,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CHANNEL_KEYS, getGuildChannel } from "../db/db-helpers.js";

const BOT_EMOJIS = ["🔥", "❄️", "🎯", "🏆", "⚠️"];

type RoleDef = {
  key: string;
  label: string;
  type: "core" | "performance" | "tag";
  permanent: boolean;
  emoji?: string;
  description: string;
  criteria: string;
};

export const LEAGUE_ROLE_DEFS: RoleDef[] = [
  { key: "league_veteran", label: "League Veteran", type: "core", permanent: true, description: "Completed at least 2 full seasons in any REC bot league.", criteria: "Auto-assigned after 2 completed seasons once completion history is available." },
  { key: "steady_streamer", label: "Steady Streamer", type: "performance", permanent: false, description: "Streams H2H games at least 90% of the time.", criteria: "9+ streams in last 10 recorded completed H2H games." },
  { key: "heavy_sweater", label: "Heavy Sweater", type: "performance", permanent: false, description: "Wins H2H games by a large all-time average margin.", criteria: "17+ average H2H margin of victory with at least 15 scored H2H games." },
  { key: "mr_perfect", label: "Mr Perfect", type: "performance", permanent: true, description: "Completed an undefeated regular season.", criteria: "Permanent after completing a regular season undefeated." },
  { key: "sb_winner", label: "SB Winner", type: "performance", permanent: true, description: "Won a Super Bowl in this server.", criteria: "Permanent after recorded Super Bowl win." },
  { key: "trenches", label: "Terror in the Trenches", type: "performance", permanent: false, description: "Current user-team leader in sacks + tackles for loss.", criteria: "Transfers to the current sacks + TFL leader when supported stat imports are available." },
  { key: "gimme_dat", label: "Mr Gimme Dat", type: "performance", permanent: false, description: "Current user-team leader in interceptions + fumble recoveries.", criteria: "Transfers to the current INT + FR leader when supported stat imports are available." },
  { key: "smashmouth", label: "Smashmouth Football", type: "performance", permanent: false, description: "Majority rushing team.", criteria: "Rush attempts are the majority of team playcalls when supported stat imports are available." },
  { key: "air_it_out", label: "Air it Out", type: "performance", permanent: false, description: "Heavy passing team.", criteria: "Pass attempts are at least 75% of offensive playcalls when supported stat imports are available." },
  { key: "hot", label: "Hot Streak", type: "tag", permanent: false, emoji: "🔥", description: "Won 2+ straight games.", criteria: "Nickname tag while active streak is 2+ wins." },
  { key: "cold", label: "Cold Streak", type: "tag", permanent: false, emoji: "❄️", description: "Lost 2+ straight games.", criteria: "Nickname tag while active streak is 2+ losses." },
  { key: "accurate_bettor", label: "Accurate Bettor", type: "tag", permanent: false, emoji: "🎯", description: "Strong wager/GOTW accuracy.", criteria: "80%+ combined successful wagers and GOTW picks, minimum 15 weighted decisions." },
  { key: "champion", label: "Reigning Champion", type: "tag", permanent: false, emoji: "🏆", description: "Current defending Super Bowl champion.", criteria: "Nickname tag for current reigning champion." },
  { key: "scheduling_risk", label: "Scheduling Risk", type: "tag", permanent: false, emoji: "⚠️", description: "Repeated scheduling rulings against the user.", criteria: "60%+ approved FW/FS rulings against user in tracked sample." },
];

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

function cleanNickname(name: string): string {
  let out = name;
  for (const emoji of BOT_EMOJIS) out = out.split(emoji).join("");
  return out.replace(/\s+/g, " ").trim();
}

async function ensureRole(guild: Guild, name: string) {
  const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return guild.roles.create({
    name,
    reason: "REC League automated role system",
    permissions: [],
    mentionable: false,
  });
}

async function setMemberRole(member: GuildMember, roleName: string, shouldHave: boolean, changes: string[]) {
  const role = await ensureRole(member.guild, roleName).catch(() => null);
  if (!role) return;
  const has = member.roles.cache.has(role.id);
  if (shouldHave && !has) {
    await member.roles.add(role, "REC League automated role assignment").catch(() => null);
    changes.push(`<@${member.id}> earned **${roleName}**`);
  } else if (!shouldHave && has) {
    await member.roles.remove(role, "REC League automated role removal").catch(() => null);
    changes.push(`<@${member.id}> lost **${roleName}**`);
  }
}

async function updateNicknameTags(member: GuildMember, emojis: string[], changes: string[]) {
  const current = member.nickname ?? member.user.username;
  const cleaned = cleanNickname(current);
  const unique = [...new Set(emojis)];
  const suffix = unique.length ? ` ${unique.join(" ")}` : "";
  const next = `${cleaned}${suffix}`.slice(0, 32);
  if (next !== current) {
    await member.setNickname(next, "REC League automated nickname tags").catch(() => null);
    changes.push(`<@${member.id}> nickname tags updated: ${unique.length ? unique.join(" ") : "none"}`);
  }
}

async function getGuildUsers(guildId: string): Promise<Array<{ discord_id: string; team: string | null }>> {
  return rowsOf(sql`
    select discord_id, team
    from economy_users
    where guild_id = ${guildId}
      and discord_id is not null
  `);
}

async function getHotColdTag(guildId: string, userId: string): Promise<"🔥" | "❄️" | null> {
  const games = await rowsOf<any>(sql`
    select winner_discord_id, away_discord_id, home_discord_id, status, finished_at, updated_at
    from game_schedules
    where guild_id = ${guildId}
      and (away_discord_id = ${userId} or home_discord_id = ${userId})
      and winner_discord_id is not null
    order by coalesce(finished_at, updated_at) desc
    limit 10
  `).catch(() => []);

  let wins = 0;
  let losses = 0;
  for (const g of games) {
    const won = String(g.winner_discord_id) === userId;
    if (won && losses === 0) wins++;
    else if (!won && wins === 0) losses++;
    else break;
  }
  if (wins >= 2) return "🔥";
  if (losses >= 2) return "❄️";
  return null;
}

async function hasSchedulingRisk(guildId: string, userId: string): Promise<boolean> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_commissioner_requests
    where guild_id = ${guildId}
      and opponent_discord_id = ${userId}
      and request_type in ('force_win','fair_sim')
      and status = 'approved'
  `).catch(() => [{ count: 0 }]);
  return Number(rows[0]?.count ?? 0) >= 3;
}

async function hasAccurateBettor(guildId: string, userId: string): Promise<boolean> {
  const wagerRows = await rowsOf<any>(sql`
    select winner_discord_id, creator_discord_id, acceptor_discord_id, status
    from coin_wagers
    where guild_id = ${guildId}
      and status = 'settled'
      and (creator_discord_id = ${userId} or acceptor_discord_id = ${userId})
  `).catch(() => []);
  const gotwRows = await rowsOf<any>(sql`
    select voter_id, settlement_status
    from gotw_votes
    where guild_id = ${guildId}
      and voter_id = ${userId}
      and settlement_status in ('correct','incorrect')
  `).catch(() => []);

  let weightedWins = 0;
  let weightedTotal = 0;
  for (const w of wagerRows) {
    weightedTotal += 2;
    if (String(w.winner_discord_id) === userId) weightedWins += 2;
  }
  for (const v of gotwRows) {
    weightedTotal += 1;
    if (String(v.settlement_status) === "correct") weightedWins += 1;
  }
  return weightedTotal >= 15 && weightedWins / weightedTotal >= 0.8;
}

async function getStreamerUsers(guildId: string): Promise<Set<string>> {
  const rows = await rowsOf<{ discord_id: string }>(sql`
    select discord_id
    from pending_channel_payouts
    where guild_id = ${guildId}
      and type = 'stream'
      and status = 'approved'
      and created_at >= now() - interval '120 days'
    group by discord_id
    having count(*) >= 9
  `).catch(() => []);
  return new Set(rows.map((r) => String(r.discord_id)));
}

async function getHeavySweaters(guildId: string): Promise<Set<string>> {
  const rows = await rowsOf<{ discord_id: string }>(sql`
    with games as (
      select away_discord_id as discord_id,
             case when winner_discord_id = away_discord_id then abs(coalesce(away_score,0)-coalesce(home_score,0)) else null end as mov
      from game_schedules
      where guild_id = ${guildId} and away_score is not null and home_score is not null and winner_discord_id is not null
      union all
      select home_discord_id as discord_id,
             case when winner_discord_id = home_discord_id then abs(coalesce(home_score,0)-coalesce(away_score,0)) else null end as mov
      from game_schedules
      where guild_id = ${guildId} and away_score is not null and home_score is not null and winner_discord_id is not null
    )
    select discord_id
    from games
    where discord_id is not null
    group by discord_id
    having count(*) >= 15 and avg(coalesce(mov,0)) >= 17
  `).catch(() => []);
  return new Set(rows.map((r) => String(r.discord_id)));
}

async function getSbWinners(guildId: string): Promise<Set<string>> {
  const rows = await rowsOf<{ discord_id: string }>(sql`
    select discord_id
    from economy_users
    where guild_id = ${guildId}
      and all_time_superbowl_wins > 0
  `).catch(() => []);
  return new Set(rows.map((r) => String(r.discord_id)));
}

async function postRoleUpdate(guild: Guild, lines: string[]) {
  if (!lines.length) return;
  const channelId = await getGuildChannel(guild.id, CHANNEL_KEYS.GENERAL).catch(() => null);
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Gold)
          .setTitle("🏅 Weekly Role Updates")
          .setDescription(lines.slice(0, 35).join("\n").slice(0, 3900))
          .setFooter({ text: "Updated from latest advance/import data." }),
      ],
    }).catch(() => null);
  }
}

export async function recalculateLeagueRolesOnAdvance(guild: Guild): Promise<void> {
  const guildId = guild.id;
  const changes: string[] = [];
  await guild.members.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);

  const [users, steady, sweaters, sbWinners] = await Promise.all([
    getGuildUsers(guildId),
    getStreamerUsers(guildId),
    getHeavySweaters(guildId),
    getSbWinners(guildId),
  ]);

  for (const u of users) {
    const member = await guild.members.fetch(u.discord_id).catch(() => null);
    if (!member) continue;

    await setMemberRole(member, "Steady Streamer", steady.has(u.discord_id), changes);
    await setMemberRole(member, "Heavy Sweater", sweaters.has(u.discord_id), changes);
    if (sbWinners.has(u.discord_id)) await setMemberRole(member, "SB Winner", true, changes);

    const emojis: string[] = [];
    const hotCold = await getHotColdTag(guildId, u.discord_id);
    if (hotCold) emojis.push(hotCold);
    if (await hasAccurateBettor(guildId, u.discord_id)) emojis.push("🎯");
    if (sbWinners.has(u.discord_id)) emojis.push("🏆");
    if (await hasSchedulingRisk(guildId, u.discord_id)) emojis.push("⚠️");

    await updateNicknameTags(member, emojis, changes);
  }

  await postRoleUpdate(guild, changes);
}

export async function renderLeagueRoles(interaction: any, page = 0): Promise<void> {
  const guild = interaction.guild!;
  await guild.roles.fetch().catch(() => null);
  await guild.members.fetch().catch(() => null);

  const groups = [
    { title: "Core Roles", items: LEAGUE_ROLE_DEFS.filter((r) => r.type === "core") },
    { title: "Performance Roles", items: LEAGUE_ROLE_DEFS.filter((r) => r.type === "performance") },
    { title: "Nickname Tags", items: LEAGUE_ROLE_DEFS.filter((r) => r.type === "tag") },
  ];

  const safePage = Math.max(0, Math.min(page, groups.length - 1));
  const group = groups[safePage]!;
  const lines = group.items.map((def) => {
    let holders = "_None currently._";
    if (def.type === "tag" && def.emoji) {
      const members = guild.members.cache.filter((m) => (m.nickname ?? m.user.username).includes(def.emoji!));
      holders = members.size ? members.map((m) => `<@${m.id}>`).slice(0, 12).join(", ") : holders;
    } else {
      const role = guild.roles.cache.find((r) => r.name.toLowerCase() === def.label.toLowerCase());
      if (role) {
        const members = guild.members.cache.filter((m) => m.roles.cache.has(role.id));
        holders = members.size ? members.map((m) => `<@${m.id}>`).slice(0, 12).join(", ") : holders;
      }
    }

    return `**${def.emoji ? `${def.emoji} ` : ""}${def.label}**\n${def.description}\n*Earned:* ${def.criteria}\n*Current:* ${holders}`;
  });

  const payload = {
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle(`🏅 League Roles — ${group.title}`)
        .setDescription(lines.join("\n\n").slice(0, 3900))
        .setFooter({ text: `Page ${safePage + 1}/${groups.length}` }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`roles_view:${safePage - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
        new ButtonBuilder().setCustomId(`roles_view:${safePage + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= groups.length - 1),
      ),
    ],
  };

  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) await interaction.update(payload).catch(() => interaction.reply({ ...payload, ephemeral: true }));
  else await interaction.reply({ ...payload, ephemeral: true });
}

export async function handleLeagueRolesInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId === "ac_view_roles") {
    await renderLeagueRoles(interaction, 0);
    return true;
  }
  if (interaction.customId.startsWith("roles_view:")) {
    await renderLeagueRoles(interaction, Number(interaction.customId.split(":")[1] ?? 0));
    return true;
  }
  return false;
}
