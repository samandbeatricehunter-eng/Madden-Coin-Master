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
import { CHANNEL_KEYS, getGuildChannel, getOrCreateActiveSeason } from "../db/db-helpers.js";

const RATE_LIMIT_DELAY_MS = 800;

type RoleDef = {
  key: string;
  label: string;
  type: "core" | "performance";
  permanent: boolean;
  description: string;
  criteria: string;
};

export const LEAGUE_ROLE_DEFS: RoleDef[] = [
  { key: "rec_og", label: "REC League OG", type: "core", permanent: true, description: "Legacy REC League founding-user role. No new users are auto-seeded for this role.", criteria: "Existing global REC League OG entitlement only. New entitlements are manual-only." },
  { key: "league_veteran", label: "League Veteran", type: "core", permanent: true, description: "Completed at least 40 tracked H2H games across REC bot leagues.", criteria: "Auto-assigned at 40+ combined H2H wins/losses across all REC bot servers." },
  { key: "steady_streamer", label: "Steady Streamer", type: "performance", permanent: false, description: "Consistently posts approved stream payouts across tracked games.", criteria: "60+ approved streams in the last 120 days, or streams registered for at least 50% of current-season CPU/H2H games." },
  { key: "heavy_sweater", label: "Heavy Sweater", type: "performance", permanent: false, description: "Maintains a large global point differential across tracked H2H games.", criteria: "15+ global scored H2H games and global point differential divided by global wins/losses/ties is at least +17." },
  { key: "mr_perfect", label: "Mr Perfect", type: "performance", permanent: true, description: "Completed a 17-0 regular season.", criteria: "Permanent global role when a 17-0 record is detected on Week 18 → Wild Card advance." },
  { key: "sb_winner", label: "SB Winner", type: "performance", permanent: true, description: "Won a Super Bowl in a REC bot league.", criteria: "Permanent global role after any recorded Super Bowl win." },
  { key: "trenches", label: "Terror in the Trenches", type: "performance", permanent: false, description: "Current sacks leader among users.", criteria: "Transfers to the current user-team leader in team sacks for this league season." },
  { key: "gimme_dat", label: "Mr Gimme Dat", type: "performance", permanent: false, description: "Current user-team leader in interceptions.", criteria: "Transfers to the current user-team leader in team interceptions for this league season." },
  { key: "smashmouth", label: "Smashmouth Football", type: "performance", permanent: false, description: "Run-heavy offense.", criteria: "300+ pass/rush attempts and at least 60% rush attempts using player season stats." },
  { key: "air_it_out", label: "Air it Out", type: "performance", permanent: false, description: "Pass-heavy offense.", criteria: "300+ pass/rush attempts and at least 65% pass attempts using player season stats." },
  { key: "hot", label: "Hot Streak", type: "performance", permanent: false, description: "Won 2+ straight global H2H games.", criteria: "Assigned while the user has won their last 2+ tracked H2H games globally; removed when snapped." },
  { key: "cold", label: "Cold Streak", type: "performance", permanent: false, description: "Lost 2+ straight global H2H games.", criteria: "Assigned while the user has lost their last 2+ tracked H2H games globally; removed when snapped." },
  { key: "champion", label: "Reigning Champion 🏆", type: "performance", permanent: false, description: "Current defending Super Bowl champion.", criteria: "Assigned to the current defending Super Bowl champion for this league." },
];

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureRoleTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists rec_role_global_entitlements (
      id serial primary key,
      discord_id text not null,
      role_key text not null,
      source_guild_id text,
      reason text,
      created_at timestamp with time zone not null default now(),
      unique(discord_id, role_key)
    )
  `);
  await db.execute(sql`
    create table if not exists rec_role_server_one_time_events (
      id serial primary key,
      guild_id text not null,
      event_key text not null,
      processed_at timestamp with time zone not null default now(),
      unique(guild_id, event_key)
    )
  `);
  await db.execute(sql`
    create table if not exists rec_guild_defending_champions (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      champion_discord_id text not null,
      source text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, season_id)
    )
  `);
  await db.execute(sql`
    create table if not exists rec_guild_role_aliases (
      id serial primary key,
      guild_id text not null,
      role_key text not null,
      canonical_role_id text not null,
      canonical_role_name text not null,
      duplicate_role_ids text[] not null default '{}',
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, role_key)
    )
  `);
}


async function ensureRole(guild: Guild, name: string) {
  await guild.roles.fetch().catch(() => null);
  const matches = guild.roles.cache
    .filter((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())
    .sort((a, b) => a.position - b.position);

  const existing = matches.first();
  if (existing) {
    if (name.toLowerCase() === "rec league og" && matches.size > 1) {
      const duplicates = matches.filter((r) => r.id !== existing.id);
      for (const duplicate of duplicates.values()) {
        for (const member of duplicate.members.values()) {
          if (!member.roles.cache.has(existing.id)) {
            await member.roles.add(existing, "Consolidating duplicate REC League OG role").catch(() => null);
            await delay(RATE_LIMIT_DELAY_MS);
          }
          await member.roles.remove(duplicate, "Consolidating duplicate REC League OG role").catch(() => null);
          await delay(RATE_LIMIT_DELAY_MS);
        }
      }
      await db.execute(sql`
        insert into rec_guild_role_aliases (guild_id, role_key, canonical_role_id, canonical_role_name, duplicate_role_ids, updated_at)
        values (${guild.id}, 'rec_og', ${existing.id}, ${existing.name}, ${duplicates.map((r) => r.id)}, now())
        on conflict (guild_id, role_key)
        do update set canonical_role_id = excluded.canonical_role_id, canonical_role_name = excluded.canonical_role_name, duplicate_role_ids = excluded.duplicate_role_ids, updated_at = now()
      `).catch(() => null);
    }
    return existing;
  }

  return guild.roles.create({
    name,
    reason: "REC League automated role system",
    permissions: [],
    mentionable: false,
  });
}

async function grantGlobal(discordId: string, roleKey: string, sourceGuildId: string, reason: string): Promise<boolean> {
  const before = await rowsOf(sql`
    select id from rec_role_global_entitlements
    where discord_id = ${discordId} and role_key = ${roleKey}
    limit 1
  `);
  if (before.length) return false;
  await db.execute(sql`
    insert into rec_role_global_entitlements (discord_id, role_key, source_guild_id, reason)
    values (${discordId}, ${roleKey}, ${sourceGuildId}, ${reason})
    on conflict (discord_id, role_key) do nothing
  `);
  return true;
}

async function globalRoleKeys(discordId: string): Promise<Set<string>> {
  const rows = await rowsOf<{ role_key: string }>(sql`
    select role_key from rec_role_global_entitlements
    where discord_id = ${discordId}
  `).catch(() => []);
  return new Set(rows.map((r) => r.role_key));
}

async function setMemberRole(member: GuildMember, roleName: string, shouldHave: boolean, changes: string[]) {
  const role = await ensureRole(member.guild, roleName).catch(() => null);
  if (!role) return;
  const has = member.roles.cache.has(role.id);
  if (shouldHave && !has) {
    await member.roles.add(role, "REC League automated role assignment").catch(() => null);
    changes.push(`<@${member.id}> earned **${roleName}**`);
    await delay(RATE_LIMIT_DELAY_MS);
  } else if (!shouldHave && has) {
    await member.roles.remove(role, "REC League automated role removal").catch(() => null);
    changes.push(`<@${member.id}> lost **${roleName}**`);
    await delay(RATE_LIMIT_DELAY_MS);
  }
}

async function getGuildUsers(guildId: string): Promise<Array<{ discord_id: string; team: string | null }>> {
  return rowsOf(sql`
    select discord_id, team
    from economy_users
    where guild_id = ${guildId}
      and discord_id is not null
  `).catch(() => []);
}

async function getHotColdRoleState(userId: string): Promise<"hot" | "cold" | null> {
  const games = await rowsOf<any>(sql`
    select winner_discord_id, away_discord_id, home_discord_id, finished_at, updated_at, created_at
    from game_schedules
    where (away_discord_id = ${userId} or home_discord_id = ${userId})
      and away_discord_id is not null
      and home_discord_id is not null
      and away_discord_id <> home_discord_id
      and winner_discord_id is not null
    order by coalesce(finished_at, updated_at, created_at) desc
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
  if (wins >= 2) return "hot";
  if (losses >= 2) return "cold";
  return null;
}




