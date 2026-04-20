import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, gameLogTable,
  h2hMatchupRecordsTable, franchiseProcessedGamesTable,
  globalUserRecordsTable, franchiseScheduleTable,
  franchiseMcaTeamsTable, coinTransactionsTable,
  seasonStatTierConfigsTable, guildTweetsTable, interviewRequestsTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, isNull, desc, inArray } from "drizzle-orm";
import {
  addBalance, logTransaction, getOrCreateActiveSeason,
  isAdminUser, getGuildChannel, CHANNEL_KEYS, upsertGlobalRecord,
  getOrCreateUser, getRosterSeasonId,
} from "./db-helpers.js";
import {
  getPayoutValue, setPayoutValue, getAllPayoutConfig, getMilestoneTiers,
  PAYOUT_KEYS, MILESTONE_TIER_KEYS, type PayoutKey,
} from "./payout-config.js";
import { weekLabel } from "../commands/advanceweek.js";
import { buildPayoutHubEmbed, buildPayoutHubRows } from "../commands/admin-payout.js";
import { NFL_DIVISION_MAP } from "./constants.js";
import { STAT_CATEGORIES, STAT_TIER_DEFAULTS, STAT_CATEGORY_MAP } from "./stat-categories.js";

// ── Session state ─────────────────────────────────────────────────────────────
interface GameOption {
  home: string;
  away: string;
  homeDiscord: string | null;
  awayDiscord: string | null;
}

interface PayoutSession {
  flow: string;
  afcSelected: string[];
  nfcSelected: string[];
  selectedWeekIndex?: number;
  selectedGameId?: string;
  homeDiscordId?: string;
  awayDiscordId?: string;
  homeTeam?: string;
  awayTeam?: string;
  isCpu?: boolean;
  currentWinnerId?: string;
  currentLoserId?: string;
  step1Data?: Record<string, string>;
  eosKey?: PayoutKey;
  eosStatCategory?: string;
  milestoneIndex?: number;
  gameOptions?: GameOption[];
  correctGameOptions?: Record<string, { gameId: string; winnerId: string | null; loserId: string | null; homeTeam: string | null; awayTeam: string | null }>;
  potwSelections?: string[];
}

// Key: `${guildId}:${userId}`
export const payoutSessions = new Map<string, PayoutSession>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// ── Auth guard ────────────────────────────────────────────────────────────────
async function checkAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = (member as any)?.permissions?.has(8n) ?? false; // Administrator flag
  const isDbAdmin = await isAdminUser(interaction.user.id, interaction.guildId!);
  return isDiscordAdmin || isDbAdmin;
}

// ── Build AFC/NFC select rows from guild users ────────────────────────────────
async function buildConferenceSelectRows(
  guildId: string,
  prefix: string,
  afcSelected: string[] = [],
  nfcSelected: string[] = [],
  maxValues = 25,
): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
  const users = await db.select({
    discordId: usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team: usersTable.team,
  }).from(usersTable).where(and(
    eq(usersTable.guildId, guildId),
    isNotNull(usersTable.team),
  ));

  const afcUsers = users.filter(u => {
    if (!u.team || u.discordId.startsWith("unlinked_")) return false;
    return NFL_DIVISION_MAP[u.team]?.conference === "AFC";
  });
  const nfcUsers = users.filter(u => {
    if (!u.team || u.discordId.startsWith("unlinked_")) return false;
    return NFL_DIVISION_MAP[u.team]?.conference === "NFC";
  });

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (afcUsers.length > 0) {
    const afcSelect = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_afc`)
      .setPlaceholder(`AFC — select users (${afcSelected.length} selected)`)
      .setMinValues(0)
      .setMaxValues(Math.min(maxValues, afcUsers.length))
      .addOptions(afcUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team ?? u.discordUsername}`)
          .setValue(u.discordId)
          .setDescription(`@${u.discordUsername}`)
          .setDefault(afcSelected.includes(u.discordId))
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(afcSelect));
  }

  if (nfcUsers.length > 0) {
    const nfcSelect = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_nfc`)
      .setPlaceholder(`NFC — select users (${nfcSelected.length} selected)`)
      .setMinValues(0)
      .setMaxValues(Math.min(maxValues, nfcUsers.length))
      .addOptions(nfcUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team ?? u.discordUsername}`)
          .setValue(u.discordId)
          .setDescription(`@${u.discordUsername}`)
          .setDefault(nfcSelected.includes(u.discordId))
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(nfcSelect));
  }

  return rows;
}

// ── Cancel / hub return ───────────────────────────────────────────────────────
export async function handleCancel(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  payoutSessions.delete(key);
  await interaction.update({
    embeds: [buildPayoutHubEmbed()],
    components: buildPayoutHubRows(),
  });
}

export async function handleClose(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  payoutSessions.delete(key);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("✖ Hub Closed").setDescription("The Payout Management Hub has been closed.")],
    components: [],
  });
}

// ── GOTW Voting ───────────────────────────────────────────────────────────────
export async function handleGotw(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const key = sessionKey(interaction.guildId!, interaction.user.id);
  payoutSessions.set(key, { flow: "gotw", afcSelected: [], nfcSelected: [] });

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const currentWeek = (season as any).currentWeek ?? "1";
  const isPlayoff   = ["wildcard","divisional","conference","superbowl"].includes(currentWeek);
  const bonus = await getPayoutValue(isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS, interaction.guildId!);
  const weekDisplay = weekLabel(currentWeek);

  const confRows = await buildConferenceSelectRows(interaction.guildId!, "ap_gotw");
  if (confRows.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Linked Players").setDescription("No users are linked to a team in this guild.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )],
    });
    return;
  }

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ap_gotw_finalize").setLabel("Finalize Payouts").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2d6a4f)
      .setTitle("🏈 GOTW Correct Guess Payout")
      .setDescription(
        `**Week:** ${weekDisplay}\n**Bonus per user:** +${bonus} coins ${isPlayoff ? "(playoff)" : "(regular season)"}\n\n` +
        "Select the users who guessed GOTW correctly from the dropdowns below, then click **Finalize Payouts**."
      )],
    components: [...confRows, btnRow],
  });
}

export async function handleGotwSelectAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "gotw") { await interaction.deferUpdate(); return; }
  session.afcSelected = interaction.values;
  await interaction.deferUpdate();
}

export async function handleGotwSelectNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "gotw") { await interaction.deferUpdate(); return; }
  session.nfcSelected = interaction.values;
  await interaction.deferUpdate();
}

export async function handleGotwFinalize(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "gotw") { await interaction.deferUpdate(); return; }

  const recipientIds = [...new Set([...session.afcSelected, ...session.nfcSelected])];
  if (recipientIds.length === 0) {
    await interaction.reply({ content: "❌ No users selected.", ephemeral: true }); return;
  }

  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const currentWeek = (season as any).currentWeek ?? "1";
  const isPlayoff = ["wildcard","divisional","conference","superbowl"].includes(currentWeek);
  const bonus = await getPayoutValue(isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS, interaction.guildId!);
  const weekDisplay = weekLabel(currentWeek);

  const lines: string[] = [];
  for (const uid of recipientIds) {
    await addBalance(uid, bonus, interaction.guildId!);
    await logTransaction(uid, bonus, "addcoins", `GOTW correct guess bonus — ${weekDisplay}`, interaction.guildId!, interaction.user.id);
    lines.push(`✅ <@${uid}> → +**${bonus} coins**`);
    try {
      const u = await interaction.client.users.fetch(uid);
      await u.send(`🏈 **GOTW Correct Guess Bonus!** Your prediction for **${weekDisplay}**'s Game of the Week was correct!\n**+${bonus} coins** added.`).catch(() => {});
    } catch (_) {}
  }

  payoutSessions.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ GOTW Bonuses Issued")
      .addFields(
        { name: "Week", value: weekDisplay, inline: true },
        { name: "Bonus", value: `+${bonus} coins`, inline: true },
        { name: "Recipients", value: lines.slice(0, 20).join("\n") + (lines.length > 20 ? `\n…and ${lines.length - 20} more` : "") },
      )
      .setFooter({ text: `Issued by ${interaction.user.username}` })
      .setTimestamp()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back to Hub").setStyle(ButtonStyle.Secondary)
    )],
  });
}

// ── POTW Winners ──────────────────────────────────────────────────────────────
async function buildPotwMenu(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  selections: string[],
): Promise<void> {
  const season = await getOrCreateActiveSeason(guildId);
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);
  const bonus = await getPayoutValue(PAYOUT_KEYS.POTW_BONUS, guildId);

  const selectionText = selections.length === 0
    ? "*None yet — pick players from the dropdowns below.*"
    : selections.map((id, i) => `${i + 1}. <@${id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🌟 POTW Winners")
    .setDescription(
      `**Week:** ${weekDisplay} | **Bonus each:** +${bonus} coins\n\n` +
      "Pick **one player at a time** from the AFC or NFC dropdown. " +
      "Use **↩️ Remove Last** to undo. Finalize when done."
    )
    .addFields({ name: "Current Selections", value: selectionText.slice(0, 1024) });

  const confRows = await buildConferenceSelectRows(guildId, "ap_potw", [], [], 1);

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ap_potw_finalize").setLabel("✅ Finalize Payouts").setStyle(ButtonStyle.Success).setDisabled(selections.length === 0),
    new ButtonBuilder().setCustomId("ap_potw_back").setLabel("↩️ Remove Last").setStyle(ButtonStyle.Secondary).setDisabled(selections.length === 0),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [embed],
    components: [...confRows, btnRow],
  });
}

export async function handlePotw(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  const guildId = interaction.guildId!;
  const key = sessionKey(guildId, interaction.user.id);
  payoutSessions.set(key, { flow: "potw", afcSelected: [], nfcSelected: [], potwSelections: [] });
  await buildPotwMenu(interaction, guildId, []);
}

export async function handlePotwSelectAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "potw") { await interaction.deferUpdate(); return; }
  if (!session.potwSelections) session.potwSelections = [];
  const selected = interaction.values[0];
  if (selected) {
    const count = session.potwSelections.filter(id => id === selected).length;
    if (count >= 2) {
      await interaction.reply({ content: `⚠️ <@${selected}> has already been selected twice. Choose someone else or finalize.`, ephemeral: true });
      return;
    }
    session.potwSelections.push(selected);
  }
  await buildPotwMenu(interaction, interaction.guildId!, session.potwSelections);
}

export async function handlePotwSelectNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "potw") { await interaction.deferUpdate(); return; }
  if (!session.potwSelections) session.potwSelections = [];
  const selected = interaction.values[0];
  if (selected) {
    const count = session.potwSelections.filter(id => id === selected).length;
    if (count >= 2) {
      await interaction.reply({ content: `⚠️ <@${selected}> has already been selected twice. Choose someone else or finalize.`, ephemeral: true });
      return;
    }
    session.potwSelections.push(selected);
  }
  await buildPotwMenu(interaction, interaction.guildId!, session.potwSelections);
}

export async function handlePotwBack(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "potw") { await interaction.deferUpdate(); return; }
  if (!session.potwSelections) session.potwSelections = [];
  session.potwSelections.pop();
  await buildPotwMenu(interaction, interaction.guildId!, session.potwSelections);
}

export async function handlePotwFinalize(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "potw") { await interaction.deferUpdate(); return; }
  const selections = session.potwSelections ?? [];
  if (selections.length === 0) {
    await interaction.reply({ content: "❌ No players selected.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const bonus = await getPayoutValue(PAYOUT_KEYS.POTW_BONUS, guildId);
  const season = await getOrCreateActiveSeason(guildId);
  const weekDisplay = weekLabel((season as any).currentWeek ?? "1");

  const lines: string[] = [];
  for (const uid of selections) {
    const discordUser = await interaction.client.users.fetch(uid).catch(() => null);
    if (!discordUser) { lines.push(`⚠️ Could not find user \`${uid}\``); continue; }
    await getOrCreateUser(uid, discordUser.username, guildId);
    await addBalance(uid, bonus, guildId);
    await logTransaction(uid, bonus, "addcoins", `Player of the Week bonus — ${weekDisplay}`, guildId, interaction.user.id);
    lines.push(`✅ <@${uid}> → +**${bonus} coins**`);
    await discordUser.send(`🌟 You've been named **Player of the Week** for ${weekDisplay}!\n**+${bonus} coins** added to your balance. Keep balling out! 🏈`).catch(() => {});
  }

  payoutSessions.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🌟 POTW Bonuses Issued")
      .addFields(
        { name: "Week", value: weekDisplay, inline: true },
        { name: "Bonus Each", value: `+${bonus} coins`, inline: true },
        { name: "Recipients", value: lines.join("\n") || "None" },
      )
      .setFooter({ text: `Issued by ${interaction.user.username}` })
      .setTimestamp()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back to Hub").setStyle(ButtonStyle.Secondary)
    )],
  });
}

