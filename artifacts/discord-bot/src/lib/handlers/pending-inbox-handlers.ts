/**
 * Commissioner's Office — Pending Items Inbox
 * Paginated embed views for pending payout requests, purchases, and interview
 * requests. Replaces dedicated approval channels with inline approve/deny/refund
 * buttons directly inside the admin menu.
 *
 * Custom ID prefix:  co_
 *
 * Entry point:
 *   Admin Menu → Manage Economy → Commissioner's Office
 *   → handler wired in admin-operations-handlers.ts  (selected === "commissioner_office")
 *   → button routing in interactionCreate.ts         (customId.startsWith("co_"))
 */

import {
  ButtonInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Client,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable,
  seasonsTable,
  usersTable,
  payoutRequestsTable,
  interviewRequestsTable,
  inventoryTable,
  pendingChannelPayoutsTable,
  coinTransactionsTable,
} from "@workspace/db";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import {
  addBalance,
  logTransaction,
} from "../db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 3;

// ── Commissioner's Office main menu ──────────────────────────────────────────

export function buildCommOfficeEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xB68B2D)
    .setTitle("🏛️ Commissioner's Office — Pending Transactions")
    .setDescription(
      "Select a category to review and act on pending items.\n\n" +
      "**🛒 Pending Purchases** — Store purchases awaiting application (apply / refund)\n" +
      "**📋 Pending Payouts** — User-submitted game payouts (approve / deny / edit)\n" +
      "**🎙️ Pending Interviews** — Post-game interviews (approve / deny / edit)\n" +
      "**🎬 Stream & Highlight Payouts** — Channel-detected media payouts (approve / deny / edit)\n" +
      "**🧾 Recent History** — Last 25 completed transactions\n\n" +
      "**📺 Set GOTY Channel** — Designate the Game-of-the-Year submission channel.\n" +
      "> ⚠️ **Required for end-of-season GOTY voting.** If no GOTY channel is set, " +
      "the bot has nowhere to pull candidate submissions from and **the GOTY vote will not run.**"
    )
    .setFooter({ text: "Actions are immediate. Users receive a DM on approve/deny." })
    .setTimestamp();
}

export interface CommOfficeBadgeCounts {
  purchases?:       number;
  payouts?:         number;
  interviews?:      number;
  streamHighlight?: number;
}

function badge(base: string, n?: number): string {
  if (!n || n <= 0) return base;
  return `${base} (${n})`;
}