async function seedOgOnce(guildId: string, _changes: string[]): Promise<void> {
  // REC League OG is now closed to new automatic grants. Existing global
  // entitlements remain honored by applyGlobalRoleEntitlements(). We still mark
  // the legacy seed event processed so older guilds cannot auto-seed everyone
  // with a linked team on a future advance.
  await db.execute(sql`
    insert into rec_role_server_one_time_events (guild_id, event_key)
    values (${guildId}, 'rec_og_seed')
    on conflict (guild_id, event_key) do nothing
  `);
}


async function seedLeagueVeterans(guildId: string, changes: string[]): Promise<void> {
  const rows = await rowsOf<{ discord_id: string; games: number }>(sql`
    select discord_id, sum(all_time_h2h_wins + all_time_h2h_losses)::int as games
    from economy_users
    group by discord_id
    having sum(all_time_h2h_wins + all_time_h2h_losses) >= 40
  `).catch(() => []);
  for (const r of rows) {
    const granted = await grantGlobal(r.discord_id, "league_veteran", guildId, `40+ tracked H2H games (${r.games})`);
    if (granted) changes.push(`<@${r.discord_id}> earned **League Veteran**`);
  }
}

async function seedMrPerfectIfWildcard(guildId: string, changes: string[]): Promise<void> {
  const season = await getOrCreateActiveSeason(guildId).catch(() => null);
  if (!season || String((season as any).currentWeek).toLowerCase() !== "wildcard") return;

  const rows = await rowsOf<{ discord_id: string }>(sql`
    select discord_id
    from team_season_stats
    where season_id = ${season.id}
      and discord_id is not null
      and wins = 17
      and losses = 0
      and coalesce(ties, 0) = 0
  `).catch(() => []);

  for (const r of rows) {
    const granted = await grantGlobal(r.discord_id, "mr_perfect", guildId, "Finished regular season 17-0");
    if (granted) changes.push(`<@${r.discord_id}> earned **Mr Perfect**`);
  }
}