export async function handlePotwModal(_interaction: ModalSubmitInteraction): Promise<void> {
  await _interaction.reply({ content: "❌ This flow is no longer used.", ephemeral: true });
}

// ── Add/Remove Coins (shared flow) ─────────────────────────────────────────────
async function handleCoinFlow(interaction: ButtonInteraction, flow: "addcoins" | "removecoins"): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  payoutSessions.set(key, { flow, afcSelected: [], nfcSelected: [] });

  const confRows = await buildConferenceSelectRows(interaction.guildId!, `ap_${flow}`);
  const isDeduct = flow === "removecoins";

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ap_${flow}_next`).setLabel("Next →").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(isDeduct ? Colors.Red : Colors.Green)
      .setTitle(isDeduct ? "💸 Deduct Coins" : "💰 Issue One-Time Payout")
      .setDescription(
        "Select up to 16 users from each conference dropdown below, then click **Next** to enter the amount and reason.\n\n" +
        (isDeduct ? "⚠️ The coin amount will be **deducted** from the selected users." : "Selected users will each receive the specified amount.")
      )],
    components: confRows.length > 0 ? [...confRows, btnRow] : [btnRow],
  });
}

export async function handleAddCoins(interaction: ButtonInteraction): Promise<void> {
  await handleCoinFlow(interaction, "addcoins");
}

export async function handleRemoveCoins(interaction: ButtonInteraction): Promise<void> {
  await handleCoinFlow(interaction, "removecoins");
}

export async function handleAddCoinsSelectAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.deferUpdate(); return; }
  s.afcSelected = interaction.values;
  await interaction.deferUpdate();
}
export async function handleAddCoinsSelectNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.deferUpdate(); return; }
  s.nfcSelected = interaction.values;
  await interaction.deferUpdate();
}
export const handleRemoveCoinsSelectAfc = handleAddCoinsSelectAfc;
export const handleRemoveCoinsSelectNfc = handleAddCoinsSelectNfc;

async function showCoinModal(interaction: ButtonInteraction, flow: "addcoins" | "removecoins"): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  const totalSelected = (s?.afcSelected.length ?? 0) + (s?.nfcSelected.length ?? 0);
  if (totalSelected === 0) {
    await interaction.reply({ content: "❌ Select at least one user first.", ephemeral: true }); return;
  }
  const isDeduct = flow === "removecoins";
  const modal = new ModalBuilder()
    .setCustomId(`ap_modal_${flow}`)
    .setTitle(isDeduct ? "Deduct Coins" : "Issue One-Time Payout");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("Amount (coins per user)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6)
        .setPlaceholder("e.g. 100")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(150)
    ),
  );
  await interaction.showModal(modal);
}

export async function handleAddCoinsNext(interaction: ButtonInteraction): Promise<void> {
  await showCoinModal(interaction, "addcoins");
}
export async function handleRemoveCoinsNext(interaction: ButtonInteraction): Promise<void> {
  await showCoinModal(interaction, "removecoins");
}

async function executeCoinModal(interaction: ModalSubmitInteraction, flow: "addcoins" | "removecoins"): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session) { await interaction.editReply({ content: "❌ Session expired. Run `/admin-payout` again." }); return; }

  const rawAmount = interaction.fields.getTextInputValue("amount");
  const reason    = interaction.fields.getTextInputValue("reason").trim() || undefined;
  const amount    = parseInt(rawAmount, 10);
  if (isNaN(amount) || amount <= 0) { await interaction.editReply({ content: "❌ Invalid amount. Enter a positive integer." }); return; }

  const isDeduct = flow === "removecoins";
  const ids = [...new Set([...session.afcSelected, ...session.nfcSelected])];

  const lines: string[] = [];
  for (const uid of ids) {
    const discordUser = await interaction.client.users.fetch(uid).catch(() => null);
    if (!discordUser) { lines.push(`⚠️ Could not fetch <@${uid}>`); continue; }
    await getOrCreateUser(uid, discordUser.username, interaction.guildId!);

    if (isDeduct) {
      await db.update(usersTable)
        .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${amount})`, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, uid), eq(usersTable.guildId, interaction.guildId!)));
      await logTransaction(uid, -amount, "removecoins", reason ? `Commissioner deducted — ${reason}` : "Commissioner deducted coins", interaction.guildId!, interaction.user.id);
      lines.push(`✅ <@${uid}> → −**${amount} coins**`);
    } else {
      await addBalance(uid, amount, interaction.guildId!);
      await logTransaction(uid, amount, "addcoins", reason ? `Commissioner bonus — ${reason}` : "Commissioner added coins", interaction.guildId!, interaction.user.id);
      lines.push(`✅ <@${uid}> → +**${amount} coins**`);
      await discordUser.send(`🪙 A commissioner added **${amount.toLocaleString()} coins** to your balance!${reason ? `\nReason: *${reason}*` : ""}`).catch(() => {});
    }
  }

  payoutSessions.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(isDeduct ? Colors.Orange : Colors.Green)
      .setTitle(isDeduct ? `💸 Coins Deducted — ${ids.length} user(s)` : `✅ Coins Added — ${ids.length} user(s)`)
      .setDescription(lines.slice(0, 25).join("\n") + (lines.length > 25 ? `\n…and ${lines.length - 25} more` : ""))
      .addFields({ name: "Amount each", value: `${amount} coins`, inline: true }, { name: "Issued by", value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp()],
  });
}

export async function handleAddCoinsModal(interaction: ModalSubmitInteraction): Promise<void> {
  await executeCoinModal(interaction, "addcoins");
}
export async function handleRemoveCoinsModal(interaction: ModalSubmitInteraction): Promise<void> {
  await executeCoinModal(interaction, "removecoins");
}

// ── Transfer Coins ────────────────────────────────────────────────────────────
export async function handleTransfer(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  payoutSessions.set(key, { flow: "transfer", afcSelected: [], nfcSelected: [] });

  const confRows = await buildConferenceSelectRows(interaction.guildId!, "ap_transfer", [], [], 2);
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ap_transfer_next").setLabel("Next →").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("💱 Transfer Coins")
      .setDescription(
        "Select exactly **2 users** — **1st selected** = sender (loses coins), **2nd selected** = receiver (gains coins).\n" +
        "You may select from either conference. Maximum 2 users total."
      )],
    components: confRows.length > 0 ? [...confRows, btnRow] : [btnRow],
  });
}

export async function handleTransferSelectAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.deferUpdate(); return; }
  s.afcSelected = interaction.values.slice(0, 2);
  await interaction.deferUpdate();
}

export async function handleTransferSelectNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.deferUpdate(); return; }
  s.nfcSelected = interaction.values.slice(0, 2);
  await interaction.deferUpdate();
}

export async function handleTransferNext(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  const combined = [...(s?.afcSelected ?? []), ...(s?.nfcSelected ?? [])];
  if (combined.length < 2) {
    await interaction.reply({ content: "❌ Select exactly 2 users (sender and receiver).", ephemeral: true }); return;
  }
  const modal = new ModalBuilder()
    .setCustomId("ap_modal_transfer")
    .setTitle("Transfer Coins");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("Amount to transfer (coins)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6)
        .setPlaceholder("e.g. 100")
    ),
  );
  await interaction.showModal(modal);
}

