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
  );

  const payload = { ephemeral: true, embeds: [embed], components: [row] };
  await respondPanel(interaction, payload);
}

async function showGotyNominationModal(interaction: any): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("mr_goty_nominate_modal")
    .setTitle("Nominate Game of the Year");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("week")
        .setLabel("Week number")
        .setPlaceholder("Example: 8")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("participants")
        .setLabel("Participants")
        .setPlaceholder("@UserA vs @UserB or Discord IDs")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("score")
        .setLabel("Final score and winner")
        .setPlaceholder("Example: Bears 31, Lions 28 — Winner: Bears/UserA")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Highlights / notes")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );

  await interaction.showModal(modal);
}

async function handleGotyNominationModal(interaction: any): Promise<void> {
  await ensureMediaTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const week = Number(interaction.fields.getTextInputValue("week").trim());
  const participants = interaction.fields.getTextInputValue("participants").trim();
  const score = interaction.fields.getTextInputValue("score").trim();
  const notes = interaction.fields.getTextInputValue("notes").trim();

  const ids = [...participants.matchAll(/\d{15,25}/g)].map((m) => m[0]);
  const winnerId = [...score.matchAll(/\d{15,25}/g)].map((m) => m[0])[0] ?? ids[0] ?? interaction.user.id;

  if (!Number.isInteger(week) || week < 1 || ids.length < 2) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ Nomination needs a valid week number and two Discord IDs/user mentions in the participants field.",
    });
    return;
  }

  const scoreNums = [...score.matchAll(/\d{1,3}/g)].map((m) => Number(m[0])).filter((n) => n < 100);
  const awayScore = scoreNums[0] ?? 0;
  const homeScore = scoreNums[1] ?? 0;

  await db.execute(sql`
    insert into media_goty_candidates (
      guild_id, season_id, week_index,
      away_discord_id, home_discord_id,
      away_score, home_score, winner_discord_id,
      notes, submitted_by, status
    )
    values (
      ${guildId}, ${season.id}, ${week},
      ${ids[0]}, ${ids[1]},
      ${awayScore}, ${homeScore}, ${winnerId},
      ${`${score}\n\n${notes}`}, ${interaction.user.id}, 'nominated'
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
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary))],
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

  await interaction.update({ embeds: [embed], components: [row] });
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
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mr_goty_home").setLabel("← GOTY Home").setStyle(ButtonStyle.Secondary))],
  });
}

export async function handleMediaRoomInteraction(interaction: any): Promise<boolean> {
  const id = interaction.customId ?? "";
  if (!id.startsWith("mr_")) return false;

  if (id === "mr_active_streams_refresh") { await renderActiveStreams(interaction); return true; }
  if (id === "mr_goty_home") { await renderGotyHub(interaction); return true; }
  if (id === "mr_goty_nominate") { await showGotyNominationModal(interaction); return true; }
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
  if (id === "mr_goty_nominate_modal") { await handleGotyNominationModal(interaction); return true; }

  if (id === "mr_poty_vote") { await renderPotyVote(interaction); return true; }

  return true;
}
