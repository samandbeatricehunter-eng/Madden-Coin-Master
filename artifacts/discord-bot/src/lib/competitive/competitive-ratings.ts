import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../db/db-helpers.js";
import { getCompletedH2HResults, getCurrentSeasonH2HOpponents, getCurrentSeasonRemainingH2HOpponents } from "../canonical/canonical-game-service.js";

type RatingRow = {
  discord_id: string;
  display_name: string;
  team: string | null;
  competitive_rating: number;
  rating_rank: number;
  strength_of_schedule: number | null;
  schedule_rank: number | null;
  h2h_schedule_games: number;
  label: string;
  toughest_remaining_opponent_id?: string | null;
  toughest_remaining_opponent_name?: string | null;
  toughest_remaining_opponent_team?: string | null;
  toughest_remaining_opponent_rating?: number | null;
  toughest_remaining_opponent_week?: number | null;
};

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}
const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
function scheduleLabel(value: number | null, h2hGames: number): string {
  if (!value || h2hGames <= 0) return "No H2H Opponents — easiest schedule possible.";
  if (value >= 90) return "Brutal Schedule";
  if (value >= 80) return "Very Tough Schedule";
  if (value >= 70) return "Tough Schedule";
  if (value >= 60) return "Average Schedule";
  if (value >= 50) return "Light Schedule";
  return "Soft Schedule";
}

export async function ensureCompetitiveRatingsSchema(): Promise<void> {
  await db.execute(sql`
    create table if not exists rec_competitive_ratings_cache (
      guild_id text not null,
      season_id integer not null,
      discord_id text not null,
      display_name text not null default '',
      team text,
      competitive_rating integer not null default 50,
      rating_rank integer,
      strength_of_schedule numeric(6,2),
      schedule_rank integer,
      h2h_games integer not null default 0,
      h2h_schedule_games integer not null default 0,
      label text not null default 'No H2H Opponents — easiest schedule possible.',
      toughest_remaining_opponent_id text,
      toughest_remaining_opponent_name text,
      toughest_remaining_opponent_team text,
      toughest_remaining_opponent_rating integer,
      toughest_remaining_opponent_week integer,
      computed_at timestamptz not null default now(),
      primary key (guild_id, season_id, discord_id)
    )
  `);
  await db.execute(sql`alter table rec_competitive_ratings_cache add column if not exists toughest_remaining_opponent_id text`);
  await db.execute(sql`alter table rec_competitive_ratings_cache add column if not exists toughest_remaining_opponent_name text`);
  await db.execute(sql`alter table rec_competitive_ratings_cache add column if not exists toughest_remaining_opponent_team text`);
  await db.execute(sql`alter table rec_competitive_ratings_cache add column if not exists toughest_remaining_opponent_rating integer`);
  await db.execute(sql`alter table rec_competitive_ratings_cache add column if not exists toughest_remaining_opponent_week integer`);
}

function baseRating(stats: { games: number; wins: number; losses: number; pointDiff: number; recent: number[] }): number {
  if (stats.games <= 0) return 50;
  const winRate = (stats.wins / Math.max(1, stats.wins + stats.losses)) * 100;
  const pd = clamp(50 + (stats.pointDiff / Math.max(1, stats.games)) * 2);
  const recent = stats.recent.slice(-5);
  const recentScore = recent.length ? (recent.reduce((a,b)=>a+b,0) / recent.length) * 100 : winRate;
  const raw = winRate * 0.40 + pd * 0.30 + recentScore * 0.20 + 50 * 0.10;
  const sample = Math.min(stats.games / 5, 1);
  return raw * sample + 50 * (1 - sample);
}

async function completedH2hRows(): Promise<Array<{ away: string; home: string; away_score: number; home_score: number; winner: string | null }>> {
  return getCompletedH2HResults();
}


