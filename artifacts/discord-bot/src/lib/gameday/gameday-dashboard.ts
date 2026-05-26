import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  getGuildChannel,
  getOrCreateActiveSeason,
  getScheduleSeasonId,
  addBalance,
  logTransaction,
} from "../db/db-helpers.js";
import { weekLabel } from "../helpers/week-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";

type GamedayContext = {
  guildId: string;
  season: any;
  weekIndex: number;
  scheduleSeasonId: number;
  channelId: string;
  userId: string;
  awayDiscordId: string;
  homeDiscordId: string;
  opponentId: string;
  awayTeamName: string;
  homeTeamName: string;
  matchupKey: string;
  homeAway: "Home" | "Away";
};

type OfferRow = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  matchup_key: string;
  proposer_discord_id: string;
  recipient_discord_id: string;
  away_discord_id: string;
  home_discord_id: string;
  away_team_name: string;
  home_team_name: string;
  proposed_for: string;
  proposed_tz: string | null;
  notes: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function teamKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

function weekIndexFromCurrentWeek(currentWeek: string | null | undefined): number | null {
  const raw = String(currentWeek ?? "").toLowerCase().trim();
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= 18) return n - 1;
  if (raw === "wildcard") return 1018;
  if (raw === "divisional") return 1019;
  if (raw === "conference") return 1020;
  if (raw === "superbowl") return 1022;
  return null;
}

function matchupKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function ensureGamedayTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists gameday_schedule_offers (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      proposer_discord_id text not null,
      recipient_discord_id text not null,
      away_discord_id text not null,
      home_discord_id text not null,
      away_team_name text not null,
      home_team_name text not null,
      proposed_for text not null,
      proposed_tz text,
      notes text,
      status text not null default 'pending',
      accepted_at timestamp with time zone,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
  await db.execute(sql`
    create index if not exists gameday_schedule_offers_lookup_idx
    on gameday_schedule_offers(guild_id, season_id, week_index, matchup_key, status)
  `);
  await db.execute(sql`
    create index if not exists gameday_schedule_offers_recipient_idx
    on gameday_schedule_offers(guild_id, recipient_discord_id, status)
  `);

  await db.execute(sql`
    create table if not exists gameday_matchup_status (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      away_discord_id text not null,
      home_discord_id text not null,
      away_team_name text not null,
      home_team_name text not null,
      away_checked_in boolean not null default false,
      home_checked_in boolean not null default false,
      search_advised_by text,
      invite_requested_by text,
      begun_by text,
      begun_at timestamp with time zone,
      stream_url text,
      stream_paid_to text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, season_id, week_index, matchup_key)
    )
  `);
}

async function queryOffers(whereSql: any): Promise<OfferRow[]> {
  const result = await db.execute(sql`
    select *
    from gameday_schedule_offers
    where ${whereSql}
    order by created_at desc
  `);
  return ((result as any).rows ?? result) as OfferRow[];
}

async function countOffers(whereSql: any): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count
    from gameday_schedule_offers
    where ${whereSql}
  `);
  const rows = ((result as any).rows ?? result) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

async function executeOfferUpdate(q: any): Promise<void> {
  await db.execute(q);
}

function isValidHttpUrl(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function ensureMatchupStatus(ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  await db.execute(sql`
    insert into gameday_matchup_status (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName}
    )
    on conflict (guild_id, season_id, week_index, matchup_key) do nothing
  `);
}

async function getMatchupStatus(ctx: GamedayContext): Promise<any> {
  await ensureMatchupStatus(ctx);
  const result = await db.execute(sql`
    select *
    from gameday_matchup_status
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  return rows[0] ?? null;
}

async function dmOpponent(interaction: ButtonInteraction | ModalSubmitInteraction, ctx: GamedayContext, content: string): Promise<void> {
  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(content).catch(() => null);
}

async function postPublic(interaction: ButtonInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  const ch = interaction.channel;
  if (ch?.isTextBased()) await ch.send({ content }).catch(() => null);
}

