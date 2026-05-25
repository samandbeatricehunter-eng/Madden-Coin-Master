import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, Colors,
  EmbedBuilder, ModalBuilder, ModalSubmitInteraction, TextChannel, TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { pressConferencesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  addBalance, getGuildChannel, CHANNEL_KEYS, getOrCreateUser,
} from "../db/db-helpers.js";
import { logTransaction } from "../db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import {
  TRASH_TALK_QUESTIONS, GENERAL_QUESTIONS, pickRandomIndices,
} from "../economy/press-questions.js";
import {
  getActiveWeekContext, findOpponentForWeek, findExistingPressConfThisWeek,
} from "../economy/press-conference.js";
import { weekLabel } from "../helpers/week-helpers.js";

// ── Shared utilities ─────────────────────────────────────────────────────────

function backRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
}

function alreadySubmittedEmbed(weekKey: string, type: string): EmbedBuilder {
  const typeLabel = type === "trash_talk" ? "Trash Talk press conference" : "General Interview";
  return new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚠️ Already Held This Week")
    .setDescription(
      `You already held a **${typeLabel}** this week (**${weekLabel(weekKey)}**).\n\n` +
      `Only one press conference per week — come back next week.`,
    );
}

// ── Entry: ac_press_open ─────────────────────────────────────────────────────
// Opens the type-picker. We could showModal directly, but a preview step lets
// us validate gates (weekly cap + opponent existence) before consuming the
// user's modal slot, AND lets the user read their drawn questions before
// committing to type them.

export async function handleAcPressOpen(interaction: ButtonInteraction): Promise<void> {
  const gid = interaction.guildId!;
  const ctx = await getActiveWeekContext(gid);
  if (!ctx) {
    await interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Orange)
        .setTitle("🎙️ Press Conference")
        .setDescription("No active game week right now — press conferences open up once the season starts.")],
      components: [backRow()],
    });
    return;
  }

  const existing = await findExistingPressConfThisWeek(gid, ctx, interaction.user.id);
  if (existing) {
    await interaction.reply({
      ephemeral: true,
      embeds: [alreadySubmittedEmbed(ctx.weekKey, existing.type)],
      components: [backRow()],
    });
    return;
  }

  // Resolve opponent up-front so we can disable the Trash Talk button cleanly.
  const opp = await findOpponentForWeek(gid, interaction.user.id, ctx);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Press Conference")
    .setDescription(
      `Choose your press conference type for **${weekLabel(ctx.weekKey)}**.\n\n` +
      "**🔥 Trash Talk Opponent** — 2 random questions + a closing statement aimed at your matchup. " +
      "Posted publicly tagging your opponent. **You and your opponent both earn coins** when they reply.\n\n" +
      "**🎤 General Interview** — 3 random general questions about your team and season. " +
      "Posted publicly. You earn coins on submission.\n\n" +
      "*You can only hold one press conference per week — choose wisely.*",
    );

  if (opp) {
    embed.addFields({
      name: "📅 This Week's Matchup",
      value: `**${opp.userTeam}** vs **${opp.opponentTeam}** (<@${opp.opponentId}>)`,
    });
  } else {
    embed.addFields({
      name: "📅 This Week's Matchup",
      value: "_No scheduled H2H opponent found — Trash Talk is unavailable, but you can still do a General Interview._",
    });
  }

  const trashBtn = new ButtonBuilder()
    .setCustomId("pc_pick:trash")
    .setLabel("🔥 Trash Talk Opponent")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!opp);
  const generalBtn = new ButtonBuilder()
    .setCustomId("pc_pick:general")
    .setLabel("🎤 General Interview")
    .setStyle(ButtonStyle.Primary);

  await interaction.reply({
    ephemeral: true,
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(trashBtn, generalBtn),
      backRow(),
    ],
  });
}

// ── Type pick: pc_pick:trash | pc_pick:general ───────────────────────────────
// Draws random questions and shows them as a preview with an "Open Answer Form"
// button that will showModal. Splitting the modal open across two clicks is
// necessary because we want the user to be able to READ the questions before
// committing to a modal (modal text input labels are capped at 45 chars).