async function seedSbWinners(guildId: string, changes: string[]): Promise<Set<string>> {
  const rows = await rowsOf<{ discord_id: string }>(sql`
    select discord_id
    from economy_users
    where all_time_superbowl_wins > 0
  `).catch(() => []);

  const out = new Set<string>();
  for (const r of rows) {
    out.add(String(r.discord_id));
    const granted = await grantGlobal(r.discord_id, "sb_winner", guildId, "Recorded Super Bowl winner");
    if (granted) changes.push(`<@${r.discord_id}> earned **SB Winner**`);
  }
  return out;
}

const STEADY_STREAMER_MIN_CURRENT_SEASON_GAME_STREAM_RATE = 0.5;
const STEADY_STREAMER_RECENT_STREAM_FALLBACK_COUNT = 60;

async function getStreamerUsers(guildId: string): Promise<Set<string>> {
  const active = await getOrCreateActiveSeason(guildId).catch(() => null);
  const rows = await rowsOf<{ discord_id: string; recent_stream_events: number; eligible_games: number; stream_events: number; stream_rate: string | number }>(sql`
    with eligible_games as (
      select away_discord_id as discord_id, id::text as game_key
      from game_schedules
      where guild_id = ${guildId}
        and (${active?.id ?? null}::integer is null or season_id = ${active?.id ?? null})
        and away_discord_id is not null
        and home_discord_id is not null
        and coalesce(status, '') not in ('cancelled', 'pending')
      union all
      select home_discord_id as discord_id, id::text as game_key
      from game_schedules
      where guild_id = ${guildId}
        and (${active?.id ?? null}::integer is null or season_id = ${active?.id ?? null})
        and away_discord_id is not null
        and home_discord_id is not null
        and coalesce(status, '') not in ('cancelled', 'pending')
    ),
    eligible_counts as (
      select discord_id, count(distinct game_key)::int as eligible_games
      from eligible_games
      group by discord_id
    ),
    streamer_paid_events as (
      select
        discord_id,
        concat('pending:', coalesce(guild_id, ''), ':', coalesce(season_id::text, ''), ':', coalesce(week, ''), ':', coalesce(discord_id, '')) as stream_key,
        guild_id,
        season_id,
        created_at
      from pending_channel_payouts
      where type = 'stream'
        and status = 'approved'
        and discord_id is not null

      union

      select
        discord_id,
        concat('tx:', coalesce(guild_id, ''), ':', coalesce(description, ''), ':', created_at::date::text, ':', coalesce(discord_id, '')) as stream_key,
        guild_id,
        season_id,
        created_at
      from coin_transactions
      where discord_id is not null
        and amount > 0
        and type in ('payout', 'addcoins')
        and (
          related_user_id = 'stream'
          or lower(description) like '%stream payout%'
          or lower(description) like '%auto stream%'
          or lower(description) like '%cpu stream%'
        )
    ),
    current_stream_counts as (
      select discord_id, count(distinct stream_key)::int as stream_events
      from streamer_paid_events
      where guild_id = ${guildId}
        and (${active?.id ?? null}::integer is null or season_id = ${active?.id ?? null})
      group by discord_id
    ),
    recent_stream_counts as (
      select discord_id, count(distinct stream_key)::int as recent_stream_events
      from streamer_paid_events
      where created_at >= now() - interval '120 days'
      group by discord_id
    )
    select
      coalesce(ec.discord_id, rsc.discord_id) as discord_id,
      coalesce(rsc.recent_stream_events, 0)::int as recent_stream_events,
      coalesce(ec.eligible_games, 0)::int as eligible_games,
      least(coalesce(csc.stream_events, 0), coalesce(ec.eligible_games, 0))::int as stream_events,
      (least(coalesce(csc.stream_events, 0), coalesce(ec.eligible_games, 0))::numeric / greatest(coalesce(ec.eligible_games, 0), 1)) as stream_rate
    from eligible_counts ec
    full join recent_stream_counts rsc on rsc.discord_id = ec.discord_id
    left join current_stream_counts csc on csc.discord_id = coalesce(ec.discord_id, rsc.discord_id)
    where coalesce(rsc.recent_stream_events, 0) >= ${STEADY_STREAMER_RECENT_STREAM_FALLBACK_COUNT}
       or (
         coalesce(ec.eligible_games, 0) > 0
         and (least(coalesce(csc.stream_events, 0), coalesce(ec.eligible_games, 0))::numeric / greatest(coalesce(ec.eligible_games, 0), 1)) >= ${STEADY_STREAMER_MIN_CURRENT_SEASON_GAME_STREAM_RATE}
       )
  `).catch(() => []);

  return new Set(rows.map((r) => String(r.discord_id)));
}


