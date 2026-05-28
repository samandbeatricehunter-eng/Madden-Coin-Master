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
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  db,
  franchiseMcaTeamsTable,
  franchiseScheduleTable,
  usersTable,
  wagersTable,
} from "@workspace/db";
import { getOrCreateActiveSeason, getOrCreateUser } from "../../../../db/db-helpers.js";
import { getServerSettings } from "../../../../db/server-settings.js";
import { PLAYOFF_WEEK_META } from "../../../../franchise/playoff-matchups-runner.js";
import { lookupNflDivision } from "../../../../constants.js";
import { clearWagerDraft, getWagerDraft, patchWagerDraft, type WagerDraft, type WagerSide } from "./wager-session.js";

function backToHubRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
}

function cancelRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );
}

function weekKeyToIndex(weekKey: string): number | null {
  const num = Number.parseInt(weekKey, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= 18) return num - 1;
  const meta = (PLAYOFF_WEEK_META as Record<string, { weekIndex: number } | undefined>)[weekKey];
  return meta ? meta.weekIndex : null;
}

function spreadLabel(spread: number): string {
  return spread > 0 ? `+${spread}` : `${spread}`;
}

function spreadDescription(myTeam: string, theirTeam: string, spread: number): string {
  if (spread < 0) return `**${myTeam}** must win by more than **${Math.abs(spread)}** points\n\`${myTeam} score − ${Math.abs(spread)} > ${theirTeam} score\``;
  if (spread === 0) return `**${myTeam}** must win outright\n\`${myTeam} score > ${theirTeam} score\``;
  return `**${myTeam}** can lose by up to **${spread}** points and still cover\n\`${myTeam} score > ${theirTeam} score − ${spread}\``;
}

async function buildOpponentSelectRows(
  guildId: string,
  excludeDiscordId: string,
  selectedOpponentId?: string,
): Promise<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[]> {
  const linkedUsers = await db
    .select({
      discordId: usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team: usersTable.team,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
      ne(usersTable.discordId, excludeDiscordId),
    ));

  const afcUsers = linkedUsers.filter((u) => lookupNflDivision(u.team ?? "")?.conference === "AFC");
  const nfcUsers = linkedUsers.filter((u) => lookupNflDivision(u.team ?? "")?.conference === "NFC");
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  if (afcUsers.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ac_wager_opponent_afc")
        .setPlaceholder("AFC — Pick Opponent")
        .addOptions(afcUsers.slice(0, 25).map((u) => new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team} — ${u.discordUsername ?? u.discordId}`.slice(0, 100))
          .setValue(u.discordId)
          .setDefault(u.discordId === selectedOpponentId),
        )),
    ));
  }

  if (nfcUsers.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ac_wager_opponent_nfc")
        .setPlaceholder("NFC — Pick Opponent")
        .addOptions(nfcUsers.slice(0, 25).map((u) => new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team} — ${u.discordUsername ?? u.discordId}`.slice(0, 100))
          .setValue(u.discordId)
          .setDefault(u.discordId === selectedOpponentId),
        )),
    ));
  }

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_wager_send").setLabel("📨 Send Wager").setStyle(ButtonStyle.Success).setDisabled(!selectedOpponentId),
    new ButtonBuilder().setCustomId("ac_wager_back_to_spread").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

