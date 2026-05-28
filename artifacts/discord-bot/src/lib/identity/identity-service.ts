import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { GuildMember, User } from "discord.js";

export interface IdentityUserInput {
  discordId: string;
  username?: string | null;
  globalName?: string | null;
  avatarUrl?: string | null;
}

export interface GuildMembershipInput extends IdentityUserInput {
  guildId: string;
  displayName?: string | null;
  serverNickname?: string | null;
  isAdmin?: boolean;
  isCommissioner?: boolean;
  joinedAt?: Date | null;
}

export interface FranchiseTeamOwnerInput {
  guildId: string;
  seasonId: number;
  teamName: string;
  teamId?: number | null;
  discordId?: string | null;
  eaUserName?: string | null;
  isHuman?: boolean;
  source?: string;
}

function userInputFromDiscordUser(user: User): IdentityUserInput {
  return {
    discordId: user.id,
    username: user.username,
    globalName: user.globalName,
    avatarUrl: user.displayAvatarURL?.() ?? null,
  };
}

export function membershipInputFromGuildMember(member: GuildMember): GuildMembershipInput {
  return {
    ...userInputFromDiscordUser(member.user),
    guildId: member.guild.id,
    displayName: member.displayName,
    serverNickname: member.nickname,
    joinedAt: member.joinedAt,
  };
}

export async function upsertDiscordUser(input: IdentityUserInput): Promise<void> {
  if (!input.discordId) return;
  await db.execute(sql`
    insert into discord_users (discord_id, username, global_name, avatar_url, first_seen_at, last_seen_at, updated_at)
    values (${input.discordId}, ${input.username ?? null}, ${input.globalName ?? null}, ${input.avatarUrl ?? null}, now(), now(), now())
    on conflict (discord_id) do update set
      username = coalesce(excluded.username, discord_users.username),
      global_name = coalesce(excluded.global_name, discord_users.global_name),
      avatar_url = coalesce(excluded.avatar_url, discord_users.avatar_url),
      last_seen_at = now(),
      updated_at = now()
  `);
}

export async function upsertGuildMembership(input: GuildMembershipInput): Promise<void> {
  if (!input.discordId || !input.guildId) return;
  await upsertDiscordUser(input);
  await db.execute(sql`
    insert into guild_memberships (
      guild_id, discord_id, display_name, server_nickname, is_admin, is_commissioner,
      joined_at, first_seen_at, last_seen_at, updated_at
    ) values (
      ${input.guildId}, ${input.discordId}, ${input.displayName ?? null}, ${input.serverNickname ?? null},
      ${Boolean(input.isAdmin)}, ${Boolean(input.isCommissioner)}, ${input.joinedAt ?? null}, now(), now(), now()
    )
    on conflict (guild_id, discord_id) do update set
      display_name = coalesce(excluded.display_name, guild_memberships.display_name),
      server_nickname = excluded.server_nickname,
      is_admin = excluded.is_admin,
      is_commissioner = excluded.is_commissioner,
      joined_at = coalesce(guild_memberships.joined_at, excluded.joined_at),
      last_seen_at = now(),
      updated_at = now()
  `);
}

export async function observeInteractionMember(member: GuildMember | null | undefined): Promise<void> {
  if (!member) return;
  await upsertGuildMembership(membershipInputFromGuildMember(member));
}

export async function upsertGuildFranchise(guildId: string, seasonId: number, opts?: {
  eaLeagueId?: number | null;
  leagueName?: string | null;
  currentWeek?: string | null;
  isActive?: boolean;
}): Promise<void> {
  await db.execute(sql`
    insert into guild_franchises (guild_id, season_id, ea_league_id, league_name, current_week, is_active, created_at, updated_at)
    values (${guildId}, ${seasonId}, ${opts?.eaLeagueId ?? null}, ${opts?.leagueName ?? null}, ${opts?.currentWeek ?? null}, ${opts?.isActive ?? true}, now(), now())
    on conflict (guild_id, season_id) do update set
      ea_league_id = coalesce(excluded.ea_league_id, guild_franchises.ea_league_id),
      league_name = coalesce(excluded.league_name, guild_franchises.league_name),
      current_week = coalesce(excluded.current_week, guild_franchises.current_week),
      is_active = excluded.is_active,
      updated_at = now()
  `);
}

