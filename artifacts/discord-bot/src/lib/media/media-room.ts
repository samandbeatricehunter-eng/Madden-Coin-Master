
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../db/db-helpers.js";
import { renderPotyVote } from "./play-of-the-year.js";
import {
  displayWeekLabel,
  ensureCanonicalLeagueLayer,
  getCanonicalGame,
  listCanonicalGamesForGoty,
  listCanonicalWeeksForGoty,
  refreshCanonicalLeagueSeason,
} from "../canonical/league-games.js";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

async function respondPanel(interaction: any, payload: any): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(async () => {
      await interaction.followUp({ ...payload, ephemeral: true }).catch(() => null);
    });
    return;
  }
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    await interaction.update(payload).catch(async () => {
      await interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
    });
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
}

function mediaRoomBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mr_media_home").setLabel("← Media Room").setStyle(ButtonStyle.Secondary),
  );
}

function currentWeekKey(season: any): string {
  return String(season?.currentWeek ?? "").toLowerCase().trim();
}

function isWildcardOrLater(season: any): boolean {
  const wk = currentWeekKey(season);
  return ["wildcard", "divisional", "conference", "superbowl"].includes(wk);
}

function isRegularSeason(season: any): boolean {
  const n = Number(currentWeekKey(season));
  return Number.isInteger(n) && n >= 1 && n <= 18;
}

async function ensureMediaTables(): Promise<void> {
  await ensureCanonicalLeagueLayer();

  await db.execute(sql`
    create table if not exists media_goty_candidates (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer,
      away_discord_id text not null,
      home_discord_id text not null,
      away_score integer not null default 0,
      home_score integer not null default 0,
      winner_discord_id text,
      notes text,
      submitted_by text not null,
      status text not null default 'nominated',
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    alter table media_goty_candidates
      add column if not exists rec_game_id bigint,
      add column if not exists game_status_at_nomination text,
      add column if not exists nominated_week_number integer
  `);

  await db.execute(sql`
    create index if not exists media_goty_candidates_lookup_idx
    on media_goty_candidates(guild_id, season_id, status, week_index)
  `);

  await db.execute(sql`
    create table if not exists media_goty_votes (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      candidate_id integer not null,
      voter_discord_id text not null,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, season_id, voter_discord_id)
    )
  `);

  await db.execute(sql`
    create table if not exists media_goty_winners (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      candidate_id integer not null,
      winner_details text,
      created_at timestamp with time zone not null default now(),
      unique(guild_id, season_id)
    )
  `);
}

export async function renderMediaRoomHome(interaction: any): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Media Room")
    .setDescription([
      "Choose a media feature:",
      "",
      "📺 **Active Stream Links** — streams posted in the last 1.5 hours",
      "🏆 **GOTW Voting** — vote for this week's Game of the Week",
      "🎬 **Play of the Year** — browse/vote POTY highlights",
      "🎮 **Game of the Year** — nominate, browse, vote, and view winners",
    ].join("\n"));

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mr_active_streams").setLabel("📺 Active Stream Links").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("mr_gotw_vote").setLabel("🏆 GOTW Voting").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("mr_poty_vote").setLabel("🎬 Play of the Year").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("mr_goty_hub").setLabel("🎮 Game of the Year").setStyle(ButtonStyle.Success),
    ),
  ];

  await respondPanel(interaction, { ephemeral: true, embeds: [embed], components: rows });
}

export async function renderActiveStreams(interaction: any): Promise<void> {
  const guildId = interaction.guildId!;
  const h2h = await rowsOf<any>(sql`
    select *
    from gameday_matchup_status
    where guild_id = ${guildId}
      and (stream_url is not null or stream_platform = 'discord')
      and begun_at is not null
      and begun_at >= now() - interval '90 minutes'
    order by begun_at desc
    limit 20
  `);

  const cpu = await rowsOf<any>(sql`
    select *
    from pending_channel_payouts
    where guild_id = ${guildId}
      and type = 'cpu_stream'
      and status = 'approved'
      and created_at >= now() - interval '90 minutes'
    order by created_at desc
    limit 20
  `).catch(() => []);

  const lines: string[] = [];

  for (const s of h2h) {
    const stream =
      String(s.stream_platform ?? "").toLowerCase() === "discord" || String(s.stream_url ?? "").trim().toLowerCase() === "discord"
        ? "**Discord Stream**"
        : String(s.stream_url ?? "");
    lines.push(
      `**H2H:** <@${s.away_discord_id}> @ <@${s.home_discord_id}>\n` +
      `Stream: ${stream || "_Not provided_"}\n` +
      `Started: <t:${Math.floor(new Date(s.begun_at).getTime() / 1000)}:R>`,
    );
  }

  for (const p of cpu) {
    lines.push(
      `**CPU Game:** <@${p.discord_id}>\n` +
      `Stream posted through \`/cpustream\`\n` +
      `Posted: <t:${Math.floor(new Date(p.created_at).getTime() / 1000)}:R>`,
    );
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("📺 Active Stream Links")
    .setDescription(lines.length ? lines.join("\n\n").slice(0, 3900) : "No active streams have been posted in the last 1.5 hours.")
    .setFooter({ text: "Only streams posted within the last 1.5 hours are shown." });

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mr_active_streams_refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
      ),
      mediaRoomBackRow(),
    ],
  });
}