export async function handleTransferModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const combined = [...session.afcSelected, ...session.nfcSelected];
  if (combined.length < 2) { await interaction.editReply({ content: "❌ Need exactly 2 users." }); return; }

  const senderId   = combined[0]!;
  const receiverId = combined[1]!;
  const amount     = parseInt(interaction.fields.getTextInputValue("amount"), 10);
  if (isNaN(amount) || amount <= 0) { await interaction.editReply({ content: "❌ Invalid amount." }); return; }

  await db.update(usersTable)
    .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${amount})`, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, senderId), eq(usersTable.guildId, interaction.guildId!)));
  await logTransaction(senderId, -amount, "removecoins", `Commissioner transfer to <@${receiverId}>`, interaction.guildId!, interaction.user.id);

  await addBalance(receiverId, amount, interaction.guildId!);
  await logTransaction(receiverId, amount, "addcoins", `Commissioner transfer from <@${senderId}>`, interaction.guildId!, interaction.user.id);

  payoutSessions.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("✅ Transfer Complete")
      .addFields(
        { name: "Sender", value: `<@${senderId}>`, inline: true },
        { name: "Receiver", value: `<@${receiverId}>`, inline: true },
        { name: "Amount", value: `${amount} coins`, inline: true },
      )
      .setFooter({ text: `By ${interaction.user.username}` })
      .setTimestamp()],
  });
}

// ── Playoff weekIndex helpers ─────────────────────────────────────────────────
const PLAYOFF_WEEK_IDX: Record<string, number> = {
  wildcard: 1018, divisional: 1019, conference: 1020, superbowl: 1022,
};
const PLAYOFF_LABELS_MAP: Record<number, string> = {
  1018: "Wild Card", 1019: "Divisional", 1020: "Conference Championship", 1022: "Super Bowl",
};
function resolveWeekIndex(currentWeek: string): number {
  const po = PLAYOFF_WEEK_IDX[currentWeek.toLowerCase()];
  if (po !== undefined) return po;
  const n = parseInt(currentWeek, 10);
  return isNaN(n) ? 0 : n - 1;
}
function weekIndexLabel(idx: number): string {
  return PLAYOFF_LABELS_MAP[idx] ?? `Week ${idx + 1}`;
}

// ── Issue Game Payout ─────────────────────────────────────────────────────────
export async function handleGame(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const currentWeek = String((season as any).currentWeek ?? "1");
  const weekIdx = resolveWeekIndex(currentWeek);

  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      eq(franchiseScheduleTable.weekIndex, weekIdx),
    ));

  if (games.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Matchups Found").setDescription(`No scheduled games for Week ${currentWeek}. Run \`/franchiseupdate\` first.`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )],
    });
    return;
  }

  const rosterSeasonId = await getRosterSeasonId(guildId);
  const mcaTeams = await db.select({
    fullName: franchiseMcaTeamsTable.fullName,
    nickName: franchiseMcaTeamsTable.nickName,
    discordId: franchiseMcaTeamsTable.discordId,
  }).from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, rosterSeasonId)));

  const teamToDiscord = new Map<string, string | null>();
  for (const t of mcaTeams) {
    teamToDiscord.set(t.fullName.toLowerCase().trim(), t.discordId ?? null);
    teamToDiscord.set(t.nickName.toLowerCase().trim(), t.discordId ?? null);
  }

  const key = sessionKey(guildId, interaction.user.id);
  const gameOpts: GameOption[] = games.slice(0, 25).map(g => {
    const homeLabel = g.homeTeamName ?? "Home";
    const awayLabel = g.awayTeamName ?? "Away";
    return {
      home: homeLabel,
      away: awayLabel,
      homeDiscord: teamToDiscord.get(homeLabel.toLowerCase()) ?? null,
      awayDiscord: teamToDiscord.get(awayLabel.toLowerCase()) ?? null,
    };
  });
  payoutSessions.set(key, { flow: "game", afcSelected: [], nfcSelected: [], gameOptions: gameOpts });

  const options = gameOpts.map((g, i) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${g.away} @ ${g.home}`.slice(0, 100))
      .setValue(String(i))
  );

  const wkDisplay = weekIndexLabel(weekIdx);
  const select = new StringSelectMenuBuilder()
    .setCustomId("ap_game_select")
    .setPlaceholder(`${wkDisplay} matchups — pick one`)
    .setMinValues(1).setMaxValues(1)
    .addOptions(options);

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2d6a4f)
      .setTitle("🏈 Issue Game Payout")
      .setDescription(`Select the **${wkDisplay}** matchup to issue a payout for.`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      ),
    ],
  });
}

export async function handleGameSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "game") { await interaction.deferUpdate(); return; }

  const idx = parseInt(interaction.values[0]!, 10);
  const matchup = session.gameOptions?.[idx];
  if (!matchup) { await interaction.deferUpdate(); return; }

  session.homeTeam      = matchup.home;
  session.awayTeam      = matchup.away;
  session.homeDiscordId = matchup.homeDiscord ?? undefined;
  session.awayDiscordId = matchup.awayDiscord ?? undefined;
  session.isCpu         = !matchup.awayDiscord;

  const homeTag = matchup.homeDiscord ? `<@${matchup.homeDiscord}> (${matchup.home})` : matchup.home;
  const awayTag = matchup.awayDiscord ? `<@${matchup.awayDiscord}> (${matchup.away})` : matchup.away;

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(matchup.homeDiscord
      ? [new ButtonBuilder().setCustomId("ap_game_winner_home").setLabel(`🏆 ${matchup.home} Won`).setStyle(ButtonStyle.Primary)]
      : []
    ),
    ...(matchup.awayDiscord
      ? [new ButtonBuilder().setCustomId("ap_game_winner_away").setLabel(`🏆 ${matchup.away} Won`).setStyle(ButtonStyle.Primary)]
      : []
    ),
    ...((!matchup.homeDiscord || !matchup.awayDiscord)
      ? [new ButtonBuilder().setCustomId("ap_game_winner_cpu").setLabel("CPU Win").setStyle(ButtonStyle.Secondary)]
      : []
    ),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2d6a4f)
      .setTitle("🏈 Select the Winner")
      .addFields(
        { name: "Away Team", value: awayTag, inline: true },
        { name: "Home Team", value: homeTag, inline: true },
      )
      .setDescription("Click the button for the team that **won** this game.")],
    components: [btnRow],
  });
}

async function showGameDiffModal(interaction: ButtonInteraction, modalId: string, title: string): Promise<void> {
  const modal = new ModalBuilder().setCustomId(modalId).setTitle(title);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("home_score")
        .setLabel("Home team score")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3)
        .setPlaceholder("e.g. 28")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("away_score")
        .setLabel("Away team score")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3)
        .setPlaceholder("e.g. 21")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("game_type")
        .setLabel("Game type (regular_season / playoff / superbowl)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("regular_season")
        .setMaxLength(20)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Notes (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(150)
    ),
  );
  await interaction.showModal(modal);
}

export async function handleGameWinnerHome(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return; }
  s.homeDiscordId = s.homeDiscordId; // winner is home
  await showGameDiffModal(interaction, "ap_modal_game_home_wins", `${s.homeTeam} Won — Enter Scores`);
}

export async function handleGameWinnerAway(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return; }
  s.isCpu = false; // away discord is winner
  await showGameDiffModal(interaction, "ap_modal_game_away_wins", `${s.awayTeam} Won — Enter Scores`);
}

export async function handleGameWinnerCpu(interaction: ButtonInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const s = payoutSessions.get(key);
  if (!s) { await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return; }
  s.isCpu = true;
  await showGameDiffModal(interaction, "ap_modal_game_cpu_wins", `CPU Win — Enter Scores`);
}

async function executeGameModal(
  interaction: ModalSubmitInteraction,
  homeWins: boolean,
  isCpu: boolean,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const homeScore = parseInt(interaction.fields.getTextInputValue("home_score"), 10);
  const awayScore = parseInt(interaction.fields.getTextInputValue("away_score"), 10);
  const rawType   = interaction.fields.getTextInputValue("game_type").trim() || "regular_season";
  const notes     = interaction.fields.getTextInputValue("notes").trim() || "";
  const gameType  = (["regular_season","playoff","superbowl"].includes(rawType) ? rawType : "regular_season") as "regular_season"|"playoff"|"superbowl";

  if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
    await interaction.editReply({ content: "❌ Invalid scores entered." }); return;
  }

  const guildId    = interaction.guildId!;
  const season     = await getOrCreateActiveSeason(guildId);
  const isPlayoff  = gameType !== "regular_season";

  const [H2H_WIN, H2H_LOSS, CPU_WIN, PO_H2H_WIN, PO_H2H_LOSS, PO_CPU_WIN] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.H2H_WIN,         guildId),
    getPayoutValue(PAYOUT_KEYS.H2H_LOSS,        guildId),
    getPayoutValue(PAYOUT_KEYS.CPU_WIN,         guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_WIN, guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_LOSS,guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_CPU_WIN, guildId),
  ]);

  const H2H_WIN_AMT  = isPlayoff ? PO_H2H_WIN  : H2H_WIN;
  const H2H_LOSS_AMT = isPlayoff ? PO_H2H_LOSS : H2H_LOSS;
  const CPU_WIN_AMT  = isPlayoff ? PO_CPU_WIN  : CPU_WIN;

  const homeDiscordId = session.homeDiscordId;
  const awayDiscordId = session.awayDiscordId;

  // Resolve home/away users
  const [homeUserRow] = homeDiscordId
    ? await db.select().from(usersTable).where(and(eq(usersTable.discordId, homeDiscordId), eq(usersTable.guildId, guildId))).limit(1)
    : [null];
  const [awayUserRow] = awayDiscordId
    ? await db.select().from(usersTable).where(and(eq(usersTable.discordId, awayDiscordId), eq(usersTable.guildId, guildId))).limit(1)
    : [null];

  if (!homeUserRow && !isCpu) {
    await interaction.editReply({ content: "❌ Home user not found in DB. Use `/admin-linkteam set` first." }); return;
  }

  const resultLines: string[] = [];
  const notesLine = notes ? `\nNotes: *${notes}*` : "";

  await db.transaction(async (tx) => {
    if (isCpu) {
      // CPU win — the user with a discord ID is the winner
      const winnerId = homeDiscordId ?? awayDiscordId!;
      const winnerRow = homeDiscordId ? homeUserRow : awayUserRow;
      if (!winnerRow) return;
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${CPU_WIN_AMT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, winnerId));
      await tx.insert(coinTransactionsTable).values({
        discordId: winnerId, amount: CPU_WIN_AMT, type: "addcoins",
        description: `[ManualScore] CPU win (${homeScore}–${awayScore})`,
      });
      await tx.insert(gameLogTable).values({
        discordId: winnerId, seasonId: season.id, result: "win",
        pointSpread: Math.abs(homeScore - awayScore), opponentLabel: "[CPU]", gameType,
      });
      resultLines.push(`✅ **${winnerRow.team ?? winnerId}** beats CPU **${homeScore}–${awayScore}**`);
      resultLines.push(`💰 +${CPU_WIN_AMT} coins → <@${winnerId}>`);

    } else if (!isCpu && homeDiscordId && awayDiscordId) {
      // H2H
      const winnerId   = homeWins ? homeDiscordId : awayDiscordId;
      const loserId    = homeWins ? awayDiscordId  : homeDiscordId;
      const winnerRow  = homeWins ? homeUserRow  : awayUserRow;
      const loserRow   = homeWins ? awayUserRow  : homeUserRow;
      const pointDiff  = Math.abs(homeScore - awayScore);
      const isTie      = homeScore === awayScore;

      if (!winnerRow || !loserRow) { resultLines.push("⚠️ One or both users not found in DB."); return; }

      if (isTie) {
        for (const [uid, uname, team] of [[winnerId, winnerRow.discordUsername, winnerRow.team], [loserId, loserRow.discordUsername, loserRow.team]] as [string, string, string | null][]) {
          await tx.insert(userRecordsTable).values({
            discordId: uid, discordUsername: uname, team, seasonId: season.id,
            wins: 0, losses: 0, ties: 1, pointDifferential: 0,
          }).onConflictDoUpdate({
            target: [userRecordsTable.discordId, userRecordsTable.seasonId],
            set: { ties: sql`${userRecordsTable.ties} + 1`, updatedAt: new Date() },
          });
          await tx.insert(gameLogTable).values({
            discordId: uid, seasonId: season.id, result: "tie", pointSpread: 0, opponentLabel: team ?? uid, gameType,
          });
        }
        resultLines.push(`🤝 TIE **${homeScore}–${awayScore}** — no coins awarded`);
      } else {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} + ${H2H_WIN_AMT}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, winnerId));
        await tx.insert(coinTransactionsTable).values({
          discordId: winnerId, amount: H2H_WIN_AMT, type: "addcoins",
          description: `[ManualScore] H2H win vs ${loserRow.team ?? "?"} (${homeScore}–${awayScore})`,
        });
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} + ${H2H_LOSS_AMT}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, loserId));
        await tx.insert(coinTransactionsTable).values({
          discordId: loserId, amount: H2H_LOSS_AMT, type: "addcoins",
          description: `[ManualScore] H2H loss vs ${winnerRow.team ?? "?"} (${homeScore}–${awayScore})`,
        });

        await tx.insert(userRecordsTable).values({
          discordId: winnerId, discordUsername: winnerRow.discordUsername, team: winnerRow.team ?? null, seasonId: season.id,
          wins: 1, losses: 0, ties: 0, pointDifferential: pointDiff,
        }).onConflictDoUpdate({
          target: [userRecordsTable.discordId, userRecordsTable.seasonId],
          set: { wins: sql`${userRecordsTable.wins} + 1`, pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointDiff}`, updatedAt: new Date() },
        });
        await tx.insert(userRecordsTable).values({
          discordId: loserId, discordUsername: loserRow.discordUsername, team: loserRow.team ?? null, seasonId: season.id,
          wins: 0, losses: 1, ties: 0, pointDifferential: -pointDiff,
        }).onConflictDoUpdate({
          target: [userRecordsTable.discordId, userRecordsTable.seasonId],
          set: { losses: sql`${userRecordsTable.losses} + 1`, pointDifferential: sql`${userRecordsTable.pointDifferential} - ${pointDiff}`, updatedAt: new Date() },
        });

        await tx.update(usersTable).set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() }).where(and(eq(usersTable.discordId, winnerId), eq(usersTable.guildId, guildId)));
        await tx.update(usersTable).set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() }).where(and(eq(usersTable.discordId, loserId),  eq(usersTable.guildId, guildId)));

        const [id1, id2] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
        const winnerIsId1 = winnerId === id1;
        await tx.insert(h2hMatchupRecordsTable)
          .values({ discordId1: id1, discordId2: id2, wins1: winnerIsId1 ? 1 : 0, wins2: winnerIsId1 ? 0 : 1 })
          .onConflictDoUpdate({
            target: [h2hMatchupRecordsTable.discordId1, h2hMatchupRecordsTable.discordId2],
            set: winnerIsId1
              ? { wins1: sql`${h2hMatchupRecordsTable.wins1} + 1`, updatedAt: new Date() }
              : { wins2: sql`${h2hMatchupRecordsTable.wins2} + 1`, updatedAt: new Date() },
          });

        await tx.insert(gameLogTable).values({ discordId: winnerId, seasonId: season.id, result: "win", pointSpread: pointDiff, opponentLabel: loserRow.team ?? loserRow.discordUsername, opponentDiscordId: loserId, gameType });
        await tx.insert(gameLogTable).values({ discordId: loserId, seasonId: season.id, result: "loss", pointSpread: -pointDiff, opponentLabel: winnerRow.team ?? winnerRow.discordUsername, opponentDiscordId: winnerId, gameType });

        resultLines.push(`🏆 **${winnerRow.team ?? "?"}** defeats **${loserRow.team ?? "?"}** **${Math.max(homeScore, awayScore)}–${Math.min(homeScore, awayScore)}**`);
        resultLines.push(`💰 +${H2H_WIN_AMT} → <@${winnerId}> | +${H2H_LOSS_AMT} → <@${loserId}>`);

        // Milestone check
        if (!isTie) {
          const [winnerUpdated] = await db.select({ allTimeH2HWins: usersTable.allTimeH2HWins, milestoneTierAwarded: usersTable.milestoneTierAwarded })
            .from(usersTable).where(and(eq(usersTable.discordId, winnerId), eq(usersTable.guildId, guildId))).limit(1);
          const currentWins = winnerUpdated?.allTimeH2HWins ?? 0;
          const currentTier = winnerUpdated?.milestoneTierAwarded ?? 0;
          const milestones  = await getMilestoneTiers(guildId);
          const owed = milestones.filter(m => currentWins >= m.wins && currentTier < m.tier).sort((a, b) => a.tier - b.tier);
          let newTier = currentTier;
          for (const m of owed) {
            await addBalance(winnerId, m.bonus, guildId);
            await logTransaction(winnerId, m.bonus, "addcoins", `Career milestone: Tier ${m.tier} (${m.wins} wins)`, guildId);
            resultLines.push(`🎯 **Career Milestone Tier ${m.tier}** (${m.wins} wins): +${m.bonus} coins!`);
            newTier = m.tier;
          }
          if (newTier !== currentTier) {
            await db.update(usersTable).set({ milestoneTierAwarded: newTier, updatedAt: new Date() }).where(and(eq(usersTable.discordId, winnerId), eq(usersTable.guildId, guildId)));
          }
        }

        // Global records
        if (!isTie) {
          await upsertGlobalRecord(winnerId, "win",  pointDiff);
          await upsertGlobalRecord(loserId,  "loss", -pointDiff);
        } else {
          await upsertGlobalRecord(winnerId, "tie", 0);
          await upsertGlobalRecord(loserId,  "tie", 0);
        }
      }
    }
  });

  payoutSessions.delete(key);
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 Game Payout Issued")
    .setDescription((resultLines.join("\n") || "Complete") + notesLine)
    .setFooter({ text: `By ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Commissioner log
  const commId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER)
    ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";
  if (commId) {
    const ch = await interaction.client.channels.fetch(commId).catch(() => null);
    if (ch?.isTextBased()) {
      await (ch as TextChannel).send({ embeds: [new EmbedBuilder()
        .setColor(Colors.Orange).setTitle("📋 Manual Game Payout (admin-payout hub)")
        .setDescription(resultLines.join("\n") + notesLine)
        .setFooter({ text: `By ${interaction.user.username} (${interaction.user.id})` })
        .setTimestamp()] }).catch(() => {});
    }
  }
}

export async function handleGameModalHomeWins(interaction: ModalSubmitInteraction): Promise<void> {
  await executeGameModal(interaction, true, false);
}
export async function handleGameModalAwayWins(interaction: ModalSubmitInteraction): Promise<void> {
  await executeGameModal(interaction, false, false);
}
export async function handleGameModalCpuWins(interaction: ModalSubmitInteraction): Promise<void> {
  await executeGameModal(interaction, true, true);
}

// ── Correct Game Payout ────────────────────────────────────────────────────────
const NULL_WEEK_SENTINEL = -999;

export async function handleCorrect(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const processedGames = await db.select({
    weekIndexRef: franchiseProcessedGamesTable.weekIndexRef,
  }).from(franchiseProcessedGamesTable)
    .where(eq(franchiseProcessedGamesTable.seasonIdRef, season.id));

  const weekSet = new Set<number>();
  for (const g of processedGames) {
    weekSet.add(g.weekIndexRef ?? NULL_WEEK_SENTINEL);
  }
  const weekIndices = [...weekSet].sort((a, b) => a - b);

  if (weekIndices.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Processed Games").setDescription("No processed game records found for this season.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )],
    });
    return;
  }

  function wkLabel(idx: number): string {
    if (idx === NULL_WEEK_SENTINEL) return "Unknown / Pre-Hub Games";
    return PLAYOFF_LABELS_MAP[idx] ?? `Week ${idx + 1}`;
  }

  const key = sessionKey(guildId, interaction.user.id);
  payoutSessions.set(key, { flow: "correct", afcSelected: [], nfcSelected: [] });

  const select = new StringSelectMenuBuilder()
    .setCustomId("ap_correct_week")
    .setPlaceholder("Select a week to correct")
    .setMinValues(1).setMaxValues(1)
    .addOptions(weekIndices.slice(0, 25).map(idx =>
      new StringSelectMenuOptionBuilder().setLabel(wkLabel(idx)).setValue(String(idx))
    ));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setTitle("↩️ Correct Game Payout").setDescription("Select the **week** containing the game you want to correct.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      ),
    ],
  });
}

export async function handleCorrectWeekSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "correct") { await interaction.deferUpdate(); return; }

  const weekIndex = parseInt(interaction.values[0]!, 10);
  session.selectedWeekIndex = weekIndex;

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const whereClause = weekIndex === NULL_WEEK_SENTINEL
    ? and(eq(franchiseProcessedGamesTable.seasonIdRef, season.id), isNull(franchiseProcessedGamesTable.weekIndexRef))
    : and(eq(franchiseProcessedGamesTable.seasonIdRef, season.id), eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex));

  const games = await db.select().from(franchiseProcessedGamesTable).where(whereClause);

  if (games.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Games Found").setDescription("No games found for this week.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )],
    });
    return;
  }

  function wkLabel(idx: number): string {
    if (idx === NULL_WEEK_SENTINEL) return "Unknown / Pre-Hub";
    return PLAYOFF_LABELS_MAP[idx] ?? `Week ${idx + 1}`;
  }

  const gameMap: Record<string, { gameId: string; winnerId: string | null; loserId: string | null; homeTeam: string | null; awayTeam: string | null }> = {};
  const options = games.slice(0, 25).map((g, i) => {
    const shortKey = String(i);
    gameMap[shortKey] = {
      gameId: g.gameId,
      winnerId: g.winnerDiscordId,
      loserId: g.loserDiscordId,
      homeTeam: g.homeTeamRef,
      awayTeam: g.awayTeamRef,
    };
    const label = g.homeTeamRef && g.awayTeamRef
      ? `${g.awayTeamRef} @ ${g.homeTeamRef}`
      : g.gameId.slice(0, 80);
    return new StringSelectMenuOptionBuilder().setLabel(label.slice(0, 100)).setValue(shortKey);
  });
  session.correctGameOptions = gameMap;

  const select = new StringSelectMenuBuilder()
    .setCustomId("ap_correct_game")
    .setPlaceholder(`${wkLabel(weekIndex)} games — pick one`)
    .setMinValues(1).setMaxValues(1)
    .addOptions(options);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setTitle("↩️ Correct Game Payout").setDescription(`Select the **${wkLabel(weekIndex)}** game to correct.`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
      ),
    ],
  });
}

export async function handleCorrectGameSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session || session.flow !== "correct") { await interaction.deferUpdate(); return; }

  const shortKey = interaction.values[0]!;
  const data = session.correctGameOptions?.[shortKey];
  if (!data) { await interaction.deferUpdate(); return; }

  session.selectedGameId  = data.gameId;
  session.currentWinnerId = data.winnerId ?? undefined;
  session.currentLoserId  = data.loserId  ?? undefined;
  session.homeTeam        = data.homeTeam ?? undefined;
  session.awayTeam        = data.awayTeam ?? undefined;

  const winnerMention = data.winnerId ? `<@${data.winnerId}>` : "CPU";
  const loserMention  = data.loserId  ? `<@${data.loserId}>`  : "CPU";
  const awayLabel     = data.awayTeam ?? "Away";
  const homeLabel     = data.homeTeam ?? "Home";

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(data.winnerId ? [new ButtonBuilder().setCustomId("ap_correct_new_winner").setLabel(`✅ Confirm: ${winnerMention} Still Won`).setStyle(ButtonStyle.Secondary)] : []),
    ...(data.loserId  ? [new ButtonBuilder().setCustomId("ap_correct_swap").setLabel(`↩️ Swap: ${loserMention} Actually Won`).setStyle(ButtonStyle.Primary)] : []),
    new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("↩️ Correct This Game")
      .addFields(
        { name: "Away", value: `${awayLabel}${data.loserId && data.loserId !== data.winnerId ? ` (${loserMention})` : ""}`, inline: true },
        { name: "Home", value: `${homeLabel}${data.winnerId ? ` (${winnerMention})` : ""}`, inline: true },
        { name: "Recorded Winner", value: winnerMention, inline: false },
      )
      .setDescription("Choose: **Confirm** (reverse & re-issue same result) or **Swap** (reverse & re-issue with winner/loser swapped).")],
    components: [btnRow],
  });
}

async function showCorrectModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("ap_modal_correct_" + (interaction.customId === "ap_correct_swap" ? "swap" : "same")).setTitle("Correct Game");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("home_score").setLabel("Correct home score").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("away_score").setLabel("Correct away score").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for correction").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
    ),
  );
  await interaction.showModal(modal);
}

export async function handleCorrectNewWinner(interaction: ButtonInteraction): Promise<void> {
  await showCorrectModal(interaction);
}
export async function handleCorrectSwap(interaction: ButtonInteraction): Promise<void> {
  await showCorrectModal(interaction);
}

export async function handleCorrectModal(interaction: ModalSubmitInteraction, swap: boolean): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const key = sessionKey(interaction.guildId!, interaction.user.id);
  const session = payoutSessions.get(key);
  if (!session?.selectedGameId) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const homeScore = parseInt(interaction.fields.getTextInputValue("home_score"), 10);
  const awayScore = parseInt(interaction.fields.getTextInputValue("away_score"), 10);
  const reason    = interaction.fields.getTextInputValue("reason");

  if (isNaN(homeScore) || isNaN(awayScore)) { await interaction.editReply({ content: "❌ Invalid scores." }); return; }

  const guildId  = interaction.guildId!;
  const season   = await getOrCreateActiveSeason(guildId);
  const weekIndex = session.selectedWeekIndex ?? 0;

  // Load the processed game
  const [record] = await db.select().from(franchiseProcessedGamesTable)
    .where(eq(franchiseProcessedGamesTable.gameId, session.selectedGameId)).limit(1);

  if (!record) { await interaction.editReply({ content: "❌ Game record not found." }); return; }

  const PLAYOFF_LABELS: Record<number, string> = { 1018: "Wild Card", 1019: "Divisional", 1020: "Conference Championship", 1022: "Super Bowl" };
  function wkLabel(idx: number): string { return PLAYOFF_LABELS[idx] ?? `Week ${idx + 1}`; }

  // 1. Reverse the existing record
  const actionLog: string[] = [];
  const winnerId  = record.winnerDiscordId;
  const loserId   = record.loserDiscordId;
  const pointDiff = record.appliedPointDiff ?? 0;
  const winCoins  = record.winnerCoins ?? 0;
  const loseCoins = record.loserCoins  ?? 0;
  const mBonus    = record.milestoneBonus;
  const mPrevTier = record.milestonePrevTier;

  if (winnerId && loserId) {
    // H2H reversal
    const [id1, id2] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
    const winnerIsId1 = winnerId === id1;
    await db.update(h2hMatchupRecordsTable).set({
      [winnerIsId1 ? "wins1" : "wins2"]: winnerIsId1
        ? sql`GREATEST(0, ${h2hMatchupRecordsTable.wins1} - 1)`
        : sql`GREATEST(0, ${h2hMatchupRecordsTable.wins2} - 1)`,
      updatedAt: new Date(),
    }).where(and(eq(h2hMatchupRecordsTable.discordId1, id1), eq(h2hMatchupRecordsTable.discordId2, id2)));

    await db.update(userRecordsTable).set({ wins: sql`GREATEST(0, ${userRecordsTable.wins} - 1)`, pointDifferential: sql`${userRecordsTable.pointDifferential} - ${pointDiff}`, updatedAt: new Date() }).where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
    await db.update(userRecordsTable).set({ losses: sql`GREATEST(0, ${userRecordsTable.losses} - 1)`, pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointDiff}`, updatedAt: new Date() }).where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
    await db.update(globalUserRecordsTable).set({ wins: sql`GREATEST(0, ${globalUserRecordsTable.wins} - 1)`, pointDifferential: sql`${globalUserRecordsTable.pointDifferential} - ${pointDiff}`, updatedAt: new Date() }).where(eq(globalUserRecordsTable.discordId, winnerId));
    await db.update(globalUserRecordsTable).set({ losses: sql`GREATEST(0, ${globalUserRecordsTable.losses} - 1)`, pointDifferential: sql`${globalUserRecordsTable.pointDifferential} + ${pointDiff}`, updatedAt: new Date() }).where(eq(globalUserRecordsTable.discordId, loserId));
    await db.update(usersTable).set({ allTimeH2HWins:   sql`GREATEST(0, ${usersTable.allTimeH2HWins}   - 1)`, updatedAt: new Date() }).where(eq(usersTable.discordId, winnerId));
    await db.update(usersTable).set({ allTimeH2HLosses: sql`GREATEST(0, ${usersTable.allTimeH2HLosses} - 1)`, updatedAt: new Date() }).where(eq(usersTable.discordId, loserId));
  }

  if (winCoins > 0 && winnerId) {
    await db.update(usersTable).set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${winCoins})`, updatedAt: new Date() }).where(eq(usersTable.discordId, winnerId));
    await logTransaction(winnerId, -winCoins, "removecoins", `Game correction reversal (${wkLabel(weekIndex)}) — ${reason}`, guildId);
  }
  if (loseCoins > 0 && loserId) {
    await db.update(usersTable).set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${loseCoins})`, updatedAt: new Date() }).where(eq(usersTable.discordId, loserId));
    await logTransaction(loserId, -loseCoins, "removecoins", `Game correction reversal (${wkLabel(weekIndex)}) — ${reason}`, guildId);
  }
  if (mBonus != null && mPrevTier != null && winnerId) {
    await db.update(usersTable).set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${mBonus})`, milestoneTierAwarded: mPrevTier, updatedAt: new Date() }).where(eq(usersTable.discordId, winnerId));
    await logTransaction(winnerId, -mBonus, "removecoins", `Milestone clawback — game correction`, guildId);
  }

  await db.delete(franchiseProcessedGamesTable).where(eq(franchiseProcessedGamesTable.gameId, record.gameId));
  actionLog.push(`✅ Old result reversed and record deleted`);

  // 2. Apply new result — determine actual winner/loser based on swap
  const actualWinnerId = swap ? loserId  : winnerId;
  const actualLoserId  = swap ? winnerId : loserId;
  const newPointDiff = Math.abs(homeScore - awayScore);
  const isPlayoff    = weekIndex >= 1018;
  const gameType = isPlayoff ? (weekIndex === 1022 ? "superbowl" : "playoff") : "regular_season";

  const [PO_H2H_WIN, PO_H2H_LOSS, H2H_WIN, H2H_LOSS] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_WIN,  guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_LOSS, guildId),
    getPayoutValue(PAYOUT_KEYS.H2H_WIN,           guildId),
    getPayoutValue(PAYOUT_KEYS.H2H_LOSS,          guildId),
  ]);
  const winAmt  = isPlayoff ? PO_H2H_WIN  : H2H_WIN;
  const lossAmt = isPlayoff ? PO_H2H_LOSS : H2H_LOSS;

  if (actualWinnerId && actualLoserId) {
    await addBalance(actualWinnerId, winAmt,  guildId);
    await addBalance(actualLoserId,  lossAmt, guildId);
    await logTransaction(actualWinnerId, winAmt,  "addcoins", `Corrected game result — ${wkLabel(weekIndex)}`, guildId, interaction.user.id);
    await logTransaction(actualLoserId,  lossAmt, "addcoins", `Corrected game result — ${wkLabel(weekIndex)}`, guildId, interaction.user.id);

    const [idA, idB] = actualWinnerId < actualLoserId ? [actualWinnerId, actualLoserId] : [actualLoserId, actualWinnerId];
    const winnerIsA  = actualWinnerId === idA;
    await db.insert(userRecordsTable).values({ discordId: actualWinnerId, discordUsername: "", team: null, seasonId: season.id, wins: 1, losses: 0, ties: 0, pointDifferential: newPointDiff })
      .onConflictDoUpdate({ target: [userRecordsTable.discordId, userRecordsTable.seasonId], set: { wins: sql`${userRecordsTable.wins} + 1`, pointDifferential: sql`${userRecordsTable.pointDifferential} + ${newPointDiff}`, updatedAt: new Date() } });
    await db.insert(userRecordsTable).values({ discordId: actualLoserId, discordUsername: "", team: null, seasonId: season.id, wins: 0, losses: 1, ties: 0, pointDifferential: -newPointDiff })
      .onConflictDoUpdate({ target: [userRecordsTable.discordId, userRecordsTable.seasonId], set: { losses: sql`${userRecordsTable.losses} + 1`, pointDifferential: sql`${userRecordsTable.pointDifferential} - ${newPointDiff}`, updatedAt: new Date() } });
    await db.update(usersTable).set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() }).where(and(eq(usersTable.discordId, actualWinnerId), eq(usersTable.guildId, guildId)));
    await db.update(usersTable).set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() }).where(and(eq(usersTable.discordId, actualLoserId),  eq(usersTable.guildId, guildId)));
    await db.insert(h2hMatchupRecordsTable).values({ discordId1: idA, discordId2: idB, wins1: winnerIsA ? 1 : 0, wins2: winnerIsA ? 0 : 1 })
      .onConflictDoUpdate({ target: [h2hMatchupRecordsTable.discordId1, h2hMatchupRecordsTable.discordId2], set: winnerIsA ? { wins1: sql`${h2hMatchupRecordsTable.wins1} + 1`, updatedAt: new Date() } : { wins2: sql`${h2hMatchupRecordsTable.wins2} + 1`, updatedAt: new Date() } });
    await db.insert(gameLogTable).values({ discordId: actualWinnerId, seasonId: season.id, result: "win",  pointSpread: newPointDiff,  opponentDiscordId: actualLoserId,  gameType });
    await db.insert(gameLogTable).values({ discordId: actualLoserId,  seasonId: season.id, result: "loss", pointSpread: -newPointDiff, opponentDiscordId: actualWinnerId, gameType });
    await upsertGlobalRecord(actualWinnerId, "win",  newPointDiff);
    await upsertGlobalRecord(actualLoserId,  "loss", -newPointDiff);
    actionLog.push(`✅ New result applied: <@${actualWinnerId}> wins (+${winAmt}) vs <@${actualLoserId}> (+${lossAmt})`);
  }

  payoutSessions.delete(key);
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`↩️ Game Corrected — ${wkLabel(weekIndex)}`)
    .setDescription(actionLog.join("\n"))
    .addFields({ name: "Reason", value: reason, inline: false })
    .setFooter({ text: `By ${interaction.user.username}` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });

  const commId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG) ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";
  if (commId) {
    const ch = await interaction.client.channels.fetch(commId).catch(() => null);
    if (ch?.isTextBased()) await (ch as TextChannel).send({ embeds: [embed] }).catch(() => {});
  }
}

export async function handleCorrectModalSame(interaction: ModalSubmitInteraction): Promise<void> {
  await handleCorrectModal(interaction, false);
}
export async function handleCorrectModalSwap(interaction: ModalSubmitInteraction): Promise<void> {
  await handleCorrectModal(interaction, true);
}

// ── Set Game Payouts ──────────────────────────────────────────────────────────
export async function handleSetPay(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("⚙️ Set Game Payouts")
      .setDescription(
        "Choose which payout set to configure.\n\n" +
        "• **Regular Season** — H2H win/loss, CPU win, Highlight payout/cap\n" +
        "• **Channel Payouts** — Stream payout per side\n" +
        "• **Playoffs Part 1** — H2H win/loss/CPU, Wild Card bonus, Divisional bonus\n" +
        "• **Playoffs Part 2** — Conference bonuses, Super Bowl bonuses, Playoff Highlight payout"
      )],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_setpay_reg").setLabel("Regular Season").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ap_setpay_channel").setLabel("Channel Payouts").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ap_setpay_po1_btn").setLabel("Playoffs Part 1").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ap_setpay_po2_btn").setLabel("Playoffs Part 2").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function handleSetPayReg(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const [h2hWin, h2hLoss, cpuWin, highlights, highlightCap] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.H2H_WIN, guildId),
    getPayoutValue(PAYOUT_KEYS.H2H_LOSS, guildId),
    getPayoutValue(PAYOUT_KEYS.CPU_WIN, guildId),
    getPayoutValue(PAYOUT_KEYS.HIGHLIGHT_PAYOUT, guildId),
    getPayoutValue(PAYOUT_KEYS.HIGHLIGHT_LIMIT, guildId),
  ]);
  const modal = new ModalBuilder().setCustomId("ap_modal_setpay_reg").setTitle("Regular Season Payouts");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("h2h_win").setLabel(`H2H Win (current: ${h2hWin})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(h2hWin))),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("h2h_loss").setLabel(`H2H Loss (current: ${h2hLoss})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(h2hLoss))),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("cpu_win").setLabel(`CPU Win (current: ${cpuWin})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(cpuWin))),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("highlights").setLabel(`Highlight Payout per video (current: ${highlights})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(highlights))),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("highlight_cap").setLabel(`Highlight Weekly Cap (current: ${highlightCap})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2).setPlaceholder(String(highlightCap))),
  );
  await interaction.showModal(modal);
}