export function buildCommOfficeRows(
  counts?: CommOfficeBadgeCounts,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("co_purchases:0").setLabel(badge("🛒 Pending Purchases", counts?.purchases)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("co_payouts:0").setLabel(badge("📋 Pending Payouts", counts?.payouts)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("co_interviews:0").setLabel(badge("🎙️ Pending Interviews", counts?.interviews)).setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("co_channel:0").setLabel(badge("🎬 Stream/Highlight", counts?.streamHighlight)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("co_history:0").setLabel("🧾 Recent History").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_ch_pick:goty").setLabel("📺 Set GOTY Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("menu_admin_back").setLabel("↩ Back").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Helper: get total count with guild scope ───────────────────────────────────

async function getGuildUserIds(guildId: string): Promise<string[]> {
  const rows = await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));
  return rows.map(r => r.discordId);
}

// ── Pending Payout Requests ───────────────────────────────────────────────────
// payoutRequestsTable has no guildId — scoped via usersTable join.

async function buildPayoutsPage(
  guildId: string,
  page: number,
): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const guildUserIds = await getGuildUserIds(guildId);

  let total = 0;
  let items: (typeof payoutRequestsTable.$inferSelect)[] = [];

  if (guildUserIds.length > 0) {
    const filter = and(
      inArray(payoutRequestsTable.requesterId, guildUserIds),
      eq(payoutRequestsTable.status, "pending"),
    );

    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(payoutRequestsTable)
      .where(filter);
    total = cnt ?? 0;

    items = await db
      .select()
      .from(payoutRequestsTable)
      .where(filter)
      .orderBy(payoutRequestsTable.createdAt)
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setColor(0x2d6a4f)
    .setTitle(`📋 Pending Payout Requests — ${total} total`)
    .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

  if (items.length === 0) {
    embed.setDescription("✅ No pending payout requests. All caught up!");
  } else {
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const typeLabel = p.gameType === "cpu" ? "CPU Win" : "H2H";
      embed.addFields({
        name: `#${i + 1}  ·  ${p.requesterTeam ?? "?"} vs ${p.opponentTeam ?? "CPU"}  [${typeLabel}]`,
        value: [
          `**User:** <@${p.requesterId}>`,
          `**Score:** ${p.requesterScore ?? "?"} – ${p.opponentScore ?? "?"}`,
          `**Week:** ${p.week ?? "?"}`,
          `**Submitted:** <t:${Math.floor(new Date(p.createdAt).getTime() / 1000)}:R>`,
        ].join("\n"),
        inline: false,
      });
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < items.length; i++) {
    const id = items[i].id;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`co_approve_payout:${id}`)
          .setLabel(`✅ Approve #${i + 1}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`co_edit_payout:${id}`)
          .setLabel(`✏ Edit #${i + 1}`)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`co_deny_payout:${id}`)
          .setLabel(`❌ Deny #${i + 1}`)
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`co_payouts:${page - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`co_payouts:${page + 1}`)
        .setLabel("▶ Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId("co_main")
        .setLabel("↩ Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embed, rows };
}

// ── Pending Purchases ─────────────────────────────────────────────────────────
// purchasesTable has no guildId — scoped via seasonsTable (seasonId → guildId).

async function buildPurchasesPage(
  guildId: string,
  page: number,
): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const guildFilter = and(
    eq(seasonsTable.guildId, guildId),
    eq(purchasesTable.status, "pending"),
  );

  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(purchasesTable)
    .innerJoin(seasonsTable, eq(purchasesTable.seasonId, seasonsTable.id))
    .where(guildFilter);
  const total = cnt ?? 0;

  const raw = await db
    .select({
      purchase: purchasesTable,
      username: usersTable.discordUsername,
    })
    .from(purchasesTable)
    .innerJoin(seasonsTable, eq(purchasesTable.seasonId, seasonsTable.id))
    .leftJoin(
      usersTable,
      and(
        eq(usersTable.discordId, purchasesTable.discordId),
        eq(usersTable.guildId, guildId),
      ),
    )
    .where(guildFilter)
    .orderBy(purchasesTable.createdAt)
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setColor(0x4b6cb7)
    .setTitle(`🛒 Pending Purchases — ${total} total`)
    .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

  if (raw.length === 0) {
    embed.setDescription("✅ No pending purchases. All caught up!");
  } else {
    for (let i = 0; i < raw.length; i++) {
      const { purchase: p, username } = raw[i];
      const typeLabel = p.purchaseType
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
      const detailLine = p.playerName
        ? `**Player:** ${p.playerName}${p.playerPosition ? ` (${p.playerPosition})` : ""}`
        : p.attributeName
        ? `**Attribute:** ${p.attributeName}`
        : "";

      embed.addFields({
        name: `#${i + 1}  ·  ${typeLabel}  —  ${p.cost} coins`,
        value: [
          `**User:** <@${p.discordId}>${username ? ` (${username})` : ""}`,
          `**Team:** ${p.teamName ?? "?"}`,
          detailLine,
          p.notes ? `**Notes:** ${p.notes.slice(0, 80)}` : "",
          `**Submitted:** <t:${Math.floor(new Date(p.createdAt).getTime() / 1000)}:R>`,
        ]
          .filter(Boolean)
          .join("\n"),
        inline: false,
      });
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < raw.length; i++) {
    const id = raw[i].purchase.id;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`co_approve_purchase:${id}`)
          .setLabel(`✅ Approve #${i + 1}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`co_refund_purchase:${id}`)
          .setLabel(`↩ Refund #${i + 1}`)
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`co_purchases:${page - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`co_purchases:${page + 1}`)
        .setLabel("▶ Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId("co_main")
        .setLabel("↩ Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embed, rows };
}

// ── Pending Interviews ────────────────────────────────────────────────────────

async function buildInterviewsPage(
  guildId: string,
  page: number,
): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const filter = and(
    eq(interviewRequestsTable.guildId, guildId),
    eq(interviewRequestsTable.status, "pending"),
  );

  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(interviewRequestsTable)
    .where(filter);
  const total = cnt ?? 0;

  const items = await db
    .select()
    .from(interviewRequestsTable)
    .where(filter)
    .orderBy(interviewRequestsTable.createdAt)
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setColor(0x7b2d8b)
    .setTitle(`🎙️ Pending Interviews — ${total} total`)
    .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

  if (items.length === 0) {
    embed.setDescription("✅ No pending interviews. All caught up!");
  } else {
    for (let i = 0; i < items.length; i++) {
      const iv = items[i];
      const lines: string[] = [
        `**User:** <@${iv.discordId}>`,
        `**Week:** ${iv.week ?? "?"}`,
      ];
      if (iv.question1 && iv.answer1) {
        lines.push(`**Q1:** ${iv.question1.slice(0, 60)}`);
        lines.push(`**A1:** ${iv.answer1.slice(0, 100)}`);
      }
      if (iv.question2 && iv.answer2) {
        lines.push(`**Q2:** ${iv.question2.slice(0, 60)}`);
        lines.push(`**A2:** ${iv.answer2.slice(0, 100)}`);
      }
      lines.push(
        `**Submitted:** <t:${Math.floor(new Date(iv.createdAt).getTime() / 1000)}:R>`,
      );

      embed.addFields({
        name: `#${i + 1}  ·  Week ${iv.week ?? "?"}  —  <@${iv.discordId}>`,
        value: lines.join("\n"),
        inline: false,
      });
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < items.length; i++) {
    const id = items[i].id;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`co_approve_interview:${id}`)
          .setLabel(`✅ Approve #${i + 1}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`co_edit_interview:${id}`)
          .setLabel(`✏ Edit #${i + 1}`)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`co_deny_interview:${id}`)
          .setLabel(`❌ Deny #${i + 1}`)
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`co_interviews:${page - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`co_interviews:${page + 1}`)
        .setLabel("▶ Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId("co_main")
        .setLabel("↩ Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embed, rows };
}

// ── Stream / Highlight Channel Payouts ────────────────────────────────────────

async function buildChannelPayoutsPage(
  guildId: string,
  page: number,
): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const filter = and(
    eq(pendingChannelPayoutsTable.guildId, guildId),
    eq(pendingChannelPayoutsTable.status, "pending"),
  );

  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(pendingChannelPayoutsTable)
    .where(filter);
  const total = cnt ?? 0;

  const items = await db
    .select()
    .from(pendingChannelPayoutsTable)
    .where(filter)
    .orderBy(pendingChannelPayoutsTable.createdAt)
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`🎬 Stream & Highlight Payouts — ${total} total`)
    .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

  if (items.length === 0) {
    embed.setDescription("✅ No pending stream/highlight payouts. All caught up!");
  } else {
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const emoji = p.type === "stream" ? "🎮" : "🎬";
      const link = `https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId}`;
      embed.addFields({
        name: `#${i + 1}  ·  ${emoji} ${p.type.toUpperCase()}  —  ${p.amount} coins`,
        value: [
          `**User:** <@${p.discordId}>`,
          `**Week:** ${p.week}`,
          `**Post:** [jump](${link})`,
          `**Submitted:** <t:${Math.floor(new Date(p.createdAt).getTime() / 1000)}:R>`,
        ].join("\n"),
        inline: false,
      });
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < items.length; i++) {
    const id = items[i].id;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`co_approve_channel:${id}`)
          .setLabel(`✅ Approve #${i + 1}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`co_deny_channel:${id}`)
          .setLabel(`❌ Deny #${i + 1}`)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`co_edit_channel:${id}`)
          .setLabel(`✏️ Edit #${i + 1}`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`co_channel:${page - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`co_channel:${page + 1}`)
        .setLabel("▶ Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId("co_main")
        .setLabel("↩ Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embed, rows };
}

// ── Recent History (last 25 completed transactions) ──────────────────────────

async function buildHistoryPage(
  guildId: string,
  page: number,
): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const HISTORY_LIMIT = 25;
  const HISTORY_PAGE_SIZE = 10;

  // Pull the last 25 commissioner-driven coin transactions for this guild.
  // We filter by transaction types tied to commissioner actions to avoid
  // flooding with regular game payouts and savings interest.
  const rowsRaw = await db
    .select()
    .from(coinTransactionsTable)
    .where(and(
      eq(coinTransactionsTable.guildId, guildId),
      inArray(coinTransactionsTable.type, [
        "addcoins",
        "removecoins",
        "purchase_refund",
        "purchase",
      ]),
    ))
    .orderBy(desc(coinTransactionsTable.createdAt))
    .limit(HISTORY_LIMIT);

  const total = rowsRaw.length;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rowsRaw.slice(safePage * HISTORY_PAGE_SIZE, (safePage + 1) * HISTORY_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0x808080)
    .setTitle(`🧾 Recent Commissioner Activity — last ${total}`)
    .setFooter({ text: `Page ${safePage + 1} / ${totalPages}` });

  if (slice.length === 0) {
    embed.setDescription("No completed commissioner actions yet.");
  } else {
    const lines = slice.map(t => {
      const sign = t.amount >= 0 ? "+" : "";
      const when = `<t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>`;
      return `${when} • <@${t.discordId}> • **${sign}${t.amount}** • ${t.description}`;
    });
    embed.setDescription(lines.join("\n"));
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`co_history:${safePage - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(`co_history:${safePage + 1}`)
        .setLabel("▶ Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId("co_main")
        .setLabel("↩ Back")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return { embed, rows };
}

// ── Action implementations ────────────────────────────────────────────────────
// These functions throw on failure so the dispatcher can handle the error
// uniformly with followUp() after deferUpdate().

async function doApprovePayoutRequest(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  // NOTE: payoutRequestsTable has no guildId column (bot is single-guild today).
  const [req] = await db
    .select()
    .from(payoutRequestsTable)
    .where(eq(payoutRequestsTable.id, id))
    .limit(1);

  if (!req) throw new Error("Payout request not found.");
  if (req.status !== "pending") throw new Error(`Already ${req.status}.`);

  const payoutKey =
    req.gameType === "cpu" ? PAYOUT_KEYS.CPU_WIN : PAYOUT_KEYS.H2H_WIN;
  const amount = await getPayoutValue(payoutKey, guildId);

  await db
    .update(payoutRequestsTable)
    .set({ status: "approved", resolvedAt: new Date(), resolvedBy: adminId })
    .where(eq(payoutRequestsTable.id, id));

  await addBalance(req.requesterId, amount, guildId);
  await logTransaction(
    req.requesterId,
    amount,
    "addcoins",
    `Game payout approved by commissioner (Week ${req.week ?? "?"})`,
    guildId,
    adminId,
  );

  client.users
    .fetch(req.requesterId)
    .then(u =>
      u
        .send(
          `✅ Your payout request (Week ${req.week ?? "?"}) was approved! **+${amount} coins** added.`,
        )
        .catch(() => null),
    )
    .catch(() => null);

  return `✅ Payout #${id} approved — **+${amount} coins** → <@${req.requesterId}>`;
}

async function doDenyPayoutRequest(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  const [req] = await db
    .select()
    .from(payoutRequestsTable)
    .where(eq(payoutRequestsTable.id, id))
    .limit(1);

  if (!req) throw new Error("Payout request not found.");
  if (req.status !== "pending") throw new Error(`Already ${req.status}.`);

  await db
    .update(payoutRequestsTable)
    .set({ status: "denied", resolvedAt: new Date(), resolvedBy: adminId })
    .where(eq(payoutRequestsTable.id, id));

  client.users
    .fetch(req.requesterId)
    .then(u =>
      u
        .send(
          `❌ Your payout request (Week ${req.week ?? "?"}) was denied by a commissioner.`,
        )
        .catch(() => null),
    )
    .catch(() => null);

  return `❌ Payout #${id} denied.`;
}

async function doApprovePurchase(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  // NOTE: purchasesTable has no guildId column (bot is single-guild today).
  const [purchase] = await db
    .select()
    .from(purchasesTable)
    .where(eq(purchasesTable.id, id))
    .limit(1);

  if (!purchase) throw new Error("Purchase not found.");
  if (purchase.status !== "pending") throw new Error(`Already ${purchase.status}.`);

  await db
    .update(purchasesTable)
    .set({ status: "approved", approvedAt: new Date() })
    .where(eq(purchasesTable.id, id));

  const typeLabel = purchase.purchaseType
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  client.users
    .fetch(purchase.discordId)
    .then(u =>
      u
        .send(`✅ Your **${typeLabel}** purchase has been approved and applied!`)
        .catch(() => null),
    )
    .catch(() => null);

  return `✅ Purchase #${id} (${typeLabel}) approved for <@${purchase.discordId}>.`;
}

async function doRefundPurchase(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  const [purchase] = await db
    .select()
    .from(purchasesTable)
    .where(eq(purchasesTable.id, id))
    .limit(1);

  if (!purchase) throw new Error("Purchase not found.");
  if (purchase.status === "refunded") throw new Error("Already refunded.");

  await db.transaction(async tx => {
    await tx
      .update(purchasesTable)
      .set({ status: "refunded" })
      .where(eq(purchasesTable.id, id));
    await tx
      .delete(inventoryTable)
      .where(eq(inventoryTable.purchaseId, id));
  });

  await addBalance(purchase.discordId, purchase.cost, guildId);
  await logTransaction(
    purchase.discordId,
    purchase.cost,
    "purchase_refund",
    `Purchase #${id} refunded by commissioner`,
    guildId,
    adminId,
  );

  const typeLabel = purchase.purchaseType
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  client.users
    .fetch(purchase.discordId)
    .then(u =>
      u
        .send(
          `↩️ Your **${typeLabel}** purchase was refunded. **+${purchase.cost} coins** returned.`,
        )
        .catch(() => null),
    )
    .catch(() => null);

  return `↩ Purchase #${id} (${typeLabel}) refunded — **+${purchase.cost} coins** → <@${purchase.discordId}>.`;
}

async function doApproveInterview(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  const [iv] = await db
    .select()
    .from(interviewRequestsTable)
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)))
    .limit(1);

  if (!iv) throw new Error("Interview not found.");
  if (iv.status !== "pending") throw new Error(`Already ${iv.status}.`);

  const amount = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, guildId);

  await db
    .update(interviewRequestsTable)
    .set({ status: "approved", resolvedAt: new Date(), resolvedBy: adminId })
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)));

  await addBalance(iv.discordId, amount, guildId);
  await logTransaction(
    iv.discordId,
    amount,
    "addcoins",
    `Interview approved (Week ${iv.week ?? "?"})`,
    guildId,
    adminId,
  );

  client.users
    .fetch(iv.discordId)
    .then(u =>
      u
        .send(
          `🎙️ Your Week ${iv.week ?? "?"} post-game interview was approved! **+${amount} coins** added.`,
        )
        .catch(() => null),
    )
    .catch(() => null);

  return `✅ Interview #${id} approved — **+${amount} coins** → <@${iv.discordId}>.`;
}

