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


export async function renderMediaRoomHome(interaction: any): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Media Room")
    .setDescription(
      [
        "Choose a media feature:",
        "",
        "📺 **Active Stream Links** — streams posted in the last 1.5 hours",
        "🏆 **GOTW Voting** — vote for this week's Game of the Week",
        "🎬 **Play of the Year** — browse/vote POTY highlights",
        "🎮 **Game of the Year** — nominate, browse, vote, and view winners",
      ].join("\\n"),
    );

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
  return ["wildcard", "divisional", "conference", "superbowl", "offseason"].includes(wk);
}

async function ensureMediaTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists media_goty_candidates (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer,
      away_discord_id text not null,
      home_discord_id text not null,
      away_score integer not null,
      home_score integer not null,
      winner_discord_id text not null,
      notes text,
      submitted_by text not null,
      status text not null default 'nominated',
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
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

export async function renderActiveStreams(interaction: any): Promise<void> {
  const guildId = interaction.guildId!;
  const h2h = await rowsOf<any>(sql`
    select *
    from gameday_matchup_status
    where guild_id = ${guildId}
      and stream_url is not null
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
  `);

  const lines: string[] = [];

  for (const s of h2h) {
    const stream = String(s.stream_url ?? "").trim().toLowerCase() === "discord"
      ? "**Discord Stream**"
      : String(s.stream_url ?? "");
    lines.push(
      `**H2H:** <@${s.away_discord_id}> @ <@${s.home_discord_id}>\n` +
      `Stream: ${stream}\n` +
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
    .setDescription(
      lines.length
        ? lines.join("\n\n").slice(0, 3900)
        : "No active streams have been posted in the last 1.5 hours.",
    )
    .setFooter({ text: "Only streams posted within the last 1.5 hours are shown." });

  const payload = {
    ephemeral: true,
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mr_active_streams_refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
      ),
      mediaRoomBackRow(),
    ],
  };

  await respondPanel(interaction, payload);
}

export async function renderGotyHub(interaction: any): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const votingOpen = isWildcardOrLater(season);

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
    .setDescription(
      [
        "**Nominate Game** is open during the regular season.",
        "**GOTY Vote** opens after the regular season when the league advances to Wild Card.",
        "Past winners are available from the archive.",
        "",
        `Current nominees: **${Number(candidates[0]?.count ?? 0)}**`,
        `Voting status: **${votingOpen ? "Open" : "Closed until Wild Card"}**`,
      ].join("\n"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mr_goty_nominate").setLabel("Nominate Game").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mr_goty_browse").setLabel("Browse Nominees").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mr_goty_vote").setLabel("Vote").setStyle(ButtonStyle.Success).setDisabled(!votingOpen),
    new ButtonBuilder().setCustomId("mr_goty_archive").setLabel("Past Winners").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mr_media_home").setLabel("← Media Room").setStyle(ButtonStyle.Secondary),
  );

  const payload = { ephemeral: true, embeds: [embed], components: [row] };
  await respondPanel(interaction, payload);
}


function regularWeekNumberFromSeason(season: any): number | null {
  const raw = currentWeekKey(season);
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 18) return n;
  if (raw === "wildcard") return 19;
  if (raw === "divisional") return 20;
  if (raw === "conference") return 21;
  if (raw === "superbowl") return 22;
  return null;
}

function scheduleWeekIndexFromDisplayWeek(displayWeek: number): number {
  if (displayWeek >= 1 && displayWeek <= 18) return displayWeek - 1;
  if (displayWeek === 19) return 1018;
  if (displayWeek === 20) return 1019;
  if (displayWeek === 21) return 1020;
  if (displayWeek === 22) return 1022;
  return displayWeek - 1;
}

function displayWeekLabel(displayWeek: number): string {
  if (displayWeek === 19) return "Wild Card";
  if (displayWeek === 20) return "Divisional Round";
  if (displayWeek === 21) return "Conference Championship";
  if (displayWeek === 22) return "Super Bowl";
  return `Week ${displayWeek}`;
}