export async function handlePcPick(interaction: ButtonInteraction): Promise<void> {
  const type = interaction.customId.split(":")[1] as "trash" | "general";
  const gid  = interaction.guildId!;

  const ctx = await getActiveWeekContext(gid);
  if (!ctx) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🎙️ Press Conference")
        .setDescription("No active game week — press conferences are closed.")],
      components: [backRow()],
    });
    return;
  }

  const existing = await findExistingPressConfThisWeek(gid, ctx, interaction.user.id);
  if (existing) {
    await interaction.update({
      embeds: [alreadySubmittedEmbed(ctx.weekKey, existing.type)],
      components: [backRow()],
    });
    return;
  }

  if (type === "trash") {
    const opp = await findOpponentForWeek(gid, interaction.user.id, ctx);
    if (!opp) {
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🔥 Trash Talk Unavailable")
          .setDescription("No scheduled H2H opponent for you this week. Try the General Interview instead.")],
        components: [backRow()],
      });
      return;
    }
    const indices = pickRandomIndices(TRASH_TALK_QUESTIONS.length, 2);
    const qs = indices.map(i => TRASH_TALK_QUESTIONS[i]!);
    const embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle(`🔥 Trash Talk — vs ${opp.opponentTeam}`)
      .setDescription(
        `Tag-along opponent: <@${opp.opponentId}>\n\n` +
        "Read your questions below, then hit **Open Answer Form** to type your answers and a closing statement.",
      )
      .addFields(
        { name: "Q1", value: qs[0]! },
        { name: "Q2", value: qs[1]! },
      );

    const openBtn = new ButtonBuilder()
      .setCustomId(`pc_open_modal:trash:${indices.join(",")}`)
      .setLabel("📝 Open Answer Form")
      .setStyle(ButtonStyle.Danger);

    await interaction.update({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(openBtn), backRow()],
    });
    return;
  }

  // General
  const indices = pickRandomIndices(GENERAL_QUESTIONS.length, 3);
  const qs = indices.map(i => GENERAL_QUESTIONS[i]!);
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎤 General Interview")
    .setDescription("Read your three questions, then hit **Open Answer Form** to record your responses.")
    .addFields(
      { name: "Q1", value: qs[0]! },
      { name: "Q2", value: qs[1]! },
      { name: "Q3", value: qs[2]! },
    );
  const openBtn = new ButtonBuilder()
    .setCustomId(`pc_open_modal:general:${indices.join(",")}`)
    .setLabel("📝 Open Answer Form")
    .setStyle(ButtonStyle.Primary);

  await interaction.update({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(openBtn), backRow()],
  });
}

// ── Modal opener: pc_open_modal:<type>:<csv-indices> ─────────────────────────