export async function showWagerGameSelect(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const settings = await getServerSettings(guildId);
  if (!settings.coinEconomy || !settings.wagerEnabled) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Wagers are currently disabled by the commissioners.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekKeyToIndex(String((season as any).currentWeek ?? "1"));
  if (weekIndex === null) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No schedule data found for the current week. Ask a commissioner to import the schedule from MCA.")], components: [backToHubRow()] });
    return;
  }

  let scheduleRows = await db.select({
    id: franchiseScheduleTable.id,
    homeTeamId: franchiseScheduleTable.homeTeamId,
    awayTeamId: franchiseScheduleTable.awayTeamId,
    homeTeamName: franchiseScheduleTable.homeTeamName,
    awayTeamName: franchiseScheduleTable.awayTeamName,
  })
    .from(franchiseScheduleTable)
    .where(and(eq(franchiseScheduleTable.seasonId, season.id), eq(franchiseScheduleTable.weekIndex, weekIndex)))
    .limit(32);

  if (!scheduleRows.length && weekIndex >= 1000) {
    scheduleRows = await db.select({
      id: franchiseScheduleTable.id,
      homeTeamId: franchiseScheduleTable.homeTeamId,
      awayTeamId: franchiseScheduleTable.awayTeamId,
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
    })
      .from(franchiseScheduleTable)
      .where(and(eq(franchiseScheduleTable.seasonId, season.id), eq(franchiseScheduleTable.weekIndex, weekIndex - 1000)))
      .limit(32);
  }

  if (!scheduleRows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No schedule data found for the current week. Ask a commissioner to import the schedule from MCA.")], components: [backToHubRow()] });
    return;
  }

  const mcaTeams = await db.select({ teamId: franchiseMcaTeamsTable.teamId, discordId: franchiseMcaTeamsTable.discordId })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), isNotNull(franchiseMcaTeamsTable.discordId)));

  const linkedTeamIds = new Set(mcaTeams.filter((m) => m.discordId).map((m) => m.teamId));
  const h2hGames = scheduleRows.filter((g) => linkedTeamIds.has(g.homeTeamId) && linkedTeamIds.has(g.awayTeamId));

  if (!h2hGames.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No head-to-head games found this week. Both teams must be linked to active users.")], components: [backToHubRow()] });
    return;
  }

  patchWagerDraft(guildId, interaction.user.id, {});

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_wager_game")
    .setPlaceholder("Select a game to wager on…")
    .addOptions(h2hGames.slice(0, 25).map((g) => new StringSelectMenuOptionBuilder()
      .setLabel(`${g.awayTeamName} @ ${g.homeTeamName}`.slice(0, 100))
      .setValue(String(g.id)),
    ));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 1 of 4").setDescription("Select the head-to-head game you want to wager on. Only games where both teams are linked to active users are shown.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

export async function selectWagerGame(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const gameId = Number(interaction.values[0]);
  const season = await getOrCreateActiveSeason(guildId);
  const game = await db.select().from(franchiseScheduleTable).where(eq(franchiseScheduleTable.id, gameId)).limit(1).then((rows) => rows[0]);

  if (!game) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Game not found.")], components: [backToHubRow()] });
    return;
  }

  const [homeMca] = await db.select({ discordId: franchiseMcaTeamsTable.discordId })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, game.homeTeamId)))
    .limit(1);
  const [awayMca] = await db.select({ discordId: franchiseMcaTeamsTable.discordId })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, game.awayTeamId)))
    .limit(1);

  patchWagerDraft(guildId, interaction.user.id, {
    scheduleGameId: String(gameId),
    wagerHomeTeam: game.homeTeamName,
    wagerAwayTeam: game.awayTeamName,
    wagerHomeDiscordId: homeMca?.discordId ?? undefined,
    wagerAwayDiscordId: awayMca?.discordId ?? undefined,
  });

  const userLine = homeMca?.discordId && awayMca?.discordId ? `\n🏠 <@${homeMca.discordId}> vs ✈️ <@${awayMca.discordId}>` : "";

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 2 of 4").setDescription(`**${game.awayTeamName} @ ${game.homeTeamName}**${userLine}\n\nWhich team are you backing?`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_pick:home").setLabel(`🏠 ${game.homeTeamName}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ac_wager_pick:away").setLabel(`✈️ ${game.awayTeamName}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function pickWagerTeam(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const side = interaction.customId.split(":")[1] as WagerSide;
  const draft = getWagerDraft(guildId, interaction.user.id);
  const team = side === "home" ? draft.wagerHomeTeam : draft.wagerAwayTeam;
  patchWagerDraft(guildId, interaction.user.id, { wagerSide: side, wagerTeam: team });

  const theirTeam = side === "home" ? draft.wagerAwayTeam ?? "Opponent" : draft.wagerHomeTeam ?? "Opponent";
  const myTeam = team ?? "Your Team";

  const spreadOptions: StringSelectMenuOptionBuilder[] = [];
  for (let spread = -10; spread <= 10; spread++) {
    const label = spread === 0 ? "0 (straight win)" : spread > 0 ? `+${spread}` : `${spread}`;
    const desc = spread < 0 ? `${myTeam} must win by more than ${Math.abs(spread)}` : spread === 0 ? `${myTeam} must win outright` : `${myTeam} can lose by up to ${spread} and still cover`;
    spreadOptions.push(new StringSelectMenuOptionBuilder().setLabel(label).setValue(String(spread)).setDescription(desc.slice(0, 100)));
  }

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 3 of 4").setDescription(`You're backing **${myTeam}** vs **${theirTeam}**.\n\nSelect your point spread.`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("ac_wager_spread").setPlaceholder("Select your point spread…").addOptions(spreadOptions)), cancelRow()],
  });
}