async function getHeavySweaters(_guildId: string): Promise<Set<string>> {
  const rows = await rowsOf<{ discord_id: string }>(sql`
    with games as (
      select away_discord_id as discord_id,
             case when winner_discord_id = away_discord_id then 1 else 0 end as win,
             case when winner_discord_id = home_discord_id then 1 else 0 end as loss,
             case when winner_discord_id is null then 1 else 0 end as tie,
             (coalesce(away_score,0) - coalesce(home_score,0)) as point_diff
      from game_schedules
      where away_discord_id is not null
        and home_discord_id is not null
        and away_discord_id <> home_discord_id
        and away_score is not null
        and home_score is not null
      union all
      select home_discord_id as discord_id,
             case when winner_discord_id = home_discord_id then 1 else 0 end as win,
             case when winner_discord_id = away_discord_id then 1 else 0 end as loss,
             case when winner_discord_id is null then 1 else 0 end as tie,
             (coalesce(home_score,0) - coalesce(away_score,0)) as point_diff
      from game_schedules
      where away_discord_id is not null
        and home_discord_id is not null
        and away_discord_id <> home_discord_id
        and away_score is not null
        and home_score is not null
    )
    select discord_id
    from games
    where discord_id is not null
    group by discord_id
    having (sum(win) + sum(loss) + sum(tie)) >= 15
       and (sum(point_diff)::numeric / greatest((sum(win) + sum(loss) + sum(tie)), 1)) >= 17
  `).catch(() => []);
  return new Set(rows.map((r) => String(r.discord_id)));
}