export async function handleSetPayRegModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const adminId = interaction.user.id;
  const changes: string[] = [];

  const pairs: [string, PayoutKey][] = [
    ["h2h_win",       PAYOUT_KEYS.H2H_WIN],
    ["h2h_loss",      PAYOUT_KEYS.H2H_LOSS],
    ["cpu_win",       PAYOUT_KEYS.CPU_WIN],
    ["highlights",    PAYOUT_KEYS.HIGHLIGHT_PAYOUT],
    ["highlight_cap", PAYOUT_KEYS.HIGHLIGHT_LIMIT],
  ];
  for (const [field, pk] of pairs) {
    const raw = interaction.fields.getTextInputValue(field).trim();
    if (!raw) continue;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 0) {
      await setPayoutValue(pk, val, adminId, guildId);
      changes.push(`✅ ${field.replace(/_/g," ")} → **${val}${field === "highlight_cap" ? " videos/wk" : " coins"}**`);
    }
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Regular Season Payouts Updated")
      .setDescription(changes.length > 0 ? changes.join("\n") : "No changes made (all fields left blank).")
      .setFooter({ text: `By ${interaction.user.username}` }).setTimestamp()],
  });
}

export async function handleSetPayChannel(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const [stream, poHighlight] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, guildId),
    getPayoutValue(PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT, guildId),
  ]);
  const modal = new ModalBuilder().setCustomId("ap_modal_setpay_channel").setTitle("Channel Activity Payouts");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("stream").setLabel(`Stream Payout per side (current: ${stream})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(stream))),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("po_highlight").setLabel(`Playoff Highlight Payout (current: ${poHighlight})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder(String(poHighlight))),
  );
  await interaction.showModal(modal);
}