export async function refreshCompetitiveRatings(guildId: string): Promise<RatingRow[]> {
  await ensureCompetitiveRatingsSchema();
  const activeSeason = await getOrCreateActiveSeason(guildId);
  const users = await rowsOf<{ discord_id: string; display_name: string; team: string | null }>(sql`
    select discord_id, coalesce(nullif(server_nickname,''), nullif(discord_username,''), discord_id) as display_name, team
    from economy_users
    where guild_id=${guildId} and discord_id not like 'unlinked_%' and team is not null and team <> ''
  `);

  const stats = new Map<string, { games: number; wins: number; losses: number; pointDiff: number; recent: number[]; beaten: string[] }>();
  const get = (id: string) => {
    let v = stats.get(id);
    if (!v) { v = { games: 0, wins: 0, losses: 0, pointDiff: 0, recent: [], beaten: [] }; stats.set(id, v); }
    return v;
  };
  for (const g of await completedH2hRows()) {
    const a = get(g.away), h = get(g.home);
    a.games++; h.games++;
    a.pointDiff += g.away_score - g.home_score;
    h.pointDiff += g.home_score - g.away_score;
    const aWin = g.winner ? g.winner === g.away : g.away_score > g.home_score;
    const hWin = g.winner ? g.winner === g.home : g.home_score > g.away_score;
    if (aWin && !hWin) { a.wins++; h.losses++; a.recent.push(1); h.recent.push(0); a.beaten.push(g.home); }
    else if (hWin && !aWin) { h.wins++; a.losses++; h.recent.push(1); a.recent.push(0); h.beaten.push(g.away); }
    else { a.recent.push(0.5); h.recent.push(0.5); }
  }

  const base = new Map<string, number>();
  for (const [id, st] of stats) base.set(id, baseRating(st));
  const finalRating = new Map<string, number>();
  for (const [id, st] of stats) {
    const quality = st.beaten.length ? st.beaten.reduce((sum, opp) => sum + (base.get(opp) ?? 50), 0) / st.beaten.length : 50;
    finalRating.set(id, Math.round(clamp(baseRating(st) * 0.90 + quality * 0.10)));
  }

  const opponentSource = await getCurrentSeasonH2HOpponents(guildId);
  const remainingOpponentSource = await getCurrentSeasonRemainingH2HOpponents(guildId);
  const opponents = new Map<string, Set<string>>();
  const opponentWeeks = new Map<string, Map<string, number>>();
  for (const r of opponentSource.rows as any[]) {
    const id = String(r.user_id).trim();
    const opp = String(r.opponent_id).trim();
    const week = Number(r.week_index ?? r.week_number ?? 0);
    if (!id || !opp || id === opp) continue;
    const set = opponents.get(id) ?? new Set<string>();
    set.add(opp);
    opponents.set(id, set);
      }

  // Populate earliest remaining scheduled week for each user/opponent.
  for (const r of remainingOpponentSource.rows as any[]) {
    const id = String(r.user_id).trim();
    const opp = String(r.opponent_id).trim();
    const week = Number(r.week_number ?? r.week_index ?? 0);
    if (!id || !opp || id === opp || !Number.isFinite(week)) continue;
    const weekMap = opponentWeeks.get(id) ?? new Map<string, number>();
    const existing = weekMap.get(opp);
    if (existing == null || (week > 0 && week < existing)) weekMap.set(opp, week);
    opponentWeeks.set(id, weekMap);
  }

  const userById = new Map(users.map((u) => [String(u.discord_id).trim(), u]));

  const rows: RatingRow[] = users.map((u) => {
    const userId = String(u.discord_id).trim();
    const opps = Array.from(opponents.get(userId) ?? []);
    const sos = opps.length ? opps.reduce((sum, opp) => sum + (finalRating.get(opp) ?? 50), 0) / opps.length : null;
    const remainingIds = Array.from(opponentWeeks.get(userId)?.keys() ?? []);
    const toughestId = remainingIds.length
      ? remainingIds.sort((a, b) => (finalRating.get(b) ?? 50) - (finalRating.get(a) ?? 50) || (opponentWeeks.get(userId)?.get(a) ?? 999) - (opponentWeeks.get(userId)?.get(b) ?? 999))[0]
      : null;
    const toughestUser = toughestId ? userById.get(toughestId) : null;
    const toughestRating = toughestId ? (finalRating.get(toughestId) ?? 50) : null;
    const toughestWeek = toughestId ? (opponentWeeks.get(userId)?.get(toughestId) ?? null) : null;
    return {
      discord_id: u.discord_id,
      display_name: u.display_name,
      team: u.team,
      competitive_rating: finalRating.get(u.discord_id) ?? 50,
      rating_rank: 0,
      strength_of_schedule: sos == null ? null : Number(sos.toFixed(2)),
      schedule_rank: null,
      h2h_schedule_games: opps.length,
      label: scheduleLabel(sos, opps.length),
      toughest_remaining_opponent_id: toughestId,
      toughest_remaining_opponent_name: toughestUser?.display_name ?? toughestId,
      toughest_remaining_opponent_team: toughestUser?.team ?? null,
      toughest_remaining_opponent_rating: toughestRating,
      toughest_remaining_opponent_week: toughestWeek,
    };
  });
  [...rows].sort((a,b)=>b.competitive_rating-a.competitive_rating).forEach((r,i)=>r.rating_rank=i+1);
  [...rows].filter(r=>r.h2h_schedule_games>0 && r.strength_of_schedule!=null).sort((a,b)=>Number(b.strength_of_schedule)-Number(a.strength_of_schedule)).forEach((r,i)=>r.schedule_rank=i+1);

  if (process.env.DEBUG_COMPETITIVE_RATINGS === "true") {
    console.log("[competitive-ratings] refresh", { guildId, activeSeasonId: activeSeason.id, linkedUsers: users.length, opponentRows: opponentSource.rows.length, remainingOpponentRows: remainingOpponentSource.rows.length, mappedRecSeasonIds: opponentSource.recSeasonIds, usersWithOpponents: rows.filter(r=>r.h2h_schedule_games>0).length, usersWithCompletedGames: [...stats.keys()].length });
  }

  for (const r of rows) {
    await db.execute(sql`
      insert into rec_competitive_ratings_cache (guild_id, season_id, discord_id, display_name, team, competitive_rating, rating_rank, strength_of_schedule, schedule_rank, h2h_games, h2h_schedule_games, label, toughest_remaining_opponent_id, toughest_remaining_opponent_name, toughest_remaining_opponent_team, toughest_remaining_opponent_rating, toughest_remaining_opponent_week, computed_at)
      values (${guildId}, ${activeSeason.id}, ${r.discord_id}, ${r.display_name}, ${r.team}, ${r.competitive_rating}, ${r.rating_rank}, ${r.strength_of_schedule}, ${r.schedule_rank}, ${stats.get(r.discord_id)?.games ?? 0}, ${r.h2h_schedule_games}, ${r.label}, ${r.toughest_remaining_opponent_id}, ${r.toughest_remaining_opponent_name}, ${r.toughest_remaining_opponent_team}, ${r.toughest_remaining_opponent_rating}, ${r.toughest_remaining_opponent_week}, now())
      on conflict (guild_id, season_id, discord_id) do update set
        display_name=excluded.display_name, team=excluded.team, competitive_rating=excluded.competitive_rating,
        rating_rank=excluded.rating_rank, strength_of_schedule=excluded.strength_of_schedule,
        schedule_rank=excluded.schedule_rank, h2h_games=excluded.h2h_games,
        h2h_schedule_games=excluded.h2h_schedule_games, label=excluded.label,
        toughest_remaining_opponent_id=excluded.toughest_remaining_opponent_id,
        toughest_remaining_opponent_name=excluded.toughest_remaining_opponent_name,
        toughest_remaining_opponent_team=excluded.toughest_remaining_opponent_team,
        toughest_remaining_opponent_rating=excluded.toughest_remaining_opponent_rating,
        toughest_remaining_opponent_week=excluded.toughest_remaining_opponent_week,
        computed_at=now()
    `);
  }
  return rows;
}

