import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  addBalance,
  deductBalance,
  getGuildChannel,
  getOrCreateActiveSeason,
  getOrCreateUser,
  logTransaction,
  CHANNEL_KEYS,
} from "../db/db-helpers.js";

type WagerDraft = {
  scheduleId?: number;
  pickedSide?: "away" | "home";
  pickedDiscordId?: string;
  pickedTeamName?: string;
  opponentDiscordId?: string;
  opponentTeamName?: string;
  spread?: number;
};

const drafts = new Map<string, WagerDraft>();

function draftKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
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

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export async function ensureWagerTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists coin_wagers (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      schedule_id integer,
      creator_discord_id text not null,
      acceptor_discord_id text,
      picked_side text not null,
      picked_team_name text not null,
      picked_discord_id text,
      opponent_team_name text not null,
      opponent_discord_id text,
      spread integer not null default 0,
      stake integer not null,
      status text not null default 'open',
      winner_discord_id text,
      settled_result text,
      created_at timestamp with time zone not null default now(),
      accepted_at timestamp with time zone,
      settled_at timestamp with time zone,
      updated_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    create index if not exists coin_wagers_board_idx
    on coin_wagers(guild_id, season_id, week_index, status)
  `);
}

async function getCurrentWeekContext(guildId: string) {
  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekIndexFromCurrentWeek((season as any).currentWeek);
  if (weekIndex == null) throw new Error("Current week does not support wagers.");
  return { season, weekIndex };
}

export async function openWagerBoard(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  await ensureWagerTables();
  const guildId = interaction.guildId!;
  const { season, weekIndex } = await getCurrentWeekContext(guildId);

  const open = await rowsOf<any>(sql`
    select *
    from coin_wagers
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and week_index = ${weekIndex}
      and status = 'open'
    order by created_at desc
    limit 10
  `);

  const description = open.length
    ? open.map((w, i) =>
        `**${i + 1}. Wager #${w.id}** — <@${w.creator_discord_id}> has **${w.picked_team_name} ${w.spread >= 0 ? "+" : ""}${w.spread}** for **${w.stake} coins**\n` +
        `Opponent side: **${w.opponent_team_name}**`
      ).join("\n\n")
    : "_No open wagers for this week._";

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("⚔️ Open Wager Board")
    .setDescription(
      description +
      "\n\nPoint spread rule: the selected team must still have the winning score after applying its handicap/spread.",
    );

  const rows: any[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("wager_create").setLabel("➕ Post Wager").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("wager_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (open.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("wager_accept_pick")
      .setPlaceholder("Accept an open wager…")
      .addOptions(open.slice(0, 25).map((w) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`#${w.id} · ${w.picked_team_name} ${w.spread >= 0 ? "+" : ""}${w.spread} · ${w.stake} coins`.slice(0, 100))
          .setDescription(`Posted by ${w.creator_discord_id}`.slice(0, 100))
          .setValue(String(w.id)),
      ));
    rows.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  const payload = { ephemeral: true, embeds: [embed], components: rows };
  if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
  else await (interaction as any).update(payload).catch(() => (interaction as any).reply(payload));
}