export async function selectWagerSpread(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const spread = Number.parseInt(interaction.values[0] ?? "0", 10);
  const draft = patchWagerDraft(guildId, interaction.user.id, { wagerSpread: spread });
  const myTeam = draft.wagerTeam ?? "Your Team";
  const theirTeam = draft.wagerSide === "home" ? draft.wagerAwayTeam ?? "Opponent" : draft.wagerHomeTeam ?? "Opponent";

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 3 of 4 (Spread Confirmed)").setDescription(`**Spread: ${spreadLabel(spread)}**\n\n${spreadDescription(myTeam, theirTeam, spread)}\n\nIf scores are tied after the spread is applied, the bet is a **push**. Click **Next** to enter your wager amount.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_spread_next").setLabel("Next →").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ac_wager_back_to_team").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function backToWagerTeam(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const draft = getWagerDraft(guildId, interaction.user.id);
  const homeTeam = draft.wagerHomeTeam ?? "Home";
  const awayTeam = draft.wagerAwayTeam ?? "Away";
  const userLine = draft.wagerHomeDiscordId && draft.wagerAwayDiscordId ? `\n🏠 <@${draft.wagerHomeDiscordId}> vs ✈️ <@${draft.wagerAwayDiscordId}>` : "";
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 2 of 4").setDescription(`**${awayTeam} @ ${homeTeam}**${userLine}\n\nWhich team are you backing?`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_pick:home").setLabel(`🏠 ${homeTeam}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ac_wager_pick:away").setLabel(`✈️ ${awayTeam}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function showWagerAmountModal(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(new ModalBuilder()
    .setCustomId("ac_modal_wageramount")
    .setTitle("Wager Amount")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId("amount")
      .setLabel("Coins to wager (each player stakes this)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. 500")
      .setRequired(true)
      .setMaxLength(10),
    )),
  );
}

export async function submitWagerAmount(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const amount = Number.parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);

  if (!Number.isFinite(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Invalid amount. Enter a positive whole number.", ephemeral: true });
    return;
  }

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, guildId);
  if (Number(user.balance) < amount) {
    await interaction.reply({ content: `❌ Insufficient coins. You have **${Number(user.balance).toLocaleString()}**, wager is **${amount.toLocaleString()}**.`, ephemeral: true });
    return;
  }

  const draft = patchWagerDraft(guildId, interaction.user.id, { wagerAmount: amount });
  const myTeam = draft.wagerTeam ?? "Your Team";
  const theirTeam = draft.wagerSide === "home" ? draft.wagerAwayTeam ?? "Opponent" : draft.wagerHomeTeam ?? "Opponent";
  const spread = draft.wagerSpread ?? 0;
  const rows = await buildOpponentSelectRows(guildId, interaction.user.id);

  if (rows.length === 1) {
    await interaction.reply({ content: "❌ No other linked users found to wager against.", ephemeral: true });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 4 of 4").setDescription(`**Your pick:** ${myTeam} (${spreadLabel(spread)})\n**Amount:** ${amount.toLocaleString()} coins each\n\n${spreadDescription(myTeam, theirTeam, spread)}\n\nSelect the opponent you want to challenge, then click **Send Wager**.`)],
    components: rows as ActionRowBuilder<any>[],
  });
}

export async function selectWagerOpponent(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const opponentId = interaction.values[0] ?? "";
  const [oppRecord] = await db.select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, opponentId), eq(usersTable.guildId, guildId)))
    .limit(1);

  const draft = patchWagerDraft(guildId, interaction.user.id, { wagerOpponentId: opponentId, wagerOpponentTeam: oppRecord?.team ?? undefined });
  const myTeam = draft.wagerTeam ?? "Your Team";
  const spread = draft.wagerSpread ?? 0;
  const amount = draft.wagerAmount ?? 0;
  const rows = await buildOpponentSelectRows(guildId, interaction.user.id, opponentId);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 4 of 4").setDescription(`**Your pick:** ${myTeam} (${spreadLabel(spread)})\n**Amount:** ${amount.toLocaleString()} coins each\n\n✅ **Opponent selected:** <@${opponentId}> (${oppRecord?.team ?? "Unknown"})\n\nClick **Send Wager** to challenge them.`)],
    components: rows as ActionRowBuilder<any>[],
  });
}

export async function backToWagerSpread(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const draft = getWagerDraft(guildId, interaction.user.id);
  const myTeam = draft.wagerTeam ?? "Your Team";
  const theirTeam = draft.wagerSide === "home" ? draft.wagerAwayTeam ?? "Opponent" : draft.wagerHomeTeam ?? "Opponent";
  const spread = draft.wagerSpread ?? 0;
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 3 of 4 (Spread Confirmed)").setDescription(`**Spread: ${spreadLabel(spread)}**\n\n${spreadDescription(myTeam, theirTeam, spread)}\n\nClick **Next** to set your wager amount.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_spread_next").setLabel("Next →").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ac_wager_back_to_team").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    )],
  });
}