async function loadRows(guildId: string): Promise<RatingRow[]> {
  await ensureCompetitiveRatingsSchema();
  const season = await getOrCreateActiveSeason(guildId);
  let rows = await rowsOf<RatingRow>(sql`
    select discord_id, display_name, team, competitive_rating, rating_rank, strength_of_schedule::float as strength_of_schedule, schedule_rank, h2h_schedule_games, label, toughest_remaining_opponent_id, toughest_remaining_opponent_name, toughest_remaining_opponent_team, toughest_remaining_opponent_rating, toughest_remaining_opponent_week
    from rec_competitive_ratings_cache
    where guild_id=${guildId} and season_id=${season.id}
    order by rating_rank asc
  `);
  if (!rows.length || rows.every((r:any) => Number(r.h2h_schedule_games ?? 0) === 0)) rows = await refreshCompetitiveRatings(guildId);
  return rows;
}
function pageRows(rows: RatingRow[], page: number, by: "rating" | "sos"): RatingRow[] {
  const sorted = by === "rating" ? [...rows].sort((a,b)=>b.competitive_rating-a.competitive_rating) : [...rows].sort((a,b)=> {
    const av = a.h2h_schedule_games > 0 ? Number(a.strength_of_schedule ?? -1) : -1;
    const bv = b.h2h_schedule_games > 0 ? Number(b.strength_of_schedule ?? -1) : -1;
    return bv - av;
  });
  return sorted.slice(page*10, page*10+10);
}
export async function renderCompetitiveRating(interaction: StringSelectMenuInteraction | ButtonInteraction, page = 0): Promise<void> {
  const rows = await loadRows(interaction.guildId!);
  const view = pageRows(rows, page, "rating");
  const totalPages = Math.max(1, Math.ceil(rows.length/10));
  const embed = new EmbedBuilder().setColor(Colors.Gold).setTitle("🏆 Competitive Rating").setDescription(view.map(r=>`**#${r.rating_rank}.** <@${r.discord_id}> — **${r.competitive_rating}**${r.team ? ` · ${r.team}` : ""}`).join("\n") || "_No linked users found._").setFooter({ text: `Page ${page+1}/${totalPages}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cr:page:${page-1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page<=0),
    new ButtonBuilder().setCustomId(`cr:refresh:${page}`).setLabel("Refresh").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cr:page:${page+1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages-1),
    new ButtonBuilder().setCustomId("menu_back").setLabel("← League Center").setStyle(ButtonStyle.Secondary),
  );
  const payload = { embeds: [embed], components: [row] };
  if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
  else await (interaction as any).update(payload).catch(()=> (interaction as any).reply({ ...payload, ephemeral: true }));
}
export async function renderStrengthOfSchedule(interaction: StringSelectMenuInteraction | ButtonInteraction, page = 0): Promise<void> {
  const rows = await loadRows(interaction.guildId!);
  const view = pageRows(rows, page, "sos");
  const totalPages = Math.max(1, Math.ceil(rows.length/10));
  const embed = new EmbedBuilder().setColor(Colors.DarkOrange).setTitle("🧱 Strength of Schedule").setDescription(view.map(r=> {
    const rank = r.schedule_rank ? `#${r.schedule_rank}` : "—";
    const score = r.h2h_schedule_games > 0 && r.strength_of_schedule != null ? Number(r.strength_of_schedule).toFixed(1) : "0.0";
    const toughest = r.toughest_remaining_opponent_id
      ? `Toughest Remaining Opponent: <@${r.toughest_remaining_opponent_id}>${r.toughest_remaining_opponent_rating != null ? ` (${r.toughest_remaining_opponent_rating})` : ""}${r.toughest_remaining_opponent_week ? ` · Week ${r.toughest_remaining_opponent_week}` : ""}`
      : "Toughest Remaining Opponent: None";
    return `**${rank}.** <@${r.discord_id}> — **${score}** · ${r.label}
↳ ${toughest}`;
  }).join("\n") || "_No linked users found._").setFooter({ text: `Page ${page+1}/${totalPages} · CPU games excluded` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sos:page:${page-1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page<=0),
    new ButtonBuilder().setCustomId(`sos:refresh:${page}`).setLabel("Refresh").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sos:page:${page+1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages-1),
    new ButtonBuilder().setCustomId("menu_back").setLabel("← League Center").setStyle(ButtonStyle.Secondary),
  );
  const payload = { embeds: [embed], components: [row] };
  if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
  else await (interaction as any).update(payload).catch(()=> (interaction as any).reply({ ...payload, ephemeral: true }));
}
export async function handleCompetitiveRatingsButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("cr:") && !interaction.customId.startsWith("sos:")) return false;
  const [kind, action, pageRaw] = interaction.customId.split(":");
  const page = Math.max(0, Number(pageRaw ?? 0));
  await interaction.deferUpdate().catch(()=>null);
  if (action === "refresh") await refreshCompetitiveRatings(interaction.guildId!);
  if (kind === "cr") await renderCompetitiveRating(interaction, page);
  else await renderStrengthOfSchedule(interaction, page);
  return true;
}
