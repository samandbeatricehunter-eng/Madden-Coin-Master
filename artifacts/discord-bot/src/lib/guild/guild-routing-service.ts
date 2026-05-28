import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type GuildRouteKey =
  | "commissioner_office"
  | "gameday_category"
  | "gameday_announcements"
  | "gameday_review"
  | "general"
  | "gotw"
  | "goty"
  | "historical_records"
  | "league_news"
  | "power_rankings"
  | "rules"
  | string;

export type GuildDiscordRoute = {
  guildId: string;
  routeKey: GuildRouteKey;
  channelId: string | null;
  categoryId: string | null;
  roleId: string | null;
  messageId: string | null;
  label: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

export async function getGuildRoute(guildId: string, routeKey: GuildRouteKey): Promise<GuildDiscordRoute | null> {
  const { rows } = await db.execute(sql`
    select
      guild_id as "guildId",
      route_key as "routeKey",
      channel_id as "channelId",
      category_id as "categoryId",
      role_id as "roleId",
      message_id as "messageId",
      label,
      enabled,
      metadata
    from guild_discord_routes
    where guild_id = ${guildId}
      and route_key = ${routeKey}
      and enabled = true
    limit 1
  `);

  return (rows[0] as GuildDiscordRoute | undefined) ?? null;
}

export async function requireGuildRoute(guildId: string, routeKey: GuildRouteKey): Promise<GuildDiscordRoute> {
  const route = await getGuildRoute(guildId, routeKey);
  if (!route) throw new Error(`Missing guild route ${routeKey} for guild ${guildId}`);
  return route;
}

export async function upsertGuildRoute(input: {
  guildId: string;
  routeKey: GuildRouteKey;
  channelId?: string | null;
  categoryId?: string | null;
  roleId?: string | null;
  messageId?: string | null;
  label?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    insert into guild_discord_routes (
      guild_id, route_key, channel_id, category_id, role_id, message_id, label, enabled, metadata, updated_at
    ) values (
      ${input.guildId},
      ${input.routeKey},
      ${input.channelId ?? null},
      ${input.categoryId ?? null},
      ${input.roleId ?? null},
      ${input.messageId ?? null},
      ${input.label ?? null},
      ${input.enabled ?? true},
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      now()
    )
    on conflict (guild_id, route_key) do update set
      channel_id = excluded.channel_id,
      category_id = excluded.category_id,
      role_id = excluded.role_id,
      message_id = excluded.message_id,
      label = excluded.label,
      enabled = excluded.enabled,
      metadata = excluded.metadata,
      updated_at = now()
  `);
}

export async function getGuildFeature(guildId: string, featureKey: string): Promise<{ enabled: boolean; config: Record<string, unknown> } | null> {
  const { rows } = await db.execute(sql`
    select enabled, config
    from guild_feature_config
    where guild_id = ${guildId}
      and feature_key = ${featureKey}
    limit 1
  `);

  const row = rows[0] as { enabled: boolean; config: Record<string, unknown> } | undefined;
  return row ?? null;
}

export async function isGuildFeatureEnabled(guildId: string, featureKey: string, defaultValue = true): Promise<boolean> {
  const feature = await getGuildFeature(guildId, featureKey);
  return feature?.enabled ?? defaultValue;
}

export async function logGuildEvent(input: {
  guildId: string;
  eventType: string;
  actorDiscordId?: string | null;
  targetDiscordId?: string | null;
  seasonId?: number | null;
  weekIndex?: number | null;
  entityType?: string | null;
  entityId?: string | number | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    insert into guild_operational_events (
      guild_id, event_type, actor_discord_id, target_discord_id, season_id, week_index,
      entity_type, entity_id, correlation_id, payload
    ) values (
      ${input.guildId},
      ${input.eventType},
      ${input.actorDiscordId ?? null},
      ${input.targetDiscordId ?? null},
      ${input.seasonId ?? null},
      ${input.weekIndex ?? null},
      ${input.entityType ?? null},
      ${input.entityId == null ? null : String(input.entityId)},
      ${input.correlationId ?? null},
      ${JSON.stringify(input.payload ?? {})}::jsonb
    )
  `);
}