function validateReadyToSend(draft: WagerDraft): string | null {
  if (!draft.wagerOpponentId) return "Missing opponent.";
  if (!draft.wagerTeam) return "Missing team pick.";
  if (!draft.wagerAmount) return "Missing wager amount.";
  if (draft.wagerSpread === undefined) return "Missing spread.";
  if (!draft.wagerSide) return "Missing side.";
  return null;
}

export async function sendWagerChallenge(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const draft = getWagerDraft(guildId, interaction.user.id);
  const error = validateReadyToSend(draft);
  if (error) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ ${error} Please start over from the hub.`)], components: [backToHubRow()] });
    return;
  }

  const challenger = await getOrCreateUser(interaction.user.id, interaction.user.username, guildId);
  if (Number(challenger.balance) < Number(draft.wagerAmount)) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Insufficient coins. Your balance: **${Number(challenger.balance).toLocaleString()}**, wager: **${Number(draft.wagerAmount).toLocaleString()}**.`)], components: [backToHubRow()] });
    return;
  }

  const teamFor = draft.wagerTeam!;
  const teamAgainst = draft.wagerSide === "home" ? draft.wagerAwayTeam ?? "Opponent" : draft.wagerHomeTeam ?? "Opponent";
  const [oppRecord] = await db.select({ discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, draft.wagerOpponentId!), eq(usersTable.guildId, guildId)))
    .limit(1);

  await getOrCreateUser(draft.wagerOpponentId!, oppRecord?.discordUsername ?? "Unknown", guildId);

  const [wager] = await db.insert(wagersTable).values({
    guildId,
    challengerId: interaction.user.id,
    challengerUsername: interaction.user.username,
    opponentId: draft.wagerOpponentId!,
    opponentUsername: oppRecord?.discordUsername ?? "Unknown",
    amount: draft.wagerAmount!,
    pot: draft.wagerAmount! * 2,
    teamFor,
    teamAgainst,
    status: "pending",
    spread: draft.wagerSpread!,
    challengerSide: draft.wagerSide!,
    scheduleGameId: draft.scheduleGameId ? Number.parseInt(draft.scheduleGameId, 10) : undefined,
  }).returning();

  if (!wager) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Failed to create wager record. Please try again.")], components: [backToHubRow()] });
    return;
  }

  await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Wager Challenge Sent").setDescription(`Challenge sent to <@${draft.wagerOpponentId}>.\n\n**Wager #${wager.id}**`)], components: [] });

  const [challengerMember, opponentMember] = await Promise.all([
    interaction.guild?.members.fetch(interaction.user.id).catch(() => null),
    interaction.guild?.members.fetch(draft.wagerOpponentId!).catch(() => null),
  ]);
  const challengerName = challengerMember?.displayName ?? interaction.user.username;
  const opponentName = opponentMember?.displayName ?? oppRecord?.discordUsername ?? "Opponent";
  const spread = draft.wagerSpread!;

  const challengeEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚔️ Wager Challenge")
    .setDescription(`<@${interaction.user.id}> has challenged <@${draft.wagerOpponentId}> to a coin wager.`)
    .addFields(
      { name: "💰 Stake", value: `**${Number(draft.wagerAmount).toLocaleString()} coins** each (pot: **${(Number(draft.wagerAmount) * 2).toLocaleString()}**)` },
      { name: `🏈 ${challengerName} is backing`, value: `**${teamFor}** (spread: ${spreadLabel(spread)})`, inline: true },
      { name: `🏈 ${opponentName} is backing`, value: `**${teamAgainst}**`, inline: true },
      { name: "📊 Challenger's Spread", value: spreadDescription(teamFor, teamAgainst, spread) },
      { name: "📋 Status", value: "⏳ Waiting for opponent to respond…" },
    )
    .setFooter({ text: `Wager #${wager.id}` })
    .setTimestamp();

  const challengeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wager_accept:${wager.id}`).setLabel("✅ Accept Wager").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wager_refuse:${wager.id}`).setLabel("❌ Refuse").setStyle(ButtonStyle.Danger),
  );

  if (interaction.channel?.isTextBased()) {
    const msg = await (interaction.channel as any).send({ content: `<@${draft.wagerOpponentId}> — you have a wager challenge.`, embeds: [challengeEmbed], components: [challengeRow] }).catch(() => null);
    if (msg?.id) await db.update(wagersTable).set({ challengeMessageId: msg.id }).where(eq(wagersTable.id, wager.id));
  }

  clearWagerDraft(guildId, interaction.user.id);
}