export async function upsertFranchiseTeamOwner(input: FranchiseTeamOwnerInput): Promise<void> {
  await upsertGuildFranchise(input.guildId, input.seasonId);
  await db.execute(sql`
    insert into guild_franchise_user_teams (
      guild_id, season_id, team_id, team_name, discord_id, ea_user_name, is_human, source,
      first_seen_at, last_seen_at, updated_at
    ) values (
      ${input.guildId}, ${input.seasonId}, ${input.teamId ?? null}, ${input.teamName}, ${input.discordId ?? null},
      ${input.eaUserName ?? null}, ${Boolean(input.isHuman)}, ${input.source ?? "sync"}, now(), now(), now()
    )
    on conflict (guild_id, season_id, team_name) do update set
      team_id = coalesce(excluded.team_id, guild_franchise_user_teams.team_id),
      discord_id = coalesce(excluded.discord_id, guild_franchise_user_teams.discord_id),
      ea_user_name = coalesce(excluded.ea_user_name, guild_franchise_user_teams.ea_user_name),
      is_human = excluded.is_human,
      source = excluded.source,
      last_seen_at = now(),
      updated_at = now()
  `);
}

export async function resolveGuildMemberIdentity(guildId: string, discordId: string): Promise<any | null> {
  const result = await db.execute(sql`
    select
      du.discord_id,
      du.username,
      du.global_name,
      gm.guild_id,
      gm.display_name,
      gm.server_nickname,
      gm.is_admin,
      gm.is_commissioner,
      eu.balance,
      eu.team,
      eu.ea_id
    from discord_users du
    left join guild_memberships gm
      on gm.discord_id = du.discord_id and gm.guild_id = ${guildId}
    left join economy_users eu
      on eu.discord_id = du.discord_id and eu.guild_id = ${guildId}
    where du.discord_id = ${discordId}
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  return rows[0] ?? null;
}

export async function resolveCurrentTeamOwner(guildId: string, seasonId: number, teamName: string): Promise<any | null> {
  const result = await db.execute(sql`
    select *
    from guild_franchise_user_teams
    where guild_id = ${guildId}
      and season_id = ${seasonId}
      and lower(team_name) = lower(${teamName})
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  return rows[0] ?? null;
}

export async function backfillIdentityFromLegacyTables(): Promise<void> {
  await db.execute(sql`
    insert into discord_users (discord_id, username, first_seen_at, last_seen_at, updated_at)
    select distinct discord_id, max(discord_username), now(), now(), now()
    from economy_users
    where discord_id is not null and discord_id <> ''
    group by discord_id
    on conflict (discord_id) do update set
      username = coalesce(discord_users.username, excluded.username),
      last_seen_at = now(),
      updated_at = now()
  `);

  await db.execute(sql`
    insert into guild_memberships (guild_id, discord_id, display_name, server_nickname, is_admin, first_seen_at, last_seen_at, updated_at)
    select distinct guild_id, discord_id, max(discord_username), max(server_nickname), bool_or(coalesce(is_admin, false)), now(), now(), now()
    from economy_users
    where guild_id is not null and guild_id <> '' and discord_id is not null and discord_id <> ''
    group by guild_id, discord_id
    on conflict (guild_id, discord_id) do update set
      display_name = coalesce(guild_memberships.display_name, excluded.display_name),
      server_nickname = coalesce(guild_memberships.server_nickname, excluded.server_nickname),
      is_admin = guild_memberships.is_admin or excluded.is_admin,
      last_seen_at = now(),
      updated_at = now()
  `);

  await db.execute(sql`
    insert into guild_franchise_user_teams (guild_id, season_id, team_id, team_name, discord_id, ea_user_name, is_human, source, first_seen_at, last_seen_at, updated_at)
    select distinct
      coalesce(eu.guild_id, '1476251181524189438') as guild_id,
      fmt.season_id::int as season_id,
      fmt.team_id::int as team_id,
      coalesce(fmt.full_name, eu.team) as team_name,
      coalesce(fmt.discord_id, eu.discord_id) as discord_id,
      fmt.user_name as ea_user_name,
      coalesce(fmt.is_human, false) as is_human,
      'legacy-backfill' as source,
      now(), now(), now()
    from franchise_mca_teams fmt
    left join economy_users eu
      on lower(eu.team) = lower(fmt.full_name)
      and (eu.guild_id is not null)
    where coalesce(fmt.full_name, eu.team) is not null
    on conflict (guild_id, season_id, team_name) do update set
      team_id = coalesce(excluded.team_id, guild_franchise_user_teams.team_id),
      discord_id = coalesce(excluded.discord_id, guild_franchise_user_teams.discord_id),
      ea_user_name = coalesce(excluded.ea_user_name, guild_franchise_user_teams.ea_user_name),
      is_human = excluded.is_human,
      source = excluded.source,
      last_seen_at = now(),
      updated_at = now()
  `);
}