async function doDenyInterview(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  const [iv] = await db
    .select()
    .from(interviewRequestsTable)
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)))
    .limit(1);

  if (!iv) throw new Error("Interview not found.");
  if (iv.status !== "pending") throw new Error(`Already ${iv.status}.`);

  await db
    .update(interviewRequestsTable)
    .set({ status: "denied", resolvedAt: new Date(), resolvedBy: adminId })
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)));

  client.users
    .fetch(iv.discordId)
    .then(u =>
      u
        .send(`❌ Your Week ${iv.week ?? "?"} interview was not approved by a commissioner.`)
        .catch(() => null),
    )
    .catch(() => null);

  return `❌ Interview #${id} denied.`;
}

// ── Channel payout actions (stream / highlight) ──────────────────────────────

async function doApproveChannelPayout(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
  overrideAmount?: number,
): Promise<string> {
  const [row] = await db
    .select()
    .from(pendingChannelPayoutsTable)
    .where(and(eq(pendingChannelPayoutsTable.id, id), eq(pendingChannelPayoutsTable.guildId, guildId)))
    .limit(1);

  if (!row) throw new Error("Channel payout not found.");
  if (row.status !== "pending") throw new Error(`Already ${row.status}.`);

  const amount = overrideAmount ?? row.amount;

  await db
    .update(pendingChannelPayoutsTable)
    .set({
      status: "approved",
      amount,
      resolvedAt: new Date(),
      resolvedBy: adminId,
    })
    .where(and(eq(pendingChannelPayoutsTable.id, id), eq(pendingChannelPayoutsTable.guildId, guildId)));

  await addBalance(row.discordId, amount, guildId);
  await logTransaction(
    row.discordId,
    amount,
    "addcoins",
    `${row.type === "stream" ? "Stream" : "Highlight"} approved (Week ${row.week})`,
    guildId,
    adminId,
  );

  // Bonus to opponent for streams
  if (row.type === "stream" && row.opponentDiscordId && row.opponentAmount && row.opponentAmount > 0) {
    await addBalance(row.opponentDiscordId, row.opponentAmount, guildId);
    await logTransaction(
      row.opponentDiscordId,
      row.opponentAmount,
      "addcoins",
      `Stream opponent bonus (Week ${row.week})`,
      guildId,
      adminId,
    );
  }

  client.users
    .fetch(row.discordId)
    .then(u =>
      u.send(
        `✅ Your ${row.type} payout (Week ${row.week}) was approved! **+${amount} coins** added.`,
      ).catch(() => null),
    )
    .catch(() => null);

  return `✅ ${row.type} #${id} approved — **+${amount} coins** → <@${row.discordId}>`;
}