export async function handleSetPayChannelModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const changes: string[] = [];
  const pairs: [string, PayoutKey][] = [
    ["stream",       PAYOUT_KEYS.STREAM_PAYOUT],
    ["po_highlight", PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT],
  ];
  for (const [field, pk] of pairs) {
    const raw = interaction.fields.getTextInputValue(field).trim();
    if (!raw) continue;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 0) {
      await setPayoutValue(pk, val, interaction.user.id, guildId);
      changes.push(`✅ ${field.replace(/_/g," ")} → **${val} coins**`);
    }
  }
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Channel Payouts Updated")
      .setDescription(changes.length > 0 ? changes.join("\n") : "No changes made.")
      .setFooter({ text: `By ${interaction.user.username}` }).setTimestamp()],
  });
}

export async function handleSetPayHighlightCapModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.fields.getTextInputValue("cap").trim();
  const val = parseInt(raw, 10);
  if (!isNaN(val) && val >= 0) {
    await setPayoutValue(PAYOUT_KEYS.HIGHLIGHT_LIMIT, val, interaction.user.id, interaction.guildId!);
    await interaction.editReply({ content: `✅ Highlight weekly cap set to **${val}**` });
  } else {
    await interaction.editReply({ content: "❌ Invalid cap value." });
  }
}