export async function renderGotyHub(interaction: any): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  await refreshCanonicalLeagueSeason(guildId);

  const votingOpen = isWildcardOrLater(season);
  const nominationOpen = isRegularSeason(season);

  const candidates = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from media_goty_candidates
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and status = 'nominated'
  `);

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎮 Game of the Year")
    .setDescription([
      "**Nominate Game** is available during the regular season and pulls directly from canonical H2H game records.",
      "**Current-week games can be nominated before final scores are imported.** Scores/winners update after import.",
      "**Vote** opens Wild Card → Super Bowl.",
      "",
      `Current nominees: **${Number(candidates[0]?.count ?? 0)}**`,
      `Nominations: **${nominationOpen ? "Open" : "Closed"}**`,
      `Voting: **${votingOpen ? "Open" : "Closed"}**`,
    ].join("\n"));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mr_goty_nominate").setLabel("Nominate Game").setStyle(ButtonStyle.Success).setDisabled(!nominationOpen),
    new ButtonBuilder().setCustomId("mr_goty_browse").setLabel("Browse Nominees").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mr_goty_vote").setLabel("Vote").setStyle(ButtonStyle.Success).setDisabled(!votingOpen),
    new ButtonBuilder().setCustomId("mr_goty_archive").setLabel("Past Winners").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mr_media_home").setLabel("← Media Room").setStyle(ButtonStyle.Secondary),
  );

  await respondPanel(interaction, { ephemeral: true, embeds: [embed], components: [row] });
}

async function showGotyWeekSelect(interaction: any): Promise<void> {
  const guildId = interaction.guildId!;
  const weeks = await listCanonicalWeeksForGoty(guildId);

  if (!weeks.length) {
    await respondPanel(interaction, {
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Greyple)
          .setTitle("🎮 GOTY Nomination — No H2H Weeks")
          .setDescription("No H2H weeks were found in the canonical game table for this active season/server."),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary),
        ),
        mediaRoomBackRow(),
      ],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("mr_goty_week")
    .setPlaceholder("Select week to nominate from…")
    .addOptions(
      weeks.slice(0, 25).map((w) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(displayWeekLabel(w))
          .setDescription("H2H games from this canonical league season")
          .setValue(String(w)),
      ),
    );

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎮 GOTY Nomination — Select Week")
        .setDescription("Choose a week from the canonical H2H game table. Current-week scheduled games are allowed; scores update after import."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary)),
      mediaRoomBackRow(),
    ],
  });
}

async function showGotyMatchupSelect(interaction: any, weekNumber: number): Promise<void> {
  const guildId = interaction.guildId!;
  const games = await listCanonicalGamesForGoty(guildId, weekNumber);

  if (!games.length) {
    await respondPanel(interaction, {
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("🎮 GOTY Nomination — No H2H Games")
          .setDescription(`No canonical H2H games were found for **${displayWeekLabel(weekNumber)}**.`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("mr_goty_nominate").setLabel("← Select Different Week").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("mr_goty_home").setLabel("GOTY Home").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mr_goty_matchup:${weekNumber}`)
    .setPlaceholder("Select H2H matchup…")
    .addOptions(
      games.map((g) => {
        const score = g.away_score != null && g.home_score != null ? ` · ${g.away_score}-${g.home_score}` : " · awaiting import";
        const winner = g.winner_discord_id ? ` · winner known` : "";
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${g.away_team_name} @ ${g.home_team_name}`.slice(0, 100))
          .setDescription(`${g.status}${score}${winner}`.slice(0, 100))
          .setValue(String(g.id));
      }),
    );

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎮 GOTY Nomination — Select Matchup")
        .setDescription(`Showing canonical H2H games from **${displayWeekLabel(weekNumber)}**.`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mr_goty_nominate").setLabel("← Week Select").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showGotyNotesModal(interaction: any, weekNumber: number, recGameId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`mr_goty_notes:${weekNumber}:${recGameId}`)
    .setTitle("GOTY Nomination Notes");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Optional notes / highlight links")
        .setPlaceholder("What made this game GOTY-worthy? Add Twitch/clip links, comeback notes, stakes, drama, etc.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000),
    ),
  );

  await interaction.showModal(modal);
}

async function handleGotyNotesModal(interaction: any, weekNumber: number, recGameId: number): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const game = await getCanonicalGame(guildId, recGameId);

  if (!game) {
    await interaction.reply({ ephemeral: true, content: "❌ Canonical game not found. Nomination was not submitted." });
    return;
  }

  const notes = interaction.fields.getTextInputValue("notes")?.trim() ?? "";
  const awayScore = game.away_score ?? 0;
  const homeScore = game.home_score ?? 0;
  const winnerDiscordId = game.winner_discord_id ?? game.imported_winner_discord_id ?? null;

  const matchupSummary = [
    `${displayWeekLabel(weekNumber)} — ${game.away_team_name} @ ${game.home_team_name}`,
    game.away_score != null && game.home_score != null
      ? `Score: ${game.away_team_name} ${game.away_score} — ${game.home_team_name} ${game.home_score}`
      : "Score: awaiting import",
    winnerDiscordId ? `Winner: <@${winnerDiscordId}>` : "Winner: awaiting import",
    "",
    notes || "_No notes provided._",
  ].join("\n");

  await db.execute(sql`
    insert into media_goty_candidates (
      guild_id, season_id, week_index, nominated_week_number, rec_game_id,
      away_discord_id, home_discord_id,
      away_score, home_score, winner_discord_id,
      notes, submitted_by, status, game_status_at_nomination
    )
    values (
      ${guildId}, ${season.id}, ${weekNumber}, ${weekNumber}, ${recGameId},
      ${game.away_discord_id}, ${game.home_discord_id},
      ${awayScore}, ${homeScore}, ${winnerDiscordId},
      ${matchupSummary}, ${interaction.user.id}, 'nominated', ${game.status}
    )
  `);

  await interaction.reply({
    ephemeral: true,
    content: "✅ GOTY nomination submitted. If this game is not final yet, score and winner details will update after import.",
  });
}

async function renderGotyNominees(interaction: any, voteMode = false, page = 0): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const votingOpen = isWildcardOrLater(season);

  const rows = await rowsOf<any>(sql`
    select
      c.*,
      g.away_team_name as canon_away_team_name,
      g.home_team_name as canon_home_team_name,
      g.away_score as canon_away_score,
      g.home_score as canon_home_score,
      g.winner_discord_id as canon_winner_discord_id,
      g.status as canon_status
    from media_goty_candidates c
    left join rec_league_games g on g.id = c.rec_game_id
    where c.guild_id = ${guildId}
      and c.season_id = ${season.id}
      and c.status = 'nominated'
    order by coalesce(c.nominated_week_number, c.week_index) asc, c.created_at asc
    limit 1 offset ${page}
  `);
  const countRows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from media_goty_candidates
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and status = 'nominated'
  `);

  const total = Number(countRows[0]?.count ?? 0);
  const c = rows[0];

  if (!c) {
    await respondPanel(interaction, {
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🎮 GOTY Nominees").setDescription("No GOTY nominees submitted yet.")],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary)),
        mediaRoomBackRow(),
      ],
    });
    return;
  }

  const awayScore = c.canon_away_score ?? c.away_score;
  const homeScore = c.canon_home_score ?? c.home_score;
  const winner = c.canon_winner_discord_id ?? c.winner_discord_id;
  const awayName = c.canon_away_team_name ?? "Away";
  const homeName = c.canon_home_team_name ?? "Home";

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🎮 GOTY Nominee ${page + 1}/${Math.max(total, 1)}`)
    .setDescription([
      `**Week:** ${displayWeekLabel(Number(c.nominated_week_number ?? c.week_index ?? 0))}`,
      `**Game:** <@${c.away_discord_id}> (${awayName}) vs <@${c.home_discord_id}> (${homeName})`,
      awayScore != null && homeScore != null ? `**Score:** ${awayName} ${awayScore} — ${homeName} ${homeScore}` : "**Score:** awaiting import",
      winner ? `**Winner:** <@${winner}>` : "**Winner:** awaiting import",
      `**Status:** ${c.canon_status ?? c.game_status_at_nomination ?? "unknown"}`,
      `**Submitted by:** <@${c.submitted_by}>`,
      "",
      c.notes ?? "_No notes._",
    ].join("\n"));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mr_goty_page:${voteMode ? "vote" : "browse"}:${Math.max(0, page - 1)}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`mr_goty_vote_cast:${c.id}`).setLabel("Vote").setStyle(ButtonStyle.Success).setDisabled(!voteMode || !votingOpen),
    new ButtonBuilder().setCustomId(`mr_goty_page:${voteMode ? "vote" : "browse"}:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
    new ButtonBuilder().setCustomId("mr_goty_home").setLabel("GOTY Home").setStyle(ButtonStyle.Secondary),
  );

  await respondPanel(interaction, { embeds: [embed], components: [row, mediaRoomBackRow()] });
}