export async function handlePcOpenModal(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const type = parts[1] as "trash" | "general";
  const idxCsv = parts[2] ?? "";
  const indices = idxCsv.split(",").map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));

  if (type === "trash") {
    if (indices.length !== 2) {
      await interaction.reply({ content: "❌ Invalid form state. Please try again.", ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`pc_modal:trash:${indices.join(",")}`)
      .setTitle("🔥 Trash Talk — Press Conference")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("a1").setLabel("Answer to Question 1")
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("a2").setLabel("Answer to Question 2")
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("statement").setLabel("Closing Statement (max 300 chars)")
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (indices.length !== 3) {
    await interaction.reply({ content: "❌ Invalid form state. Please try again.", ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`pc_modal:general:${indices.join(",")}`)
    .setTitle("🎤 General Interview")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("a1").setLabel("Answer to Question 1")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("a2").setLabel("Answer to Question 2")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("a3").setLabel("Answer to Question 3")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
    );
  await interaction.showModal(modal);
}

// ── Modal submit: pc_modal:<type>:<csv-indices> ──────────────────────────────

export async function handlePcModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const type = parts[1] as "trash" | "general";
  const idxCsv = parts[2] ?? "";
  const indices = idxCsv.split(",").map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));

  const gid = interaction.guildId!;
  const ctx = await getActiveWeekContext(gid);
  if (!ctx) {
    await interaction.reply({ content: "❌ No active game week — press conference closed.", ephemeral: true });
    return;
  }

  await getOrCreateUser(interaction.user.id, interaction.user.username, gid);

  // Race-safe re-check before insert. The uniq index is the true guard, but
  // checking first lets us give a clean error instead of a Postgres unique violation.
  const existing = await findExistingPressConfThisWeek(gid, ctx, interaction.user.id);
  if (existing) {
    await interaction.reply({
      ephemeral: true,
      embeds: [alreadySubmittedEmbed(ctx.weekKey, existing.type)],
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const generalChannelId = await getGuildChannel(gid, CHANNEL_KEYS.GENERAL);
  if (!generalChannelId) {
    await interaction.editReply({
      content: "❌ The **General Chat** channel isn't set yet. Ask a commissioner to set it via the Commissioner's Office (📣 Set General Chat) before submitting press conferences.",
    });
    return;
  }
  const ch = await interaction.client.channels.fetch(generalChannelId).catch(() => null) as TextChannel | null;
  if (!ch?.isTextBased()) {
    await interaction.editReply({ content: "❌ Could not access the General Chat channel." });
    return;
  }

  if (type === "trash") {
    if (indices.length !== 2) { await interaction.editReply({ content: "❌ Invalid form state." }); return; }
    const opp = await findOpponentForWeek(gid, interaction.user.id, ctx);
    if (!opp) {
      await interaction.editReply({ content: "❌ Lost track of your opponent — try again next week or use General Interview." });
      return;
    }
    const questions = indices.map(i => TRASH_TALK_QUESTIONS[i] ?? "(question missing)");
    const a1 = interaction.fields.getTextInputValue("a1");
    const a2 = interaction.fields.getTextInputValue("a2");
    const statement = interaction.fields.getTextInputValue("statement");

    // Insert FIRST — uniq index enforces weekly cap. Insert before posting so a
    // post failure doesn't strand an unpaid row.
    let inserted;
    try {
      inserted = await db.insert(pressConferencesTable).values({
        guildId:    gid,
        seasonId:   ctx.seasonId,
        weekKey:    ctx.weekKey,
        weekIndex:  ctx.weekIndex,
        userId:     interaction.user.id,
        type:       "trash_talk",
        opponentId: opp.opponentId,
        questions,
        answers:    [a1, a2],
        statement,
      }).returning({ id: pressConferencesTable.id });
    } catch (err: any) {
      // Unique violation → user raced themselves
      if (err?.code === "23505") {
        await interaction.editReply({ embeds: [alreadySubmittedEmbed(ctx.weekKey, "trash_talk")] });
        return;
      }
      throw err;
    }
    const pcId = inserted[0]!.id;

    const payout = await getPayoutValue(PAYOUT_KEYS.PRESS_TRASH_PAYOUT, gid);

    // Build the public post
    const userMention = `<@${interaction.user.id}>`;
    const oppMention  = `<@${opp.opponentId}>`;
    const embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle(`🔥 PRESS CONFERENCE — ${opp.userTeam} vs ${opp.opponentTeam}`)
      .setDescription(`**${userMention}** has called out **${oppMention}** ahead of their ${weekLabel(ctx.weekKey)} matchup!`)
      .addFields(
        { name: `Q: ${questions[0]}`, value: a1.slice(0, 1024) },
        { name: `Q: ${questions[1]}`, value: a2.slice(0, 1024) },
        { name: "📣 Closing Statement", value: statement.slice(0, 1024) },
      )
      .setFooter({ text: `${weekLabel(ctx.weekKey)} • Press Conference #${pcId}` })
      .setTimestamp();

    const replyBtn = new ButtonBuilder()
      .setCustomId(`pc_reply:${pcId}`)
      .setLabel(`💬 Reply (only ${(interaction.guild?.members.cache.get(opp.opponentId)?.displayName) ?? "opponent"})`)
      .setStyle(ButtonStyle.Danger);

    const posted = await ch.send({
      content: `@everyone — ${oppMention}, your move:`,
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(replyBtn)],
      allowedMentions: { parse: ["everyone"], users: [opp.opponentId] },
    });

    await db.update(pressConferencesTable)
      .set({ messageId: posted.id })
      .where(eq(pressConferencesTable.id, pcId));

    // Pay the initiator NOW; opponent gets paid on reply (and the initiator
    // also gets an additional matching payout flagged as "completed").
    await addBalance(interaction.user.id, payout, gid);
    await logTransaction(interaction.user.id, payout, "addcoins",
      `Trash Talk press conference (Week ${ctx.weekKey})`, gid, "auto");
    await db.update(pressConferencesTable)
      .set({ paidUserAt: new Date() })
      .where(eq(pressConferencesTable.id, pcId));

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Green)
        .setTitle("✅ Press Conference Posted")
        .setDescription(
          `Your trash talk has been posted to <#${generalChannelId}> and ${oppMention} has been tagged.\n\n` +
          `+**${payout} coins** paid. Your opponent will earn **${payout} coins** if they reply.`,
        )],
      components: [backRow()],
    });
    return;
  }

  // General
  if (indices.length !== 3) { await interaction.editReply({ content: "❌ Invalid form state." }); return; }
  const questions = indices.map(i => GENERAL_QUESTIONS[i] ?? "(question missing)");
  const a1 = interaction.fields.getTextInputValue("a1");
  const a2 = interaction.fields.getTextInputValue("a2");
  const a3 = interaction.fields.getTextInputValue("a3");

  let inserted;
  try {
    inserted = await db.insert(pressConferencesTable).values({
      guildId:    gid,
      seasonId:   ctx.seasonId,
      weekKey:    ctx.weekKey,
      weekIndex:  ctx.weekIndex,
      userId:     interaction.user.id,
      type:       "general",
      questions,
      answers:    [a1, a2, a3],
    }).returning({ id: pressConferencesTable.id });
  } catch (err: any) {
    if (err?.code === "23505") {
      await interaction.editReply({ embeds: [alreadySubmittedEmbed(ctx.weekKey, "general")] });
      return;
    }
    throw err;
  }
  const pcId = inserted[0]!.id;
  const payout = await getPayoutValue(PAYOUT_KEYS.PRESS_GENERAL_PAYOUT, gid);

  const userMention = `<@${interaction.user.id}>`;
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🎤 PRESS CONFERENCE — General Interview")
    .setDescription(`**${userMention}** sat down for a press conference ahead of ${weekLabel(ctx.weekKey)}.`)
    .addFields(
      { name: `Q: ${questions[0]}`, value: a1.slice(0, 1024) },
      { name: `Q: ${questions[1]}`, value: a2.slice(0, 1024) },
      { name: `Q: ${questions[2]}`, value: a3.slice(0, 1024) },
    )
    .setFooter({ text: `${weekLabel(ctx.weekKey)} • Press Conference #${pcId}` })
    .setTimestamp();

  const posted = await ch.send({
    content: "@everyone",
    embeds: [embed],
    allowedMentions: { parse: ["everyone"] },
  });

  await db.update(pressConferencesTable)
    .set({ messageId: posted.id })
    .where(eq(pressConferencesTable.id, pcId));

  await addBalance(interaction.user.id, payout, gid);
  await logTransaction(interaction.user.id, payout, "addcoins",
    `General Interview press conference (Week ${ctx.weekKey})`, gid, "auto");
  await db.update(pressConferencesTable)
    .set({ paidUserAt: new Date() })
    .where(eq(pressConferencesTable.id, pcId));

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Green)
      .setTitle("✅ Interview Posted")
      .setDescription(`Your interview has been posted to <#${generalChannelId}>.\n\n+**${payout} coins** paid.`)],
    components: [backRow()],
  });
}