export async function handleSetPayPlayoff(interaction: ButtonInteraction): Promise<void> {
  // This no longer needed — kept for compatibility. handleSetPay now shows Part 1/2 buttons.
  await handleSetPayPo1Btn(interaction);
}

export async function handleSetPayPo1Btn(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const [po_win, po_loss, po_cpu, wc, div] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_WIN,  guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_H2H_LOSS, guildId),
    getPayoutValue(PAYOUT_KEYS.PLAYOFF_CPU_WIN,  guildId),
    getPayoutValue(PAYOUT_KEYS.WILDCARD_BONUS,   guildId),
    getPayoutValue(PAYOUT_KEYS.DIVISIONAL_BONUS, guildId),
  ]);
  const modal = new ModalBuilder().setCustomId("ap_modal_setpay_po1").setTitle("Playoff Payouts — Part 1");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("po_h2h_win").setLabel(`Playoff H2H Win (current: ${po_win})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("po_h2h_loss").setLabel(`Playoff H2H Loss (current: ${po_loss})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("po_cpu_win").setLabel(`Playoff CPU Win (current: ${po_cpu})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("wildcard").setLabel(`Wild Card Bonus (current: ${wc})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("divisional").setLabel(`Divisional Bonus (current: ${div})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
  );
  await interaction.showModal(modal);
}

export async function handleSetPayPo2Btn(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const [confWin, confRU, sbWin, sbRU, poHighlight] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.CONFERENCE_WIN_BONUS,      guildId),
    getPayoutValue(PAYOUT_KEYS.CONFERENCE_RUNNER_UP,      guildId),
    getPayoutValue(PAYOUT_KEYS.SUPERBOWL_WIN_BONUS,       guildId),
    getPayoutValue(PAYOUT_KEYS.SUPERBOWL_RUNNER_UP,       guildId),
    getPayoutValue(PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT,  guildId),
  ]);
  const modal = new ModalBuilder().setCustomId("ap_modal_setpay_po2").setTitle("Playoff Payouts — Part 2");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("conf_win").setLabel(`Conference Winner (current: ${confWin})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("conf_runnerup").setLabel(`Conference Runner-Up (current: ${confRU})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("sb_win").setLabel(`Super Bowl Winner (current: ${sbWin})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("sb_runnerup").setLabel(`Super Bowl Runner-Up (current: ${sbRU})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("po_highlight").setLabel(`Playoff Highlight Payout per video (current: ${poHighlight})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
  );
  await interaction.showModal(modal);
}

export async function handleSetPayPo1Modal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const adminId = interaction.user.id;
  const changes: string[] = [];

  const po1Pairs: [string, PayoutKey][] = [
    ["po_h2h_win",  PAYOUT_KEYS.PLAYOFF_H2H_WIN],
    ["po_h2h_loss", PAYOUT_KEYS.PLAYOFF_H2H_LOSS],
    ["po_cpu_win",  PAYOUT_KEYS.PLAYOFF_CPU_WIN],
    ["wildcard",    PAYOUT_KEYS.WILDCARD_BONUS],
    ["divisional",  PAYOUT_KEYS.DIVISIONAL_BONUS],
  ];
  for (const [field, pk] of po1Pairs) {
    const raw = interaction.fields.getTextInputValue(field).trim();
    if (!raw) continue;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 0) { await setPayoutValue(pk, val, adminId, guildId); changes.push(`✅ ${field} → **${val}**`); }
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Playoff Payouts Part 1 Updated")
      .setDescription(changes.length > 0 ? changes.join("\n") : "No changes made.")
      .setFooter({ text: `By ${interaction.user.username}` }).setTimestamp()],
  });
}