async function getContext(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<GamedayContext | null> {
  const guildId = interaction.guildId!;
  const activeChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);

  if (!activeChannelId || interaction.channelId !== activeChannelId) {
    const msg = activeChannelId
      ? `❌ \`/gameday\` only works in the active weekly gameday channel: <#${activeChannelId}>.`
      : "❌ No active weekly gameday channel is configured yet.";
    if (interaction.isRepliable()) {
      if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).followUp({ content: msg, ephemeral: true }).catch(() => null);
      else await (interaction as any).reply({ content: msg, ephemeral: true }).catch(() => null);
    }
    return null;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekIndexFromCurrentWeek((season as any).currentWeek);
  if (weekIndex == null) {
    if (interaction.isRepliable()) {
      await (interaction as any).reply?.({ ephemeral: true, content: "❌ There is no active H2H gameday dashboard for the current league week." }).catch(() => null);
    }
    return null;
  }

  const scheduleSeasonId = await getScheduleSeasonId(guildId);
  const [games, mcaTeams, users] = await Promise.all([
    db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId, scheduleSeasonId),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      )),
    db.select({
      fullName: franchiseMcaTeamsTable.fullName,
      nickName: franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
    }).from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, scheduleSeasonId)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId)),
  ]);

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (!t.discordId || t.discordId.startsWith("unlinked_")) continue;
    teamToDiscord.set(teamKey(t.fullName), t.discordId);
    teamToDiscord.set(teamKey(t.nickName), t.discordId);
  }
  for (const u of users) {
    if (!u.team || !u.discordId || u.discordId.startsWith("unlinked_")) continue;
    if (!teamToDiscord.has(teamKey(u.team))) teamToDiscord.set(teamKey(u.team), u.discordId);
  }

  const userId = interaction.user.id;
  const myGame = games
    .map((g) => ({
      ...g,
      awayDiscordId: teamToDiscord.get(teamKey(g.awayTeamName)),
      homeDiscordId: teamToDiscord.get(teamKey(g.homeTeamName)),
    }))
    .find((g) => g.awayDiscordId === userId || g.homeDiscordId === userId);

  if (!myGame || !myGame.awayDiscordId || !myGame.homeDiscordId) {
    if (interaction.isRepliable()) {
      if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).followUp({ ephemeral: true, content: "❌ You do not have a H2H matchup this week, so there are no gameday actions available." }).catch(() => null);
      else await (interaction as any).reply({ ephemeral: true, content: "❌ You do not have a H2H matchup this week, so there are no gameday actions available." }).catch(() => null);
    }
    return null;
  }

  const opponentId = myGame.awayDiscordId === userId ? myGame.homeDiscordId : myGame.awayDiscordId;

  return {
    guildId,
    season,
    weekIndex,
    scheduleSeasonId,
    channelId: activeChannelId,
    userId,
    awayDiscordId: myGame.awayDiscordId,
    homeDiscordId: myGame.homeDiscordId,
    opponentId,
    awayTeamName: myGame.awayTeamName,
    homeTeamName: myGame.homeTeamName,
    matchupKey: matchupKey(myGame.awayDiscordId, myGame.homeDiscordId),
    homeAway: myGame.homeDiscordId === userId ? "Home" : "Away",
  };
}