async function castGotyVote(interaction: any, candidateId: number): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  if (!isWildcardOrLater(season)) {
    await interaction.reply({ ephemeral: true, content: "❌ GOTY voting does not open until Wild Card." });
    return;
  }

  await db.execute(sql`
    insert into media_goty_votes (guild_id, season_id, candidate_id, voter_discord_id)
    values (${guildId}, ${season.id}, ${candidateId}, ${interaction.user.id})
    on conflict (guild_id, season_id, voter_discord_id)
    do update set candidate_id = excluded.candidate_id, updated_at = now()
  `);

  await interaction.reply({ ephemeral: true, content: "✅ GOTY vote recorded. You may change your vote until voting closes." });
}

async function renderGotyArchive(interaction: any): Promise<void> {
  await ensureMediaTables();
  const rows = await rowsOf<any>(sql`
    select *
    from media_goty_winners
    where guild_id = ${interaction.guildId}
    order by created_at desc
    limit 10
  `);

  await respondPanel(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏛️ GOTY Past Winners")
        .setDescription(rows.length ? rows.map((r, i) => `**${i + 1}.** Season ${r.season_id} — ${r.winner_details ?? `Candidate #${r.candidate_id}`}`).join("\n") : "_No GOTY winners archived yet._"),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary)),
      mediaRoomBackRow(),
    ],
  });
}