// ── Reply flow: pc_reply:<pcId> ──────────────────────────────────────────────

export async function handlePcReplyClick(interaction: ButtonInteraction): Promise<void> {
  const pcId = parseInt(interaction.customId.split(":")[1] ?? "0", 10);
  const [row] = await db.select().from(pressConferencesTable)
    .where(eq(pressConferencesTable.id, pcId)).limit(1);
  if (!row) {
    await interaction.reply({ content: "❌ Press conference not found.", ephemeral: true });
    return;
  }
  if (row.opponentId !== interaction.user.id) {
    await interaction.reply({
      content: `🚫 Only <@${row.opponentId}> can respond to this trash talk.`,
      ephemeral: true,
    });
    return;
  }
  if (row.opponentReply) {
    await interaction.reply({ content: "ℹ️ You've already replied to this one.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`pc_reply_modal:${pcId}`)
    .setTitle("💬 Reply to the Trash Talk")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reply").setLabel("Your response (max 500 chars)")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
    );
  await interaction.showModal(modal);
}

export async function handlePcReplyModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const pcId = parseInt(interaction.customId.split(":")[1] ?? "0", 10);
  const gid = interaction.guildId!;
  await interaction.deferReply({ ephemeral: true });

  const [row] = await db.select().from(pressConferencesTable)
    .where(eq(pressConferencesTable.id, pcId)).limit(1);
  if (!row) { await interaction.editReply({ content: "❌ Press conference not found." }); return; }
  if (row.opponentId !== interaction.user.id) { await interaction.editReply({ content: "🚫 Not your reply." }); return; }
  if (row.opponentReply) { await interaction.editReply({ content: "ℹ️ Already replied." }); return; }

  const reply = interaction.fields.getTextInputValue("reply");

  // Atomic claim: only the first submission lands the reply.
  const claimed = await db.update(pressConferencesTable)
    .set({ opponentReply: reply, opponentReplyAt: new Date() })
    .where(and(
      eq(pressConferencesTable.id, pcId),
      eq(pressConferencesTable.opponentId, interaction.user.id),
    ))
    .returning({ id: pressConferencesTable.id, paidOpponentAt: pressConferencesTable.paidOpponentAt });
  if (claimed.length === 0) {
    await interaction.editReply({ content: "❌ Could not record your reply (someone got there first?)." });
    return;
  }

  const generalChannelId = await getGuildChannel(gid, CHANNEL_KEYS.GENERAL);
  const ch = generalChannelId ? await interaction.client.channels.fetch(generalChannelId).catch(() => null) as TextChannel | null : null;

  if (ch?.isTextBased() && row.messageId) {
    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("💬 RESPONSE — The Opponent Fires Back")
      .setDescription(`<@${interaction.user.id}> responds to <@${row.userId}>:`)
      .addFields({ name: "Reply", value: reply.slice(0, 1024) })
      .setFooter({ text: `Press Conference #${pcId} — Reply` })
      .setTimestamp();

    // Disable the reply button on the original message
    try {
      const orig = await ch.messages.fetch(row.messageId).catch(() => null);
      if (orig) {
        const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`pc_reply_done:${pcId}`).setLabel("💬 Replied").setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        await orig.edit({ components: [disabled] }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    const posted = await ch.send({
      content: `@everyone — <@${row.userId}>, your move:`,
      embeds: [embed],
      reply: row.messageId ? { messageReference: row.messageId, failIfNotExists: false } : undefined,
      allowedMentions: { parse: ["everyone"], users: [row.userId] },
    });
    await db.update(pressConferencesTable)
      .set({ replyMessageId: posted.id })
      .where(eq(pressConferencesTable.id, pcId));
  }

  // Pay opponent. The initiator was already paid at post time — we only pay
  // the initiator again if they somehow weren't paid yet (defensive).
  const payout = await getPayoutValue(PAYOUT_KEYS.PRESS_TRASH_PAYOUT, gid);
  await getOrCreateUser(interaction.user.id, interaction.user.username, gid);

  if (!claimed[0]!.paidOpponentAt) {
    await addBalance(interaction.user.id, payout, gid);
    await logTransaction(interaction.user.id, payout, "addcoins",
      `Trash Talk reply (Press Conf #${pcId})`, gid, "auto");
    await db.update(pressConferencesTable)
      .set({ paidOpponentAt: new Date() })
      .where(eq(pressConferencesTable.id, pcId));
  }
  if (!row.paidUserAt) {
    await addBalance(row.userId, payout, gid);
    await logTransaction(row.userId, payout, "addcoins",
      `Trash Talk press conference completed (Press Conf #${pcId})`, gid, "auto");
    await db.update(pressConferencesTable)
      .set({ paidUserAt: new Date() })
      .where(eq(pressConferencesTable.id, pcId));
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Green)
      .setTitle("✅ Reply Posted")
      .setDescription(`Your reply is live in <#${generalChannelId ?? "general"}>. +**${payout} coins** earned.`)],
  });
}