async function doDenyChannelPayout(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
): Promise<string> {
  const [row] = await db
    .select()
    .from(pendingChannelPayoutsTable)
    .where(and(eq(pendingChannelPayoutsTable.id, id), eq(pendingChannelPayoutsTable.guildId, guildId)))
    .limit(1);

  if (!row) throw new Error("Channel payout not found.");
  if (row.status !== "pending") throw new Error(`Already ${row.status}.`);

  await db
    .update(pendingChannelPayoutsTable)
    .set({ status: "denied", resolvedAt: new Date(), resolvedBy: adminId })
    .where(and(eq(pendingChannelPayoutsTable.id, id), eq(pendingChannelPayoutsTable.guildId, guildId)));

  client.users
    .fetch(row.discordId)
    .then(u =>
      u.send(
        `❌ Your ${row.type} payout (Week ${row.week}) was denied by a commissioner.`,
      ).catch(() => null),
    )
    .catch(() => null);

  return `❌ ${row.type} #${id} denied.`;
}

// ── Edit-amount approval (payouts / interviews — no amount column, so we
//    just bake the override into the resulting coin_transactions row) ────────

async function doApprovePayoutWithOverride(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
  amount: number,
): Promise<string> {
  const [req] = await db
    .select()
    .from(payoutRequestsTable)
    .where(eq(payoutRequestsTable.id, id))
    .limit(1);

  if (!req) throw new Error("Payout request not found.");
  if (req.status !== "pending") throw new Error(`Already ${req.status}.`);

  await db
    .update(payoutRequestsTable)
    .set({ status: "approved", resolvedAt: new Date(), resolvedBy: adminId })
    .where(eq(payoutRequestsTable.id, id));

  await addBalance(req.requesterId, amount, guildId);
  await logTransaction(
    req.requesterId,
    amount,
    "addcoins",
    `Game payout approved (edited) by commissioner (Week ${req.week ?? "?"})`,
    guildId,
    adminId,
  );

  client.users
    .fetch(req.requesterId)
    .then(u =>
      u.send(
        `✅ Your payout request (Week ${req.week ?? "?"}) was approved with an adjusted amount! **+${amount} coins** added.`,
      ).catch(() => null),
    )
    .catch(() => null);

  return `✅ Payout #${id} approved (edited) — **+${amount} coins** → <@${req.requesterId}>`;
}