export async function handleSetPayPo2Modal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const adminId = interaction.user.id;
  const changes: string[] = [];

  const po2Pairs: [string, PayoutKey][] = [
    ["conf_win",      PAYOUT_KEYS.CONFERENCE_WIN_BONUS],
    ["conf_runnerup", PAYOUT_KEYS.CONFERENCE_RUNNER_UP],
    ["sb_win",        PAYOUT_KEYS.SUPERBOWL_WIN_BONUS],
    ["sb_runnerup",   PAYOUT_KEYS.SUPERBOWL_RUNNER_UP],
    ["po_highlight",  PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT],
  ];
  for (const [field, pk] of po2Pairs) {
    const raw = interaction.fields.getTextInputValue(field).trim();
    if (!raw) continue;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 0) { await setPayoutValue(pk, val, adminId, guildId); changes.push(`✅ ${field} → **${val}**`); }
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Playoff Payouts Part 2 Updated")
      .setDescription(changes.length > 0 ? changes.join("\n") : "No changes made.")
      .setFooter({ text: `By ${interaction.user.username}` }).setTimestamp()],
  });
}

// ── Set New Member Bonus ───────────────────────────────────────────────────────
export async function handleNewMember(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const current = await getPayoutValue(PAYOUT_KEYS.NEW_MEMBER_BONUS, interaction.guildId!);
  const modal = new ModalBuilder().setCustomId("ap_modal_newmember").setTitle("Set New Member Bonus");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel(`New member bonus coins (current: ${current})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setPlaceholder(String(current))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleNewMemberModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.fields.getTextInputValue("amount").trim();
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) { await interaction.editReply({ content: "❌ Invalid amount." }); return; }
  await setPayoutValue(PAYOUT_KEYS.NEW_MEMBER_BONUS, val, interaction.user.id, interaction.guildId!);
  await interaction.editReply({ content: `✅ New member bonus set to **${val} coins**.` });
}

// ── Set GOTW Guess Bonus ───────────────────────────────────────────────────────
export async function handleGotwBonus(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const isPlayoff = ["wildcard","divisional","conference","superbowl"].includes((season as any).currentWeek ?? "");
  const key = isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS;
  const current = await getPayoutValue(key, interaction.guildId!);
  const modal = new ModalBuilder().setCustomId("ap_modal_gotwbonus").setTitle("Set GOTW Guess Bonus");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reg_bonus").setLabel(`Regular season guess bonus (current: ${await getPayoutValue(PAYOUT_KEYS.GOTW_REGULAR_BONUS, interaction.guildId!)})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("po_bonus").setLabel(`Playoff guess bonus (current: ${await getPayoutValue(PAYOUT_KEYS.GOTW_PLAYOFF_BONUS, interaction.guildId!)})`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3)
    ),
  );
  await interaction.showModal(modal);
}

export async function handleGotwBonusModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const changes: string[] = [];
  const regRaw = interaction.fields.getTextInputValue("reg_bonus").trim();
  const poRaw  = interaction.fields.getTextInputValue("po_bonus").trim();
  if (regRaw) {
    const v = parseInt(regRaw, 10);
    if (!isNaN(v) && v >= 0) { await setPayoutValue(PAYOUT_KEYS.GOTW_REGULAR_BONUS, v, interaction.user.id, guildId); changes.push(`✅ Regular season GOTW bonus → **${v} coins**`); }
  }
  if (poRaw) {
    const v = parseInt(poRaw, 10);
    if (!isNaN(v) && v >= 0) { await setPayoutValue(PAYOUT_KEYS.GOTW_PLAYOFF_BONUS, v, interaction.user.id, guildId); changes.push(`✅ Playoff GOTW bonus → **${v} coins**`); }
  }
  await interaction.editReply({ content: changes.length > 0 ? changes.join("\n") : "No changes made." });
}