async function showMatchupSelect(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const { season, weekIndex } = await getCurrentWeekContext(guildId);

  const games = await rowsOf<any>(sql`
    select *
    from game_schedules
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and week_index = ${weekIndex}
    order by id asc
    limit 25
  `);

  if (!games.length) {
    await interaction.reply({ ephemeral: true, content: "❌ No game schedule rows are available for this week yet." });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("wager_matchup")
    .setPlaceholder("Select matchup…")
    .addOptions(games.map((g) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${g.away_team_name} @ ${g.home_team_name}`.slice(0, 100))
        .setValue(String(g.id)),
    ));

  await interaction.update({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("⚔️ Post Wager — Select Matchup")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("wager_refresh").setLabel("← Board").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showSideSelect(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const scheduleId = Number(interaction.values[0]);
  const [game] = await rowsOf<any>(sql`
    select *
    from game_schedules
    where id = ${scheduleId}
      and guild_id = ${guildId}
    limit 1
  `);
  if (!game) {
    await interaction.reply({ ephemeral: true, content: "❌ Matchup not found." });
    return;
  }

  drafts.set(draftKey(guildId, interaction.user.id), { scheduleId });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("wager_side")
    .setPlaceholder("Which side are you taking?")
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel(game.away_team_name).setValue(`away:${game.away_discord_id}:${game.away_team_name}:${game.home_discord_id}:${game.home_team_name}`),
      new StringSelectMenuOptionBuilder().setLabel(game.home_team_name).setValue(`home:${game.home_discord_id}:${game.home_team_name}:${game.away_discord_id}:${game.away_team_name}`),
    ]);

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("⚔️ Post Wager — Pick Your Side")
        .setDescription(`Matchup: **${game.away_team_name} @ ${game.home_team_name}**`),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function showSpreadSelect(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const [side, pickedDiscordId, pickedTeamName, opponentDiscordId, opponentTeamName] = interaction.values[0]!.split(":");
  const draft = drafts.get(draftKey(guildId, interaction.user.id)) ?? {};
  drafts.set(draftKey(guildId, interaction.user.id), {
    ...draft,
    pickedSide: side as "away" | "home",
    pickedDiscordId,
    pickedTeamName,
    opponentDiscordId,
    opponentTeamName,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("wager_spread")
    .setPlaceholder("Select point spread handicap…")
    .addOptions(Array.from({ length: 21 }, (_, i) => i - 10).map((n) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${n >= 0 ? "+" : ""}${n}`)
        .setDescription(n === 0 ? "Pick'em" : `Apply ${n >= 0 ? "+" : ""}${n} to your selected team's score`)
        .setValue(String(n)),
    ));

  await interaction.update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("⚔️ Post Wager — Select Spread")
        .setDescription(`Your side: **${pickedTeamName}**`),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function showStakeModal(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const spread = Number(interaction.values[0]);
  const draft = drafts.get(draftKey(guildId, interaction.user.id)) ?? {};
  drafts.set(draftKey(guildId, interaction.user.id), { ...draft, spread });

  const modal = new ModalBuilder()
    .setCustomId("wager_modal_stake")
    .setTitle("Post Wager");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("stake")
        .setLabel("Stake amount in coins")
        .setPlaceholder("Example: 50")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6),
    ),
  );

  await interaction.showModal(modal);
}

