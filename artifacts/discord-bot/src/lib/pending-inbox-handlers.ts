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
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  addBalance,
  logTransaction,
} from "./db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 3;

// ── Commissioner's Office main menu ──────────────────────────────────────────

export function buildCommOfficeEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xB68B2D)
    .setTitle("🏛️ Commissioner's Office — Pending Inbox")
    .setDescription(
      "Select a category to review and act on pending items.\n\n" +
      "**📋 Pending Payouts** — User-submitted score reports\n" +
      "**🛒 Pending Purchases** — Store purchases awaiting in-game application\n" +
      "**🎙️ Pending Interviews** — Post-game interviews awaiting review"
    )
    .setFooter({ text: "Actions are immediate. Users receive a DM on approve/deny." })
    .setTimestamp();
}

export function buildCommOfficeRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("co_payouts:0").setLabel("📋 Pending Payouts").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("co_purchases:0").setLabel("🛒 Pending Purchases").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("co_interviews:0").setLabel("🎙️ Pending Interviews").setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_admin_root").setLabel("↩ Back").setStyle(ButtonStyle.Secondary),
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

// ── Action implementations ────────────────────────────────────────────────────
// These functions throw on failure so the dispatcher can handle the error
// uniformly with followUp() after deferUpdate().

async function doApprovePayoutRequest(
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
  adminId: string,
  client: Client,
): Promise<string> {
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
    .where(eq(interviewRequestsTable.id, id))
    .limit(1);

  if (!iv) throw new Error("Interview not found.");
  if (iv.status !== "pending") throw new Error(`Already ${iv.status}.`);

  const amount = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, guildId);

  await db
    .update(interviewRequestsTable)
    .set({ status: "approved", resolvedAt: new Date(), resolvedBy: adminId })
    .where(eq(interviewRequestsTable.id, id));

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
  adminId: string,
  client: Client,
): Promise<string> {
  const [iv] = await db
    .select()
    .from(interviewRequestsTable)
    .where(eq(interviewRequestsTable.id, id))
    .limit(1);

  if (!iv) throw new Error("Interview not found.");
  if (iv.status !== "pending") throw new Error(`Already ${iv.status}.`);

  await db
    .update(interviewRequestsTable)
    .set({ status: "denied", resolvedAt: new Date(), resolvedBy: adminId })
    .where(eq(interviewRequestsTable.id, id));

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

  // ── co_payouts:PAGE
  if (customId.startsWith("co_payouts:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildPayoutsPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  // ── co_purchases:PAGE
  if (customId.startsWith("co_purchases:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildPurchasesPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  // ── co_interviews:PAGE
  if (customId.startsWith("co_interviews:")) {
    const page = Math.max(0, parseInt(customId.split(":")[1] ?? "0", 10));
    const { embed, rows } = await buildInterviewsPage(guildId, page);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  // ── Action buttons — parse prefix:id  (e.g. "co_approve_payout:42")
  const colonIdx = customId.indexOf(":");
  if (colonIdx === -1) return;
  const prefix = customId.slice(0, colonIdx);
  const id = parseInt(customId.slice(colonIdx + 1), 10);
  if (isNaN(id)) return;

  // Defer the component update so we can do async DB work before replying
  await interaction.deferUpdate();

  let resultMsg: string;

  try {
    switch (prefix) {
      case "co_approve_payout":
        resultMsg = await doApprovePayoutRequest(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_deny_payout":
        resultMsg = await doDenyPayoutRequest(id, interaction.user.id, interaction.client);
        break;
      case "co_approve_purchase":
        resultMsg = await doApprovePurchase(id, interaction.user.id, interaction.client);
        break;
      case "co_refund_purchase":
        resultMsg = await doRefundPurchase(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_approve_interview":
        resultMsg = await doApproveInterview(id, guildId, interaction.user.id, interaction.client);
        break;
      case "co_deny_interview":
        resultMsg = await doDenyInterview(id, interaction.user.id, interaction.client);
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

  // Re-render the appropriate page after the action, and surface the result
  try {
    let embed: EmbedBuilder;
    let rows: ActionRowBuilder<ButtonBuilder>[];

    if (prefix.includes("payout")) {
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