async function getLeaderByTeamStats(guildId: string, metric: "trenches" | "gimme"): Promise<string | null> {
  const season = await getOrCreateActiveSeason(guildId).catch(() => null);
  if (!season) return null;
  const orderExpr = metric === "trenches"
    ? sql`(coalesce(team_sacks,0)) desc`
    : sql`(coalesce(team_ints,0)) desc`;
  const rows = await rowsOf<{ discord_id: string }>(sql`
    select discord_id
    from team_season_stats
    where season_id = ${season.id}
      and discord_id is not null
    order by ${orderExpr}
    limit 1
  `).catch(() => []);
  return rows[0]?.discord_id ? String(rows[0].discord_id) : null;
}

async function getPlaycallRoles(guildId: string): Promise<{ smash: Set<string>; air: Set<string> }> {
  const season = await getOrCreateActiveSeason(guildId).catch(() => null);
  const smash = new Set<string>();
  const air = new Set<string>();
  if (!season) return { smash, air };

  const rows = await rowsOf<{ discord_id: string; pass_att: number; rush_att: number }>(sql`
    select discord_id,
           sum(coalesce(pass_att,0))::int as pass_att,
           sum(coalesce(rush_att,0))::int as rush_att
    from player_season_stats
    where season_id = ${season.id}
      and discord_id is not null
    group by discord_id
  `).catch(() => []);

  for (const r of rows) {
    const pass = Number(r.pass_att ?? 0);
    const rush = Number(r.rush_att ?? 0);
    const total = pass + rush;
    if (total < 300) continue;
    if (rush / total >= 0.6) smash.add(String(r.discord_id));
    if (pass / total >= 0.65) air.add(String(r.discord_id));
  }
  return { smash, air };
}

async function postRoleUpdate(_guild: Guild, _lines: string[]) {
  // Public weekly role-update posts are disabled. Role changes still happen, but
  // the bot no longer posts earned/lost role summaries into general chat.
}


async function applyGlobalRoleEntitlements(member: GuildMember, entitlements: Set<string>, changes: string[]) {
  const roleMap: Record<string, string> = {
    rec_og: "REC League OG",
    league_veteran: "League Veteran",
    mr_perfect: "Mr Perfect",
    sb_winner: "SB Winner",
  };
  for (const [key, roleName] of Object.entries(roleMap)) {
    if (entitlements.has(key)) await setMemberRole(member, roleName, true, changes);
  }
}


async function getDefendingChampionId(guildId: string): Promise<string | null> {
  const active = await getOrCreateActiveSeason(guildId).catch(() => null);
  if (!active) return null;
  const rows = await rowsOf<{ champion_discord_id: string }>(sql`
    select champion_discord_id
    from rec_guild_defending_champions
    where guild_id = ${guildId}
      and season_id = ${active.id}
    order by updated_at desc
    limit 1
  `).catch(() => []);
  if (rows[0]?.champion_discord_id) return String(rows[0].champion_discord_id);

  const priorSeason = await rowsOf<{ id: number }>(sql`
    select id
    from seasons
    where guild_id = ${guildId}
      and id < ${active.id}
    order by id desc
    limit 1
  `).catch(() => []);
  const priorSeasonId = priorSeason[0]?.id;
  if (!priorSeasonId) return null;

  const sb = await rowsOf<{ winner_discord_id: string }>(sql`
    select coalesce(winner_discord_id, imported_winner_discord_id) as winner_discord_id
    from game_schedules
    where guild_id = ${guildId}
      and season_id = ${priorSeasonId}
      and week_index in (1022, 22)
      and coalesce(winner_discord_id, imported_winner_discord_id) is not null
    order by coalesce(finished_at, updated_at, created_at) desc
    limit 1
  `).catch(() => []);

  const championId = sb[0]?.winner_discord_id ? String(sb[0].winner_discord_id) : null;
  if (championId) {
    await db.execute(sql`
      insert into rec_guild_defending_champions (guild_id, season_id, champion_discord_id, source)
      values (${guildId}, ${active.id}, ${championId}, 'game_schedules_previous_super_bowl')
      on conflict (guild_id, season_id)
      do update set champion_discord_id = excluded.champion_discord_id, source = excluded.source, updated_at = now()
    `).catch(() => null);
  }
  return championId;
}