function mainRows(activeCount: number, pendingCount: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_schedule").setLabel("🗓️ Schedule Game").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gd_pending").setLabel(`📨 Pending Offers (${pendingCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_queue").setLabel("🎮 Game Queue").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("gd_assist").setLabel("🚨 Assistance").setStyle(ButtonStyle.Danger).setDisabled(true),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_manage_offers").setLabel(`⚙️ Manage Active Offers (${activeCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function renderDashboard(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  const pendingCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and recipient_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎮 Gameday Dashboard")
    .setDescription([
      `**Week:** ${weekLabel((ctx.season as any).currentWeek)}`,
      `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
      `**You are:** ${ctx.homeAway}`,
      `**Opponent:** <@${ctx.opponentId}>`,
    ].join("\n"))
    .addFields(
      { name: "Schedule Game", value: `Send proposed times · Manage active offers (**${activeCount}**) · Edit/delete offers`, inline: false },
      { name: `Pending Offers (${pendingCount})`, value: "Accept · Counter · Reject with reason", inline: false },
      { name: "Game Queue", value: "Check in/out · message opponent · advise search · request invite · mark begun with stream link", inline: false },
      { name: "Assistance", value: "Coming later: contact commissioner · flag violation · request FS/FW", inline: false },
    );

  const payload = { ephemeral: true, embeds: [embed], components: mainRows(activeCount, pendingCount) as any };
  if (interaction.isChatInputCommand()) await interaction.reply(payload);
  else if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).editReply(payload).catch(() => (interaction as any).followUp(payload));
  else await (interaction as any).update(payload).catch(() => (interaction as any).reply(payload));
}

export async function openGamedayDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await getContext(interaction);
  if (!ctx) return;
  await renderDashboard(interaction, ctx);
}

async function showScheduleMenu(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🗓️ Schedule Game")
        .setDescription(
          `You may have up to **3 active pending offers** for this matchup.\n\n` +
          `Current active offers sent by you: **${activeCount}/3**.`,
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_offer_new").setLabel("➕ Send New Proposed Time").setStyle(ButtonStyle.Primary).setDisabled(activeCount >= 3),
        new ButtonBuilder().setCustomId("gd_manage_offers").setLabel(`⚙️ Manage Active Offers (${activeCount})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showNewOfferModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_offer_new")
    .setTitle("Send Scheduling Offer");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("proposed_for")
        .setLabel("Proposed date/time")
        .setPlaceholder("Example: Thursday 8:30 PM CST")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("proposed_tz")
        .setLabel("Timezone")
        .setPlaceholder("CST, EST, MST, PST, etc.")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(20)
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Optional note")
        .setPlaceholder("Example: I can also start a little earlier if needed.")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

async function handleNewOfferModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (activeCount >= 3) {
    await interaction.reply({ ephemeral: true, content: "❌ You already have 3 active pending offers for this matchup. Edit/delete one first." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim() || null;
  const notes = interaction.fields.getTextInputValue("notes").trim() || null;

  const result = await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.userId}, ${ctx.opponentId},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${proposedFor}, ${proposedTz}, ${notes}, 'pending'
    )
    returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const offerId = rows[0]?.id;

  const dmText =
    `🗓️ **New Scheduling Offer**\n\n` +
    `<@${ctx.userId}> proposed a game time for **${ctx.awayTeamName} @ ${ctx.homeTeamName}**:\n\n` +
    `**Time:** ${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}\n` +
    (notes ? `**Note:** ${notes}\n\n` : "\n") +
    `Open \`/gameday\` in the active gameday channel to accept, counter, or reject.`;

  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(dmText).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Scheduling Offer Sent")
        .setDescription(`Offer #${offerId ?? "?"} sent to <@${ctx.opponentId}>.\n\n**Time:** ${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showPendingOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const offers = await queryOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and recipient_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (offers.length === 0) {
    await interaction.update({
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("📨 Pending Offers").setDescription("You do not have any pending scheduling offers.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_pending_select")
    .setPlaceholder("Select an offer to review…")
    .addOptions(offers.slice(0, 25).map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} · ${o.proposed_for}`.slice(0, 100))
        .setDescription(`From ${o.proposer_discord_id}`.slice(0, 100))
        .setValue(String(o.id)),
    ));

  await interaction.update({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📨 Pending Offers (${offers.length})`).setDescription("Select an offer to accept, counter, or reject.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showManageOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const offers = await queryOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (offers.length === 0) {
    await interaction.update({
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("⚙️ Manage Active Offers").setDescription("You have no active pending offers to manage.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_manage_select")
    .setPlaceholder("Select one of your offers…")
    .addOptions(offers.slice(0, 25).map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} · ${o.proposed_for}`.slice(0, 100))
        .setDescription(`To ${o.recipient_discord_id}`.slice(0, 100))
        .setValue(String(o.id)),
    ));

  await interaction.update({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`⚙️ Manage Active Offers (${offers.length})`).setDescription("Select an offer to edit or delete.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function getOfferById(id: number): Promise<OfferRow | null> {
  const result = await db.execute(sql`select * from gameday_schedule_offers where id = ${id} limit 1`);
  const rows = ((result as any).rows ?? result) as OfferRow[];
  return rows[0] ?? null;
}

async function showPendingOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offerId = Number(interaction.values[0]);
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.update({ ephemeral: true, content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
    return;
  }

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📨 Scheduling Offer #${offer.id}`)
        .setDescription([
          `**From:** <@${offer.proposer_discord_id}>`,
          `**Matchup:** <@${offer.away_discord_id}> @ <@${offer.home_discord_id}>`,
          `**Proposed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
          offer.notes ? `**Note:** ${offer.notes}` : "",
        ].filter(Boolean).join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_accept:${offer.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gd_offer_counter:${offer.id}`).setLabel("🔁 Counter").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gd_offer_reject:${offer.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_pending").setLabel("← Pending Offers").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showManageOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offerId = Number(interaction.values[0]);
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.update({ ephemeral: true, content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
    return;
  }

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`⚙️ Manage Offer #${offer.id}`)
        .setDescription([
          `**To:** <@${offer.recipient_discord_id}>`,
          `**Proposed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
          offer.notes ? `**Note:** ${offer.notes}` : "",
        ].filter(Boolean).join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_edit:${offer.id}`).setLabel("✏️ Edit").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gd_offer_delete:${offer.id}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_manage_offers").setLabel("← Manage Offers").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function acceptOffer(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'accepted', accepted_at = now(), updated_at = now()
    where id = ${offer.id}
  `);

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'superseded', updated_at = now()
    where guild_id = ${offer.guild_id}
      and season_id = ${offer.season_id}
      and week_index = ${offer.week_index}
      and matchup_key = ${offer.matchup_key}
      and status = 'pending'
      and id <> ${offer.id}
  `);

  const publicText =
    `✅ **Game Scheduled**\n` +
    `<@${offer.away_discord_id}> @ <@${offer.home_discord_id}>\n` +
    `**Confirmed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`;

  const ch = interaction.channel;
  if (ch?.isTextBased()) await ch.send({ content: publicText }).catch(() => null);

  for (const uid of [offer.proposer_discord_id, offer.recipient_discord_id]) {
    const member = await interaction.guild?.members.fetch(uid).catch(() => null);
    await member?.send(publicText).catch(() => null);
  }

  await interaction.update({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Offer Accepted").setDescription("The confirmed schedule was posted publicly in the gameday channel.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function rejectOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_reject:${offerId}`)
    .setTitle("Reject Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

async function handleRejectModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const reason = interaction.fields.getTextInputValue("reason").trim();
  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'rejected', notes = coalesce(notes, '') || ${`\n\nRejected reason: ${reason}`}, updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.proposer_discord_id).catch(() => null);
  await member?.send(`❌ Your scheduling offer for **${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}** was rejected.\n\n**Reason:** ${reason}`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("❌ Offer Rejected").setDescription("The proposer was notified by DM.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function counterOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_counter:${offerId}`)
    .setTitle("Counter Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_for").setLabel("Counter date/time").setPlaceholder("Example: Friday 9 PM CST").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_tz").setLabel("Timezone").setPlaceholder("CST, EST, MST, PST, etc.").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleCounterModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  await ensureGamedayTables();
  const original = await getOfferById(offerId);
  if (!original || original.recipient_discord_id !== ctx.userId || original.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);
  if (activeCount >= 3) {
    await interaction.reply({ ephemeral: true, content: "❌ You already have 3 active pending offers. Edit/delete one before countering." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim() || null;
  const notes = interaction.fields.getTextInputValue("notes").trim() || null;

  await executeOfferUpdate(sql`update gameday_schedule_offers set status = 'countered', updated_at = now() where id = ${original.id}`);

  await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.userId}, ${ctx.opponentId},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${proposedFor}, ${proposedTz}, ${notes}, 'pending'
    )
  `);

  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(`🔁 <@${ctx.userId}> countered with a new proposed game time:\n\n**${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}**\n\nOpen \`/gameday\` to respond.`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🔁 Counter Sent").setDescription(`Counter sent to <@${ctx.opponentId}>.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function editOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_edit:${offerId}`)
    .setTitle("Edit Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_for").setLabel("Proposed date/time").setValue(offer?.proposed_for ?? "").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_tz").setLabel("Timezone").setValue(offer?.proposed_tz ?? "").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setValue(offer?.notes ?? "").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleEditModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim() || null;
  const notes = interaction.fields.getTextInputValue("notes").trim() || null;

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set proposed_for = ${proposedFor}, proposed_tz = ${proposedTz}, notes = ${notes}, updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.recipient_discord_id).catch(() => null);
  await member?.send(`✏️ <@${ctx.userId}> edited a pending scheduling offer.\n\n**New Time:** ${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}\n\nOpen \`/gameday\` to respond.`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✏️ Offer Updated").setDescription("The opponent was notified by DM.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function deleteOffer(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'cancelled', updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.recipient_discord_id).catch(() => null);
  await member?.send(`🗑️ <@${ctx.userId}> deleted a pending scheduling offer for **${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}**.`).catch(() => null);

  await interaction.update({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🗑️ Offer Deleted").setDescription("The pending offer has been cancelled.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}


async function showGameQueue(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const status = await getMatchupStatus(ctx);
  const isAway = ctx.userId === ctx.awayDiscordId;
  const meChecked = isAway ? status.away_checked_in : status.home_checked_in;
  const oppChecked = isAway ? status.home_checked_in : status.away_checked_in;

  const begunText = status.begun_at
    ? `Game marked begun by <@${status.begun_by}> at <t:${Math.floor(new Date(status.begun_at).getTime() / 1000)}:t>.`
    : "Game has not been marked begun yet.";

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("🎮 Game Queue")
        .setDescription([
          `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
          `**Your check-in:** ${meChecked ? "✅ Checked in" : "❌ Not checked in"}`,
          `**Opponent check-in:** ${oppChecked ? "✅ Checked in" : "❌ Not checked in"}`,
          `**Status:** ${begunText}`,
          "",
          "Use these controls to coordinate gametime actions. Public notices will post for search/invite/start actions.",
        ].join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_checkin").setLabel("✅ Check In").setStyle(ButtonStyle.Success).setDisabled(meChecked),
        new ButtonBuilder().setCustomId("gd_checkout").setLabel("↩️ Check Out").setStyle(ButtonStyle.Secondary).setDisabled(!meChecked),
        new ButtonBuilder().setCustomId("gd_msg_opp").setLabel("💬 Message Opponent").setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_advise_search").setLabel("🔎 Advise to Search").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gd_request_invite").setLabel("🎮 Request Invite").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gd_mark_begun").setLabel("▶️ Mark Game Begun").setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleCheckIn(interaction: ButtonInteraction, ctx: GamedayContext, checkedIn: boolean): Promise<void> {
  await ensureMatchupStatus(ctx);
  const isAway = ctx.userId === ctx.awayDiscordId;
  if (isAway) {
    await db.execute(sql`
      update gameday_matchup_status
      set away_checked_in = ${checkedIn}, updated_at = now()
      where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
    `);
  } else {
    await db.execute(sql`
      update gameday_matchup_status
      set home_checked_in = ${checkedIn}, updated_at = now()
      where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
    `);
  }

  await dmOpponent(
    interaction,
    ctx,
    checkedIn
      ? `✅ <@${ctx.userId}> has checked in and is ready for your game.`
      : `↩️ <@${ctx.userId}> has checked out and is no longer marked ready.`,
  );

  await interaction.reply({
    ephemeral: true,
    content: checkedIn ? "✅ You are checked in. Your opponent was notified by DM." : "↩️ You checked out. Your opponent was notified by DM.",
  });
}

async function handleAdviseSearch(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureMatchupStatus(ctx);
  await db.execute(sql`
    update gameday_matchup_status
    set search_advised_by = ${ctx.userId}, updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);
  await postPublic(interaction, `🔎 <@${ctx.opponentId}> — <@${ctx.userId}> is advising you to search **Play Game** in the franchise menu.`);
  await interaction.reply({ ephemeral: true, content: "✅ Public search notice posted." });
}

async function handleRequestInvite(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureMatchupStatus(ctx);
  await db.execute(sql`
    update gameday_matchup_status
    set invite_requested_by = ${ctx.userId}, updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);
  await postPublic(interaction, `🎮 <@${ctx.opponentId}> — <@${ctx.userId}> is requesting that you send a game invite from the franchise menu.`);
  await interaction.reply({ ephemeral: true, content: "✅ Public invite request posted." });
}

async function showOpponentMessageModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_msg_opp")
    .setTitle("Message Opponent");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("message")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800),
    ),
  );

  await interaction.showModal(modal);
}

async function handleOpponentMessageModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const message = interaction.fields.getTextInputValue("message").trim();
  await dmOpponent(interaction, ctx, `💬 Message from <@${ctx.userId}> about your matchup:\n\n${message}`);
  await interaction.reply({ ephemeral: true, content: "✅ Message sent to your opponent by DM." });
}

async function showMarkBegunModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_mark_begun")
    .setTitle("Mark Game Begun");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("stream_url")
        .setLabel("Stream URL (optional)")
        .setPlaceholder("https://twitch.tv/yourchannel or leave blank")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200),
    ),
  );

  await interaction.showModal(modal);
}

async function autoPayStreamIfEligible(interaction: ModalSubmitInteraction, ctx: GamedayContext, streamUrl: string): Promise<number> {
  if (!isValidHttpUrl(streamUrl)) return 0;

  const payout = await getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, ctx.guildId);

  const existing = await db.execute(sql`
    select id
    from pending_channel_payouts
    where type = 'stream'
      and discord_id = ${ctx.userId}
      and season_id = ${ctx.season.id}
      and week = ${(ctx.season as any).currentWeek ?? "1"}
    limit 1
  `);
  const rows = ((existing as any).rows ?? existing) as any[];
  if (rows.length > 0) return 0;

  await db.execute(sql`
    insert into pending_channel_payouts (
      type, discord_id, amount, channel_id, message_id, guild_id, season_id, week,
      status, resolved_at, resolved_by
    )
    values (
      'stream', ${ctx.userId}, ${payout}, ${ctx.channelId}, 'gameday-start', ${ctx.guildId}, ${ctx.season.id}, ${(ctx.season as any).currentWeek ?? "1"},
      'approved', now(), 'bot:auto'
    )
  `);

  await addBalance(ctx.userId, payout, ctx.guildId);
  await logTransaction(ctx.userId, payout, "payout", `Auto stream payout — ${(ctx.season as any).currentWeek ?? "1"}`, ctx.guildId, "stream");
  return payout;
}

async function handleMarkBegunModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  await ensureMatchupStatus(ctx);
  const rawUrl = interaction.fields.getTextInputValue("stream_url").trim();
  if (rawUrl && !isValidHttpUrl(rawUrl)) {
    await interaction.reply({ ephemeral: true, content: "❌ Invalid stream URL. Use a full valid URL starting with http:// or https://, or leave it blank." });
    return;
  }

  const paid = await autoPayStreamIfEligible(interaction, ctx, rawUrl);

  await db.execute(sql`
    update gameday_matchup_status
    set begun_by = ${ctx.userId},
        begun_at = coalesce(begun_at, now()),
        stream_url = case when ${rawUrl || null}::text is not null then ${rawUrl || null} else stream_url end,
        stream_paid_to = case when ${paid > 0 ? ctx.userId : null}::text is not null then ${paid > 0 ? ctx.userId : null} else stream_paid_to end,
        updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);

  await postPublic(
    interaction,
    `▶️ **Game Begun**\n<@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>\nMarked begun by <@${ctx.userId}>.${rawUrl ? `\n📺 Stream: ${rawUrl}` : ""}${paid > 0 ? `\n💰 Stream payout automatically issued: **${paid} coins**.` : ""}`,
  );

  await interaction.reply({
    ephemeral: true,
    content: `✅ Game marked as begun.${paid > 0 ? ` Stream payout issued: ${paid} coins.` : rawUrl ? " Stream was already paid or payout was unavailable." : ""}`,
  });
}

export async function handleGamedayInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("gd_")) return false;

  const ctx = await getContext(interaction);
  if (!ctx) return true;

  if (interaction.isButton()) {
    if (interaction.customId === "gd_refresh") { await renderDashboard(interaction, ctx); return true; }
    if (interaction.customId === "gd_schedule") { await showScheduleMenu(interaction, ctx); return true; }
    if (interaction.customId === "gd_offer_new") { await showNewOfferModal(interaction); return true; }
    if (interaction.customId === "gd_pending") { await showPendingOffers(interaction, ctx); return true; }
    if (interaction.customId === "gd_manage_offers") { await showManageOffers(interaction, ctx); return true; }
    if (interaction.customId === "gd_queue") { await showGameQueue(interaction, ctx); return true; }
    if (interaction.customId === "gd_checkin") { await handleCheckIn(interaction, ctx, true); return true; }
    if (interaction.customId === "gd_checkout") { await handleCheckIn(interaction, ctx, false); return true; }
    if (interaction.customId === "gd_advise_search") { await handleAdviseSearch(interaction, ctx); return true; }
    if (interaction.customId === "gd_request_invite") { await handleRequestInvite(interaction, ctx); return true; }
    if (interaction.customId === "gd_msg_opp") { await showOpponentMessageModal(interaction); return true; }
    if (interaction.customId === "gd_mark_begun") { await showMarkBegunModal(interaction); return true; }

    if (interaction.customId.startsWith("gd_offer_accept:")) { await acceptOffer(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_reject:")) { await rejectOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_counter:")) { await counterOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_edit:")) { await editOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_delete:")) { await deleteOffer(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }

    await interaction.reply({ ephemeral: true, content: "⏳ This gameday feature is coming in a later phase." });
    return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "gd_pending_select") { await showPendingOfferDetail(interaction, ctx); return true; }
    if (interaction.customId === "gd_manage_select") { await showManageOfferDetail(interaction, ctx); return true; }
    return true;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "gd_modal_offer_new") { await handleNewOfferModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_modal_msg_opp") { await handleOpponentMessageModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_modal_mark_begun") { await handleMarkBegunModal(interaction, ctx); return true; }
    if (interaction.customId.startsWith("gd_modal_reject:")) { await handleRejectModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_counter:")) { await handleCounterModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_edit:")) { await handleEditModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    return true;
  }

  return true;
}