export async function handleMediaRoomInteraction(interaction: any): Promise<boolean> {
  const id = interaction.customId ?? "";
  if (!id.startsWith("mr_") && !id.startsWith("ac_")) return false;

  if (id === "mr_media_home") { await renderMediaRoomHome(interaction); return true; }

  if (id === "ac_active_streams" || id === "mr_active_streams") { await renderActiveStreams(interaction); return true; }
  if (id === "ac_poty_vote" || id === "mr_poty_vote") { await renderPotyVote(interaction); return true; }
  if (id === "ac_goty_hub" || id === "ac_goty_vote" || id === "mr_goty_hub") { await renderGotyHub(interaction); return true; }
  if (id === "ac_gotw_vote" || id === "mr_gotw_vote") {
    const { handleActionsInteraction } = await import("../handlers/actions-handlers.js");
    await handleActionsInteraction(interaction, "ac_gotw_vote");
    return true;
  }

  if (id === "mr_active_streams_refresh") { await renderActiveStreams(interaction); return true; }
  if (id === "mr_goty_home") { await renderGotyHub(interaction); return true; }
  if (id === "mr_goty_nominate") { await showGotyWeekSelect(interaction); return true; }
  if (id === "mr_goty_week") { await showGotyMatchupSelect(interaction, Number(interaction.values[0])); return true; }
  if (id.startsWith("mr_goty_week_back:")) { await showGotyMatchupSelect(interaction, Number(id.split(":")[1])); return true; }
  if (id.startsWith("mr_goty_matchup:")) {
    const [, , weekRaw] = id.split(":");
    await showGotyNotesModal(interaction, Number(weekRaw), Number(interaction.values[0]));
    return true;
  }
  if (id.startsWith("mr_goty_notes:")) {
    const [, , weekRaw, recGameIdRaw] = id.split(":");
    await handleGotyNotesModal(interaction, Number(weekRaw), Number(recGameIdRaw));
    return true;
  }
  if (id === "mr_goty_browse") { await renderGotyNominees(interaction, false, 0); return true; }
  if (id === "mr_goty_vote") { await renderGotyNominees(interaction, true, 0); return true; }
  if (id === "mr_goty_archive") { await renderGotyArchive(interaction); return true; }
  if (id.startsWith("mr_goty_page:")) {
    const [, , mode, pageRaw] = id.split(":");
    await renderGotyNominees(interaction, mode === "vote", Math.max(0, Number(pageRaw ?? 0)));
    return true;
  }
  if (id.startsWith("mr_goty_vote_cast:")) {
    await castGotyVote(interaction, Number(id.split(":")[2]));
    return true;
  }

  return false;
}