async function showGotyWeekSelect(interaction: any): Promise<void> {
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const currentDisplayWeek = regularWeekNumberFromSeason(season);

  if (!currentDisplayWeek) {
    await interaction.reply?.({ ephemeral: true, content: "❌ Could not determine the current league week." }).catch(() => null);
    return;
  }

  const displayWeeks = [...new Set([currentDisplayWeek, Math.max(1, currentDisplayWeek - 1)])]
    .filter((w) => w >= 1 && w <= 22);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("mr_goty_week")
    .setPlaceholder("Select week to nominate from…")
    .addOptions(
      displayWeeks.map((w) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(displayWeekLabel(w))
          .setDescription(w === currentDisplayWeek ? "Current week" : "Previous week")
          .setValue(String(w)),
      ),
    );

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎮 GOTY Nomination — Select Week")
        .setDescription("Choose either the current week or previous week. The next step will show only H2H matchups from that week."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary),
      ),
      mediaRoomBackRow(),
    ],
  });
}

async function showGotyMatchupSelect(interaction: any, displayWeek: number): Promise<void> {
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = scheduleWeekIndexFromDisplayWeek(displayWeek);

  const games = await rowsOf<any>(sql`
    select id, away_discord_id, home_discord_id, away_team_name, home_team_name, away_score, home_score, status
    from game_schedules
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and week_index = ${weekIndex}
      and away_discord_id is not null
      and home_discord_id is not null
      and away_discord_id <> ''
      and home_discord_id <> ''
      and away_discord_id not like 'unlinked_%'
      and home_discord_id not like 'unlinked_%'
    order by id asc
    limit 25
  `);

  if (!games.length) {
    await respondPanel(interaction, {
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("🎮 GOTY Nomination — No H2H Games")
          .setDescription(`No H2H matchups were found for **${displayWeekLabel(displayWeek)}**.`),
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
    .setCustomId(`mr_goty_matchup:${displayWeek}`)
    .setPlaceholder("Select H2H matchup…")
    .addOptions(
      games.map((g) => {
        const score =
          g.away_score != null && g.home_score != null
            ? ` · ${g.away_score}-${g.home_score}`
            : "";
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${g.away_team_name} @ ${g.home_team_name}`.slice(0, 100))
          .setDescription(`${g.status ?? "scheduled"}${score}`.slice(0, 100))
          .setValue(String(g.id));
      }),
    );

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎮 GOTY Nomination — Select Matchup")
        .setDescription(`Showing H2H matchups from **${displayWeekLabel(displayWeek)}**.`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("mr_goty_nominate").setLabel("← Week Select").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showGotyWinnerSelect(interaction: any, scheduleId: number, displayWeek: number): Promise<void> {
  const guildId = interaction.guildId!;
  const [game] = await rowsOf<any>(sql`
    select id, away_discord_id, home_discord_id, away_team_name, home_team_name, away_score, home_score
    from game_schedules
    where guild_id = ${guildId}
      and id = ${scheduleId}
    limit 1
  `);

  if (!game) {
    await interaction.reply?.({ ephemeral: true, content: "❌ Matchup not found." }).catch(() => null);
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mr_goty_winner:${displayWeek}:${scheduleId}`)
    .setPlaceholder("Select winner…")
    .addOptions([
      new StringSelectMenuOptionBuilder()
        .setLabel(`${game.away_team_name}`)
        .setDescription(`Away user: ${game.away_discord_id}`.slice(0, 100))
        .setValue(String(game.away_discord_id)),
      new StringSelectMenuOptionBuilder()
        .setLabel(`${game.home_team_name}`)
        .setDescription(`Home user: ${game.home_discord_id}`.slice(0, 100))
        .setValue(String(game.home_discord_id)),
    ]);

  const score =
    game.away_score != null && game.home_score != null
      ? `\nScore: **${game.away_team_name} ${game.away_score} — ${game.home_team_name} ${game.home_score}**`
      : "";

  await respondPanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎮 GOTY Nomination — Select Winner")
        .setDescription(
          `Matchup: **${game.away_team_name} @ ${game.home_team_name}**${score}\n\nSelect who won the game.`,
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`mr_goty_week_back:${displayWeek}`).setLabel("← Matchups").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showGotyNotesModal(interaction: any, displayWeek: number, scheduleId: number, winnerDiscordId: string): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`mr_goty_notes:${displayWeek}:${scheduleId}:${winnerDiscordId}`)
    .setTitle("GOTY Nomination Notes");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Why should this game be GOTY?")
        .setPlaceholder("Describe the comeback, rivalry stakes, big plays, drama, upset, etc.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );

  await interaction.showModal(modal);
}

async function handleGotyNotesModal(interaction: any, displayWeek: number, scheduleId: number, winnerDiscordId: string): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const notes = interaction.fields.getTextInputValue("notes").trim();

  const [game] = await rowsOf<any>(sql`
    select id, away_discord_id, home_discord_id, away_team_name, home_team_name, away_score, home_score
    from game_schedules
    where guild_id = ${guildId}
      and id = ${scheduleId}
    limit 1
  `);

  if (!game) {
    await interaction.reply({ ephemeral: true, content: "❌ Matchup not found. Nomination was not submitted." });
    return;
  }

  if (![String(game.away_discord_id), String(game.home_discord_id)].includes(String(winnerDiscordId))) {
    await interaction.reply({ ephemeral: true, content: "❌ Winner must be one of the two selected matchup users." });
    return;
  }

  const awayScore = game.away_score == null ? 0 : Number(game.away_score);
  const homeScore = game.home_score == null ? 0 : Number(game.home_score);
  const matchupSummary =
    `${displayWeekLabel(displayWeek)} — ${game.away_team_name} @ ${game.home_team_name}\n` +
    `Score: ${game.away_team_name} ${awayScore} — ${game.home_team_name} ${homeScore}\n\n` +
    notes;

  await db.execute(sql`
    insert into media_goty_candidates (
      guild_id, season_id, week_index,
      away_discord_id, home_discord_id,
      away_score, home_score, winner_discord_id,
      notes, submitted_by, status
    )
    values (
      ${guildId}, ${season.id}, ${displayWeek},
      ${game.away_discord_id}, ${game.home_discord_id},
      ${awayScore}, ${homeScore}, ${winnerDiscordId},
      ${matchupSummary}, ${interaction.user.id}, 'nominated'
    )
  `);

  await interaction.reply({
    ephemeral: true,
    content: "✅ GOTY nomination submitted.",
  });
}

async function renderGotyNominees(interaction: any, voteMode = false, page = 0): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const votingOpen = isWildcardOrLater(season);
  const rows = await rowsOf<any>(sql`
    select *
    from media_goty_candidates
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and status = 'nominated'
    order by week_index asc, created_at asc
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
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🎮 GOTY Nominees").setDescription("No GOTY nominees submitted yet.")],
      components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary)),
      mediaRoomBackRow(),
    ],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🎮 GOTY Nominee ${page + 1}/${Math.max(total, 1)}`)
    .setDescription(
      [
        `**Week:** ${c.week_index}`,
        `**Game:** <@${c.away_discord_id}> ${c.away_score} vs <@${c.home_discord_id}> ${c.home_score}`,
        `**Winner:** <@${c.winner_discord_id}>`,
        `**Submitted by:** <@${c.submitted_by}>`,
        "",
        c.notes ?? "_No notes._",
      ].join("\n"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mr_goty_page:${voteMode ? "vote" : "browse"}:${Math.max(0, page - 1)}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`mr_goty_vote_cast:${c.id}`).setLabel("Vote").setStyle(ButtonStyle.Success).setDisabled(!voteMode || !votingOpen),
    new ButtonBuilder().setCustomId(`mr_goty_page:${voteMode ? "vote" : "browse"}:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
    new ButtonBuilder().setCustomId("mr_goty_home").setLabel("GOTY Home").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row, mediaRoomBackRow()] });
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

  await interaction.update({
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

  // Media Room entrypoints can arrive from either:
  // - the top-level /menu action IDs (ac_*)
  // - Media Room internal buttons (mr_*)
  // Keep both sets supported so old Discord components do not break after deploy.
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
  if (id === "mr_goty_week") { await showGotyMatchupSelect(interaction, Number(interaction.values[0])); return true; }
  if (id.startsWith("mr_goty_week_back:")) { await showGotyMatchupSelect(interaction, Number(id.split(":")[1])); return true; }
  if (id.startsWith("mr_goty_matchup:")) { await showGotyWinnerSelect(interaction, Number(interaction.values[0]), Number(id.split(":")[1])); return true; }
  if (id.startsWith("mr_goty_winner:")) {
    const [, , displayWeekRaw, scheduleIdRaw] = id.split(":");
    await showGotyNotesModal(interaction, Number(displayWeekRaw), Number(scheduleIdRaw), String(interaction.values[0]));
    return true;
  }
  if (id.startsWith("mr_goty_notes:")) {
    const [, , displayWeekRaw, scheduleIdRaw, winnerDiscordId] = id.split(":");
    await handleGotyNotesModal(interaction, Number(displayWeekRaw), Number(scheduleIdRaw), String(winnerDiscordId));
    return true;
  }
  if (id === "mr_goty_nominate") { await showGotyWeekSelect(interaction); return true; }
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

  if (id === "mr_poty_vote") { await renderPotyVote(interaction); return true; }

  return true;
}