async function handleStakeModal(interaction: ModalSubmitInteraction) {
  await ensureWagerTables();
  const guildId = interaction.guildId!;
  const key = draftKey(guildId, interaction.user.id);
  const draft = drafts.get(key);
  if (!draft?.scheduleId || draft.spread == null || !draft.pickedSide || !draft.pickedTeamName || !draft.opponentTeamName) {
    await interaction.reply({ ephemeral: true, content: "❌ Wager draft expired. Start again." });
    return;
  }

  const stake = Number(interaction.fields.getTextInputValue("stake").trim());
  if (!Number.isInteger(stake) || stake <= 0) {
    await interaction.reply({ ephemeral: true, content: "❌ Stake must be a positive whole number." });
    return;
  }

  const { season, weekIndex } = await getCurrentWeekContext(guildId);
  await getOrCreateUser(interaction.user.id, interaction.user.username, guildId);
  const paid = await deductBalance(interaction.user.id, stake, guildId);
  if (!paid) {
    await interaction.reply({ ephemeral: true, content: "❌ You do not have enough coins for that stake." });
    return;
  }

  await logTransaction(interaction.user.id, -stake, "removecoins", `Wager escrow posted`, guildId, "wager");

  const result = await db.execute(sql`
    insert into coin_wagers (
      guild_id, season_id, week_index, schedule_id,
      creator_discord_id, picked_side, picked_team_name, picked_discord_id,
      opponent_team_name, opponent_discord_id, spread, stake, status
    )
    values (
      ${guildId}, ${season.id}, ${weekIndex}, ${draft.scheduleId},
      ${interaction.user.id}, ${draft.pickedSide}, ${draft.pickedTeamName}, ${draft.pickedDiscordId ?? null},
      ${draft.opponentTeamName}, ${draft.opponentDiscordId ?? null}, ${draft.spread}, ${stake}, 'open'
    )
    returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const wagerId = rows[0]?.id;

  drafts.delete(key);

  const generalId = await getGuildChannel(guildId, CHANNEL_KEYS.GENERAL).catch(() => null);
  const channel = generalId ? await interaction.guild?.channels.fetch(generalId).catch(() => null) : null;

  const content =
    `⚔️ **Open Wager Posted**\n` +
    `<@${interaction.user.id}> is taking **${draft.pickedTeamName} ${draft.spread >= 0 ? "+" : ""}${draft.spread}** for **${stake} coins**.\n\n` +
    `Opponent side: **${draft.opponentTeamName}**\n` +
    `Accept through **/menu → Financials → Wager** or use the button below.`;

  if (channel?.isTextBased()) {
    await channel.send({
      content,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`wager_accept:${wagerId}`).setLabel("Accept Wager").setStyle(ButtonStyle.Success),
        ),
      ],
    }).catch(() => null);
  }

  await interaction.reply({ ephemeral: true, content: `✅ Wager #${wagerId} posted publicly and your **${stake} coins** were placed in escrow.` });
}

async function acceptWager(interaction: ButtonInteraction | StringSelectMenuInteraction, wagerId: number) {
  await ensureWagerTables();
  const guildId = interaction.guildId!;
  const [wager] = await rowsOf<any>(sql`
    select *
    from coin_wagers
    where id = ${wagerId}
      and guild_id = ${guildId}
      and status = 'open'
    limit 1
  `);
  if (!wager) {
    await (interaction as any).reply({ ephemeral: true, content: "❌ Wager is no longer open." }).catch(() => null);
    return;
  }
  if (wager.creator_discord_id === interaction.user.id) {
    await (interaction as any).reply({ ephemeral: true, content: "❌ You cannot accept your own wager." }).catch(() => null);
    return;
  }

  await getOrCreateUser(interaction.user.id, interaction.user.username, guildId);
  const paid = await deductBalance(interaction.user.id, wager.stake, guildId);
  if (!paid) {
    await (interaction as any).reply({ ephemeral: true, content: "❌ You do not have enough coins to accept this wager." }).catch(() => null);
    return;
  }

  await logTransaction(interaction.user.id, -wager.stake, "removecoins", `Wager escrow accepted #${wager.id}`, guildId, wager.creator_discord_id);

  await db.execute(sql`
    update coin_wagers
    set acceptor_discord_id = ${interaction.user.id},
        status = 'accepted',
        accepted_at = now(),
        updated_at = now()
    where id = ${wager.id}
  `);

  const generalId = await getGuildChannel(guildId, CHANNEL_KEYS.GENERAL).catch(() => null);
  const channel = generalId ? await interaction.guild?.channels.fetch(generalId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await channel.send(
      `✅ **Wager Accepted**\n` +
      `<@${interaction.user.id}> accepted wager #${wager.id} against <@${wager.creator_discord_id}>.\n\n` +
      `Creator side: **${wager.picked_team_name} ${wager.spread >= 0 ? "+" : ""}${wager.spread}**\n` +
      `Acceptor side: **${wager.opponent_team_name}**\n` +
      `Stake: **${wager.stake} coins each**.`,
    ).catch(() => null);
  }

  await (interaction as any).reply({ ephemeral: true, content: `✅ Wager #${wager.id} accepted. **${wager.stake} coins** were placed in escrow.` }).catch(() => null);
}

export async function processWagerSettlementTick(client: any): Promise<void> {
  await ensureWagerTables();

  const wagers = await rowsOf<any>(sql`
    select w.*, gs.away_score, gs.home_score, gs.away_discord_id, gs.home_discord_id, gs.status as game_status
    from coin_wagers w
    join game_schedules gs on gs.id = w.schedule_id
    where w.status = 'accepted'
      and gs.away_score is not null
      and gs.home_score is not null
    limit 50
  `);

  for (const w of wagers) {
    const pickedIsAway = w.picked_side === "away";
    const pickedScore = pickedIsAway ? Number(w.away_score) : Number(w.home_score);
    const otherScore = pickedIsAway ? Number(w.home_score) : Number(w.away_score);
    const adjusted = pickedScore + Number(w.spread);
    const totalPot = Number(w.stake) * 2;

    let winner: string | null = null;
    let result = "";
    if (adjusted > otherScore) {
      winner = w.creator_discord_id;
      result = "creator_win";
    } else if (adjusted < otherScore) {
      winner = w.acceptor_discord_id;
      result = "acceptor_win";
    } else {
      result = "push";
    }

    if (winner) {
      await addBalance(winner, totalPot, w.guild_id);
      await logTransaction(winner, totalPot, "addcoins", `Wager #${w.id} settled`, w.guild_id, winner === w.creator_discord_id ? w.acceptor_discord_id : w.creator_discord_id);
    } else {
      await addBalance(w.creator_discord_id, Number(w.stake), w.guild_id);
      await addBalance(w.acceptor_discord_id, Number(w.stake), w.guild_id);
      await logTransaction(w.creator_discord_id, Number(w.stake), "addcoins", `Wager #${w.id} push refund`, w.guild_id, w.acceptor_discord_id);
      await logTransaction(w.acceptor_discord_id, Number(w.stake), "addcoins", `Wager #${w.id} push refund`, w.guild_id, w.creator_discord_id);
    }

    await db.execute(sql`
      update coin_wagers
      set status = 'settled',
          winner_discord_id = ${winner},
          settled_result = ${result},
          settled_at = now(),
          updated_at = now()
      where id = ${w.id}
    `);

    const generalIdRows = await rowsOf<{ channel_id: string }>(sql`
      select channel_id
      from guild_channels
      where guild_id = ${w.guild_id}
        and channel_key = 'general'
      limit 1
    `);
    const channelId = generalIdRows[0]?.channel_id;
    const ch = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    await ch?.send(
      winner
        ? `⚔️ **Wager #${w.id} Settled**\nWinner: <@${winner}> won **${totalPot} coins**.\nResult after spread: **${w.picked_team_name} ${adjusted} — ${w.opponent_team_name} ${otherScore}**.`
        : `⚔️ **Wager #${w.id} Push**\nAdjusted result tied. Both users were refunded **${w.stake} coins**.`,
    ).catch(() => null);
  }
}

export async function handleWagerInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("wager_")) return false;

  if (interaction.isButton()) {
    if (interaction.customId === "wager_refresh") { await openWagerBoard(interaction); return true; }
    if (interaction.customId === "wager_create") { await showMatchupSelect(interaction); return true; }
    if (interaction.customId.startsWith("wager_accept:")) { await acceptWager(interaction, Number(interaction.customId.split(":")[1])); return true; }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "wager_matchup") { await showSideSelect(interaction); return true; }
    if (interaction.customId === "wager_side") { await showSpreadSelect(interaction); return true; }
    if (interaction.customId === "wager_spread") { await showStakeModal(interaction); return true; }
    if (interaction.customId === "wager_accept_pick") { await acceptWager(interaction, Number(interaction.values[0])); return true; }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "wager_modal_stake") { await handleStakeModal(interaction); return true; }
  }

  return true;
}