async function doApproveInterviewWithOverride(
  id: number,
  guildId: string,
  adminId: string,
  client: Client,
  amount: number,
): Promise<string> {
  const [iv] = await db
    .select()
    .from(interviewRequestsTable)
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)))
    .limit(1);

  if (!iv) throw new Error("Interview not found.");
  if (iv.status !== "pending") throw new Error(`Already ${iv.status}.`);

  await db
    .update(interviewRequestsTable)
    .set({ status: "approved", resolvedAt: new Date(), resolvedBy: adminId })
    .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)));

  await addBalance(iv.discordId, amount, guildId);
  await logTransaction(
    iv.discordId,
    amount,
    "addcoins",
    `Interview approved (edited) (Week ${iv.week ?? "?"})`,
    guildId,
    adminId,
  );

  client.users
    .fetch(iv.discordId)
    .then(u =>
      u.send(
        `🎙️ Your Week ${iv.week ?? "?"} interview was approved with an adjusted amount! **+${amount} coins** added.`,
      ).catch(() => null),
    )
    .catch(() => null);

  return `✅ Interview #${id} approved (edited) — **+${amount} coins** → <@${iv.discordId}>`;
}

// ── Edit modal builders ──────────────────────────────────────────────────────

function buildEditAmountModal(kind: "payout" | "interview" | "channel", id: number, currentAmount: number): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`co_modal_edit_${kind}:${id}`)
    .setTitle(`Edit ${kind} amount`);

  const input = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Amount (coins)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(currentAmount))
    .setMinLength(1)
    .setMaxLength(10);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