export async function recalculateLeagueRolesOnAdvance(guild: Guild): Promise<void> {
  await ensureRoleTables();
  const guildId = guild.id;
  const changes: string[] = [];
  await guild.members.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);

  await seedOgOnce(guildId, changes);
  await seedLeagueVeterans(guildId, changes);
  await seedMrPerfectIfWildcard(guildId, changes);
  await seedSbWinners(guildId, changes);
  const defendingChampionId = await getDefendingChampionId(guildId);

  const [users, steady, sweaters, trenchesLeader, gimmeLeader, playcalls] = await Promise.all([
    getGuildUsers(guildId),
    getStreamerUsers(guildId),
    getHeavySweaters(guildId),
    getLeaderByTeamStats(guildId, "trenches"),
    getLeaderByTeamStats(guildId, "gimme"),
    getPlaycallRoles(guildId),
  ]);

  for (const u of users) {
    const member = await guild.members.fetch(u.discord_id).catch(() => null);
    if (!member) continue;

    const entitlements = await globalRoleKeys(u.discord_id);
    await applyGlobalRoleEntitlements(member, entitlements, changes);

    await setMemberRole(member, "Steady Streamer", steady.has(u.discord_id), changes);
    await setMemberRole(member, "Heavy Sweater", sweaters.has(u.discord_id), changes);
    await setMemberRole(member, "Terror in the Trenches", trenchesLeader === u.discord_id, changes);
    await setMemberRole(member, "Mr Gimme Dat", gimmeLeader === u.discord_id, changes);
    await setMemberRole(member, "Smashmouth Football", playcalls.smash.has(u.discord_id), changes);
    await setMemberRole(member, "Air it Out", playcalls.air.has(u.discord_id), changes);

    const hotCold = await getHotColdRoleState(u.discord_id);
    await setMemberRole(member, "Hot Streak", hotCold === "hot", changes);
    await setMemberRole(member, "Cold Streak", hotCold === "cold", changes);
    await setMemberRole(member, "Reigning Champion 🏆", defendingChampionId === u.discord_id, changes);
  }

  await postRoleUpdate(guild, changes);
}

export async function renderLeagueRoles(interaction: any, page = 0): Promise<void> {
  await ensureRoleTables();
  const guild = interaction.guild!;
  await guild.roles.fetch().catch(() => null);
  await guild.members.fetch().catch(() => null);

  const groups = [
    { title: "Core Roles", items: LEAGUE_ROLE_DEFS.filter((r) => r.type === "core") },
    { title: "Performance Roles", items: LEAGUE_ROLE_DEFS.filter((r) => r.type === "performance") },
  ];

  const safePage = Math.max(0, Math.min(page, groups.length - 1));
  const group = groups[safePage]!;
  const lines = group.items.map((def) => {
    let holders = "_None currently._";
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === def.label.toLowerCase());
    if (role) {
      const members = guild.members.cache.filter((m) => m.roles.cache.has(role.id));
      holders = members.size ? members.map((m) => `<@${m.id}>`).slice(0, 12).join(", ") : holders;
    }

    return `**${def.label}**
${def.description}
*Earned:* ${def.criteria}
*Current:* ${holders}`;
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