// ── Set POTW Winner Bonus ──────────────────────────────────────────────────────
export async function handlePotwBonus(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const current = await getPayoutValue(PAYOUT_KEYS.POTW_BONUS, interaction.guildId!);
  const modal = new ModalBuilder().setCustomId("ap_modal_potwbonus").setTitle("Set POTW Winner Bonus");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel(`POTW winner bonus coins (current: ${current})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setPlaceholder(String(current))
    ),
  );
  await interaction.showModal(modal);
}

export async function handlePotwBonusModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.fields.getTextInputValue("amount").trim();
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) { await interaction.editReply({ content: "❌ Invalid amount." }); return; }
  await setPayoutValue(PAYOUT_KEYS.POTW_BONUS, val, interaction.user.id, interaction.guildId!);
  await interaction.editReply({ content: `✅ POTW winner bonus set to **${val} coins**.` });
}

// ── Set Referral Bonuses ───────────────────────────────────────────────────────
export async function handleReferral(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const guildId = interaction.guildId!;
  const [newVal, memberVal] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_NEW,    guildId),
    getPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_MEMBER, guildId),
  ]);
  const modal = new ModalBuilder().setCustomId("ap_modal_referral").setTitle("Set Referral Bonuses");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("new_referral")
        .setLabel(`New Referral Bonus (current: ${newVal} coins)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3)
        .setPlaceholder(String(newVal))
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("member_referral")
        .setLabel(`Member Referral Bonus (current: ${memberVal} coins)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3)
        .setPlaceholder(String(memberVal))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleReferralModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guildId  = interaction.guildId!;
  const newRaw   = interaction.fields.getTextInputValue("new_referral").trim();
  const memRaw   = interaction.fields.getTextInputValue("member_referral").trim();
  const newVal   = parseInt(newRaw,  10);
  const memberVal = parseInt(memRaw, 10);
  if (isNaN(newVal)  || newVal  < 0 || newVal  > 999) { await interaction.editReply({ content: "❌ New Referral Bonus must be a number 0–999." });    return; }
  if (isNaN(memberVal) || memberVal < 0 || memberVal > 999) { await interaction.editReply({ content: "❌ Member Referral Bonus must be a number 0–999." }); return; }
  await Promise.all([
    setPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_NEW,    newVal,    interaction.user.id, guildId),
    setPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_MEMBER, memberVal, interaction.user.id, guildId),
  ]);
  await interaction.editReply({
    content: `✅ Referral bonuses updated — New member referral: **${newVal} coins** | Referring member bonus: **${memberVal} coins**.`,
  });
}

// ── Set EOS Payouts & Tiers ────────────────────────────────────────────────────
const EOS_PAYOUT_KEYS: Array<{ key: PayoutKey; label: string }> = [
  { key: PAYOUT_KEYS.SEASON_PR_1,         label: "Season PR #1 Bonus" },
  { key: PAYOUT_KEYS.SEASON_PR_2,         label: "Season PR #2 Bonus" },
  { key: PAYOUT_KEYS.SEASON_PR_3_6,       label: "Season PR #3–6 Bonus" },
  { key: PAYOUT_KEYS.SEASON_PR_7_8,       label: "Season PR #7–8 Bonus" },
  { key: PAYOUT_KEYS.SEASON_PR_9_10,      label: "Season PR #9–10 Bonus" },
  { key: PAYOUT_KEYS.EOS_RB_YPC_BONUS,    label: "EOS Top RB YPC Bonus" },
  { key: PAYOUT_KEYS.EOS_QB_YPA_BONUS,    label: "EOS Top QB YPA Bonus" },
  { key: PAYOUT_KEYS.EOS_DB_INT_BONUS,    label: "EOS DB Individual INT Bonus" },
  { key: PAYOUT_KEYS.EOS_QB_MIN_ATT,      label: "EOS QB Min Pass Attempts (threshold)" },
  { key: PAYOUT_KEYS.EOS_RB_MIN_ATT,      label: "EOS RB Min Rush Attempts (threshold)" },
  { key: PAYOUT_KEYS.EOS_QB_MIN_YPA,      label: "EOS QB Min YPA ×10 (e.g. 85 = 8.5)" },
  { key: PAYOUT_KEYS.EOS_RB_MIN_YPC,      label: "EOS RB Min YPC ×10 (e.g. 70 = 7.0)" },
  { key: PAYOUT_KEYS.EOS_DB_MIN_INTS,     label: "EOS DB Min INT Count" },
  { key: PAYOUT_KEYS.EOS_MISSED_PLAYOFFS, label: "Missed Playoffs Consolation" },
];

const EOS_STAT_TIER_PREFIX = "stat_tier:";

export async function handleEos(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }

  const guildId = interaction.guildId!;
  const config  = await getAllPayoutConfig(guildId);
  const season  = await getOrCreateActiveSeason(guildId);

  const statTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of statTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  const flatBlock = EOS_PAYOUT_KEYS.map(({ key, label }) =>
    `**${label}**: ${config.get(key) ?? 0}`
  ).join("\n");

  const tierBlock = STAT_CATEGORIES.map(cat => {
    const tiers = (tiersByCategory.get(cat.key) ?? []).sort((a, b) => a.tier - b.tier);
    const op = cat.direction === "higher" ? "≥" : "≤";
    const tierStr = tiers.length > 0
      ? tiers.map(t => `T${t.tier}:${op}${t.threshold}→${t.payout}🪙`).join(" ")
      : "*(defaults not seeded)*";
    return `**${cat.label}**: ${tierStr}`;
  }).join("\n");

  const flatOptions = EOS_PAYOUT_KEYS.map(({ key, label }) =>
    new StringSelectMenuOptionBuilder().setLabel(label.slice(0, 100)).setValue(key)
  );
  const tierOptions = STAT_CATEGORIES.map(cat =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`📊 ${cat.label} (tiered)`.slice(0, 100))
      .setDescription(`${cat.direction === "higher" ? "Higher" : "Lower"} = better (${cat.unit})`)
      .setValue(`${EOS_STAT_TIER_PREFIX}${cat.key}`)
  );
  const allOptions = [...flatOptions, ...tierOptions].slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId("ap_eos_key")
    .setPlaceholder("Select a payout or stat-tier category to edit…")
    .setMinValues(1).setMaxValues(1)
    .addOptions(allOptions);

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2d6a4f)
      .setTitle("📊 EOS Payouts & Tiers")
      .addFields(
        { name: "Flat Payouts", value: flatBlock.slice(0, 1024) },
        { name: "Stat Tier Categories (this season)", value: tierBlock.slice(0, 1024) },
      )],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back to Hub").setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

export async function handleEosKeySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const value = interaction.values[0]!;
  const sessionK = sessionKey(interaction.guildId!, interaction.user.id);
  let session = payoutSessions.get(sessionK);
  if (!session) session = { flow: "eos", afcSelected: [], nfcSelected: [] };

  if (value.startsWith(EOS_STAT_TIER_PREFIX)) {
    const catKey = value.slice(EOS_STAT_TIER_PREFIX.length);
    const cat = STAT_CATEGORY_MAP.get(catKey);
    if (!cat) { await interaction.deferUpdate(); return; }

    session.eosStatCategory = catKey;
    payoutSessions.set(sessionK, session);

    const season = await getOrCreateActiveSeason(interaction.guildId!);
    const existingRows = await db.select()
      .from(seasonStatTierConfigsTable)
      .where(and(
        eq(seasonStatTierConfigsTable.seasonId, season.id),
        eq(seasonStatTierConfigsTable.statCategory, catKey),
      ));
    const existingByTier = new Map(existingRows.map(r => [r.tier, r]));

    const defaults = STAT_TIER_DEFAULTS[catKey] ?? [];
    const op = cat.direction === "higher" ? "≥" : "≤";

    const getRow = (tier: number) => existingByTier.get(tier) ?? defaults[tier - 1];
    const t = (n: number) => { const r = getRow(n); return r ? `${r.threshold}/${r.payout}` : ""; };

    const modal = new ModalBuilder()
      .setCustomId("ap_modal_eos_stat_tier")
      .setTitle(`Stat Tiers: ${cat.label.slice(0, 30)}`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("t1").setLabel(`Tier 1 (worst) — format: ${op}threshold/coins`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder(t(1))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("t2").setLabel(`Tier 2 — format: ${op}threshold/coins`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder(t(2))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("t3").setLabel(`Tier 3 — format: ${op}threshold/coins`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder(t(3))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("t4").setLabel(`Tier 4 (best) — format: ${op}threshold/coins`).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder(t(4))
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  const key = value as PayoutKey;
  const current = await getPayoutValue(key, interaction.guildId!);
  const meta = EOS_PAYOUT_KEYS.find(e => e.key === key);

  session.eosKey = key;
  payoutSessions.set(sessionK, session);

  const modal = new ModalBuilder().setCustomId("ap_modal_eos_edit").setTitle(`Edit: ${(meta?.label ?? key).slice(0, 45)}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("value")
        .setLabel(`New value (current: ${current})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6)
        .setPlaceholder(String(current))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleEosEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const sessionK = sessionKey(interaction.guildId!, interaction.user.id);
  const session  = payoutSessions.get(sessionK);
  if (!session?.eosKey) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const raw = interaction.fields.getTextInputValue("value").trim();
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) { await interaction.editReply({ content: "❌ Invalid value." }); return; }

  await setPayoutValue(session.eosKey, val, interaction.user.id, interaction.guildId!);
  await interaction.editReply({ content: `✅ **${session.eosKey}** set to **${val}**.` });
  payoutSessions.delete(sessionK);
}

export async function handleEosStatTierModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const sessionK = sessionKey(interaction.guildId!, interaction.user.id);
  const session  = payoutSessions.get(sessionK);
  if (!session?.eosStatCategory) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const catKey = session.eosStatCategory;
  const cat = STAT_CATEGORY_MAP.get(catKey);
  if (!cat) { await interaction.editReply({ content: "❌ Invalid category." }); return; }

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const changes: string[] = [];

  for (let tier = 1; tier <= 4; tier++) {
    const raw = interaction.fields.getTextInputValue(`t${tier}`).trim();
    if (!raw) continue;
    const parts = raw.split("/");
    if (parts.length !== 2) { changes.push(`⚠️ Tier ${tier}: invalid format (use threshold/coins)`); continue; }
    const threshold = parseInt(parts[0]!.trim(), 10);
    const payout    = parseInt(parts[1]!.trim(), 10);
    if (isNaN(threshold) || isNaN(payout)) { changes.push(`⚠️ Tier ${tier}: non-numeric value`); continue; }

    await db.insert(seasonStatTierConfigsTable)
      .values({ seasonId: season.id, statCategory: catKey, tier, threshold, payout })
      .onConflictDoUpdate({
        target: [seasonStatTierConfigsTable.seasonId, seasonStatTierConfigsTable.statCategory, seasonStatTierConfigsTable.tier],
        set: { threshold, payout, updatedAt: new Date() },
      });
    const op = cat.direction === "higher" ? "≥" : "≤";
    changes.push(`✅ ${cat.label} Tier ${tier}: ${op}${threshold} → +${payout} coins`);
  }

  payoutSessions.delete(sessionK);
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`✅ Stat Tiers Updated — ${cat.label}`)
      .setDescription(changes.join("\n") || "No changes made.")
      .setFooter({ text: `By ${interaction.user.username}` })
      .setTimestamp()],
  });
}

// ── Set Milestone Payouts & Tiers ──────────────────────────────────────────────
export async function handleMilestone(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }

  const guildId = interaction.guildId!;
  const tiers   = await getMilestoneTiers(guildId);

  const description = tiers.map(t =>
    `**Tier ${t.tier}**: ${t.wins} all-time wins → **+${t.bonus} coins**${t.wins === 0 ? " *(inactive)*" : ""}`
  ).join("\n");

  const canAddTier = tiers.length < MILESTONE_TIER_KEYS.length;
  const editBtns = tiers.map(t =>
    new ButtonBuilder().setCustomId(`ap_ms_edit_${t.tier}`).setLabel(`Edit T${t.tier}`).setStyle(ButtonStyle.Secondary)
  );
  const addBtn  = new ButtonBuilder().setCustomId("ap_ms_add").setLabel("➕ Add Tier").setStyle(ButtonStyle.Success);
  const backBtn = new ButtonBuilder().setCustomId("ap_cancel").setLabel("Back to Hub").setStyle(ButtonStyle.Secondary);

  const actionBtns = canAddTier ? [...editBtns, addBtn] : editBtns;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < actionBtns.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...actionBtns.slice(i, i + 5)));
  }
  if (rows.length < 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn));
  } else {
    rows[rows.length - 1]!.addComponents(backBtn);
  }

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2d6a4f)
      .setTitle("🎯 Career Win Milestone Tiers")
      .setDescription(
        description +
        "\n\nClick **Edit** to update a tier. Click **Add Tier** to add a new tier (up to 10 total).\n" +
        `Tiers active: **${tiers.length}** / ${MILESTONE_TIER_KEYS.length}`
      )],
    components: rows,
  });
}

export async function handleMilestoneAdd(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const tiers = await getMilestoneTiers(guildId);
  const nextTierNum = tiers.length + 1;
  if (nextTierNum > MILESTONE_TIER_KEYS.length) {
    await interaction.reply({ content: `❌ Maximum of ${MILESTONE_TIER_KEYS.length} tiers reached.`, ephemeral: true }); return;
  }
  const sessionK = sessionKey(guildId, interaction.user.id);
  let session = payoutSessions.get(sessionK);
  if (!session) session = { flow: "milestone", afcSelected: [], nfcSelected: [] };
  session.milestoneIndex = nextTierNum;
  payoutSessions.set(sessionK, session);

  const modal = new ModalBuilder().setCustomId("ap_modal_milestone_edit").setTitle(`Add Milestone — Tier ${nextTierNum}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("wins").setLabel(`Win threshold for Tier ${nextTierNum}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder("e.g. 75")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("bonus").setLabel(`Coin bonus for Tier ${nextTierNum}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setPlaceholder("e.g. 2000")
    ),
  );
  await interaction.showModal(modal);
}

export async function handleMilestoneEdit(interaction: ButtonInteraction, tier: number): Promise<void> {
  const guildId = interaction.guildId!;
  const tiers   = await getMilestoneTiers(guildId);
  const t       = tiers.find(m => m.tier === tier);
  if (!t) { await interaction.reply({ content: "❌ Invalid tier.", ephemeral: true }); return; }

  const sessionK = sessionKey(guildId, interaction.user.id);
  let session = payoutSessions.get(sessionK);
  if (!session) session = { flow: "milestone", afcSelected: [], nfcSelected: [] };
  session.milestoneIndex = tier;
  payoutSessions.set(sessionK, session);

  const modal = new ModalBuilder().setCustomId(`ap_modal_milestone_edit`).setTitle(`Edit Milestone — Tier ${tier}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("wins").setLabel(`Win threshold (current: ${t.wins})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder(String(t.wins))
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("bonus").setLabel(`Coin bonus (current: ${t.bonus})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder(String(t.bonus))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleMilestoneEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const sessionK = sessionKey(interaction.guildId!, interaction.user.id);
  const session  = payoutSessions.get(sessionK);
  if (!session?.milestoneIndex) { await interaction.editReply({ content: "❌ Session expired." }); return; }

  const tier  = session.milestoneIndex;
  const wins  = parseInt(interaction.fields.getTextInputValue("wins").trim(), 10);
  const bonus = parseInt(interaction.fields.getTextInputValue("bonus").trim(), 10);
  if (isNaN(wins) || isNaN(bonus) || wins <= 0 || bonus < 0) { await interaction.editReply({ content: "❌ Invalid values. Win count must be positive, bonus 0 or more." }); return; }

  const winsKey  = [PAYOUT_KEYS.MILESTONE_T1_WINS, PAYOUT_KEYS.MILESTONE_T2_WINS, PAYOUT_KEYS.MILESTONE_T3_WINS, PAYOUT_KEYS.MILESTONE_T4_WINS][tier - 1]!;
  const bonusKey = [PAYOUT_KEYS.MILESTONE_T1_BONUS, PAYOUT_KEYS.MILESTONE_T2_BONUS, PAYOUT_KEYS.MILESTONE_T3_BONUS, PAYOUT_KEYS.MILESTONE_T4_BONUS][tier - 1]!;

  await setPayoutValue(winsKey,  wins,  interaction.user.id, interaction.guildId!);
  await setPayoutValue(bonusKey, bonus, interaction.user.id, interaction.guildId!);

  payoutSessions.delete(sessionK);
  await interaction.editReply({
    content: `✅ Milestone Tier ${tier} updated: **${wins} wins** → **+${bonus} coins**`,
  });
}

// ── Set Tweet Payout Amount ────────────────────────────────────────────────────
export async function handleTweetPayout(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const current = await getPayoutValue(PAYOUT_KEYS.TWEET_PAYOUT, interaction.guildId!);
  const modal = new ModalBuilder().setCustomId("ap_modal_tweetpayout").setTitle("Set Tweet Payout Amount");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel(`Coins per tweet submission (current: ${current})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder(String(current))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleTweetPayoutModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.fields.getTextInputValue("amount").trim();
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) { await interaction.editReply({ content: "❌ Invalid amount." }); return; }
  await setPayoutValue(PAYOUT_KEYS.TWEET_PAYOUT, val, interaction.user.id, interaction.guildId!);
  await interaction.editReply({ content: `✅ Tweet payout set to **${val} coins** per submission.` });
}

// ── Set Interview Payout Amount ───────────────────────────────────────────────
export async function handleInterviewPayout(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
  const current = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, interaction.guildId!);
  const modal = new ModalBuilder().setCustomId("ap_modal_interviewpayout").setTitle("Set Interview Payout Amount");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel(`Coins per approved interview (current: ${current})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder(String(current))
    ),
  );
  await interaction.showModal(modal);
}

export async function handleInterviewPayoutModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.fields.getTextInputValue("amount").trim();
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) { await interaction.editReply({ content: "❌ Invalid amount." }); return; }
  await setPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, val, interaction.user.id, interaction.guildId!);
  await interaction.editReply({ content: `✅ Interview payout set to **${val} coins** per approval.` });
}