// ── Main interaction dispatcher ───────────────────────────────────────────────

export async function handleCommOfficeInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;

  // ── co_main: show Commissioner's Office main screen
  if (customId === "co_main") {
    await interaction.update({
      embeds: [buildCommOfficeEmbed()],
      components: buildCommOfficeRows(),
    });
    return;
  }

  // ── Selector pages
  if (customId.startsWith("co_payouts:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildPayoutsPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }
  if (customId.startsWith("co_purchases:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildPurchasesPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }
  if (customId.startsWith("co_interviews:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildInterviewsPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }
  if (customId.startsWith("co_channel:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildChannelPayoutsPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }
  if (customId.startsWith("co_history:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildHistoryPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  // ── Edit buttons — open a modal (cannot deferUpdate before showModal)
  if (customId.startsWith("co_edit_payout:")) {
    const id = parseInt(customId.split(":")[1] ?? "0", 10);
    if (isNaN(id)) return;
    const [req] = await db
      .select()
      .from(payoutRequestsTable)
      .where(eq(payoutRequestsTable.id, id))
      .limit(1);
    if (!req) {
      await interaction.reply({ content: "❌ Payout not found.", ephemeral: true });
      return;
    }
    const defaultAmount = await getPayoutValue(
      req.gameType === "cpu" ? PAYOUT_KEYS.CPU_WIN : PAYOUT_KEYS.H2H_WIN,
      guildId,
    );
    await interaction.showModal(buildEditAmountModal("payout", id, defaultAmount));
    return;
  }
  if (customId.startsWith("co_edit_interview:")) {
    const id = parseInt(customId.split(":")[1] ?? "0", 10);
    if (isNaN(id)) return;
    const [iv] = await db
      .select()
      .from(interviewRequestsTable)
      .where(and(eq(interviewRequestsTable.id, id), eq(interviewRequestsTable.guildId, guildId)))
      .limit(1);
    if (!iv) {
      await interaction.reply({ content: "❌ Interview not found.", ephemeral: true });
      return;
    }
    const defaultAmount = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, guildId);
    await interaction.showModal(buildEditAmountModal("interview", id, defaultAmount));
    return;
  }
  if (customId.startsWith("co_edit_channel:")) {
    const id = parseInt(customId.split(":")[1] ?? "0", 10);
    if (isNaN(id)) return;
    const [row] = await db
      .select()
      .from(pendingChannelPayoutsTable)
      .where(and(eq(pendingChannelPayoutsTable.id, id), eq(pendingChannelPayoutsTable.guildId, guildId)))
      .limit(1);
    if (!row) {
      await interaction.reply({ content: "❌ Channel payout not found.", ephemeral: true });
      return;
    }
    await interaction.showModal(buildEditAmountModal("channel", id, row.amount));
    return;
  }

  // ── Action buttons — parse prefix:id  (e.g. "co_approve_payout:42")
  const colonIdx = customId.indexOf(":");
  if (colonIdx === -1) return;
  const prefix = customId.slice(0, colonIdx);
  const id = parseInt(customId.slice(colonIdx + 1), 10);
  if (isNaN(id)) return;

  await interaction.deferUpdate();

  let resultMsg: string;

  try {
    switch (prefix) {
      case "co_approve_payout":
        resultMsg = await doApprovePayoutRequest(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_deny_payout":
        resultMsg = await doDenyPayoutRequest(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_approve_purchase":
        resultMsg = await doApprovePurchase(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_refund_purchase":
        resultMsg = await doRefundPurchase(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_approve_interview":
        resultMsg = await doApproveInterview(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_deny_interview":
        resultMsg = await doDenyInterview(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_approve_channel":
        resultMsg = await doApproveChannelPayout(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_deny_channel":
        resultMsg = await doDenyChannelPayout(id, guildId, interaction.user.id, interaction.client);
        break;
      default:
        return;
    }
  } catch (err) {
    await interaction
      .followUp({ content: `❌ Action failed: ${err instanceof Error ? err.message : String(err)}`, ephemeral: true })
      .catch(() => null);
    return;
  }

  await rerenderAfterAction(interaction, prefix, guildId, resultMsg);
}

async function rerenderAfterAction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  prefix: string,
  guildId: string,
  resultMsg: string,
): Promise<void> {
  try {
    let embed: EmbedBuilder;
    let rows: ActionRowBuilder<ButtonBuilder>[];

    if (prefix.includes("channel")) {
      ({ embed, rows } = await buildChannelPayoutsPage(guildId, 0));
    } else if (prefix.includes("payout")) {
      ({ embed, rows } = await buildPayoutsPage(guildId, 0));
    } else if (prefix.includes("purchase")) {
      ({ embed, rows } = await buildPurchasesPage(guildId, 0));
    } else {
      ({ embed, rows } = await buildInterviewsPage(guildId, 0));
    }

    await interaction.editReply({ embeds: [embed], components: rows });
    await interaction
      .followUp({ content: resultMsg, ephemeral: true })
      .catch(() => null);
  } catch (err) {
    console.error("[CommOffice] Re-render failed:", err);
  }
}

// ── Modal submit dispatcher ───────────────────────────────────────────────────

export async function handleCommOfficeModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;
  const guildId = interaction.guildId!;

  // co_modal_edit_<kind>:<id>
  const m = /^co_modal_edit_(payout|interview|channel):(\d+)$/.exec(customId);
  if (!m) return;

  const kind = m[1] as "payout" | "interview" | "channel";
  const id = parseInt(m[2], 10);

  const raw = interaction.fields.getTextInputValue("amount").trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount < 0 || amount > 999999) {
    await interaction.reply({ content: "❌ Invalid amount.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  let resultMsg: string;
  let prefix: string;

  try {
    if (kind === "payout") {
      resultMsg = await doApprovePayoutWithOverride(id, guildId, interaction.user.id, interaction.client, amount);
      prefix = "co_approve_payout";
    } else if (kind === "interview") {
      resultMsg = await doApproveInterviewWithOverride(id, guildId, interaction.user.id, interaction.client, amount);
      prefix = "co_approve_interview";
    } else {
      resultMsg = await doApproveChannelPayout(id, guildId, interaction.user.id, interaction.client, amount);
      prefix = "co_approve_channel";
    }
  } catch (err) {
    await interaction
      .followUp({ content: `❌ Edit failed: ${err instanceof Error ? err.message : String(err)}`, ephemeral: true })
      .catch(() => null);
    return;
  }

  await rerenderAfterAction(interaction, prefix, guildId, resultMsg);
}
