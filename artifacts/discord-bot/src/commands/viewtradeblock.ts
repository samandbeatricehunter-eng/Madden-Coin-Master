import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { tradeBlockListingsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateActiveSeason, isAdminUser } from "../lib/db-helpers.js";
import { devBadge } from "../lib/dev-trait.js";
import { getServerSettings } from "../lib/server-settings.js";
import { formatPickInfo } from "./tradeblock.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 4; // max content rows per page (leaving 1 row for navigation)

// ── Types ─────────────────────────────────────────────────────────────────────

type TradeItem =
  | { type: "player"; firstName: string; lastName: string; position: string; overall: number; devTrait: number; playerId: number }
  | { type: "pick";   description: string }
  | { type: "coins";  amount: number };

type CombinedEntry =
  | { kind: "listing"; id: number; discordId: string; teamName: string; items: TradeItem[]; notes: string | null };

// ── Helpers ────────────────────────────────────────────────────────────────────


function itemLine(item: TradeItem): string {
  if (item.type === "player") return `🏈 **${item.firstName} ${item.lastName}** (${item.position}) OVR ${item.overall}${devBadge(item.devTrait)}`;
  if (item.type === "pick")   return `📋 ${item.description}`;
  return `💰 ${item.amount.toLocaleString()} coins`;
}

function formatListingField(entry: Extract<CombinedEntry, { kind: "listing" }>): string {
  const lines = entry.items.map(itemLine).join("\n");
  const footer = entry.notes ? `\n🔎 *Looking for: ${entry.notes}*` : "";
  return lines + footer;
}

// ── Page builder (exported so interaction handler can reuse it) ────────────────

export async function buildPageResponse(
  viewerId: string,
  page: number,
  isAdminMode: boolean,
  seasonId: number,
): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[]; totalPages: number }> {
  // Fetch all active listings for this season
  const listings = await db.select().from(tradeBlockListingsTable)
    .where(and(eq(tradeBlockListingsTable.seasonId, seasonId), eq(tradeBlockListingsTable.status, "active")))
    .orderBy(desc(tradeBlockListingsTable.createdAt));

  const combined: CombinedEntry[] = listings.map(l => ({
    kind:      "listing" as const,
    id:        l.id,
    discordId: l.discordId,
    teamName:  l.teamName,
    items:     l.items as TradeItem[],
    notes:     l.notes ?? null,
  }));

  const totalPages = Math.max(1, Math.ceil(combined.length / PAGE_SIZE));
  const safePage   = Math.min(Math.max(0, page), totalPages - 1);
  const pageItems  = combined.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // ── Build embed ───────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("📋 Trade Block")
    .setDescription(
      combined.length === 0
        ? "*The trade block is empty right now — use `/tradeblock add` to post a listing.*"
        : `Page **${safePage + 1}** of **${totalPages}** · 🔄 ${listings.length} listing${listings.length !== 1 ? "s" : ""} active`,
    )
    .setFooter({ text: isAdminMode ? "🔧 Admin Mode — Remove buttons visible" : "Use /tradeblock add to list your own assets" })
    .setTimestamp();

  for (const entry of pageItems) {
    embed.addFields({
      name:  `🔄 **${entry.teamName}**`,
      value: formatListingField(entry).slice(0, 1024),
      inline: false,
    });
  }

  // ── Build button rows ─────────────────────────────────────────────────────
  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  pageItems.forEach(entry => {
    const isOwn = entry.discordId === viewerId;
    const row   = new ActionRowBuilder<ButtonBuilder>();

    if (isOwn) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tb_cancel:${entry.id}`)
          .setLabel("🚫 Cancel My Listing")
          .setStyle(ButtonStyle.Danger),
      );
    } else {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tb_offer:${entry.id}:${entry.discordId}`)
          .setLabel(`📨 Send Offer (${entry.teamName})`)
          .setStyle(ButtonStyle.Success),
      );
    }

    if (isAdminMode) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tb_rm:${entry.id}`)
          .setLabel("🗑️ Remove")
          .setStyle(ButtonStyle.Secondary),
      );
    }

    components.push(row);
  });

  // ── Navigation row ────────────────────────────────────────────────────────
  const adminFlag = isAdminMode ? "1" : "0";
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tb_page:${safePage - 1}:${adminFlag}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`tb_page:${safePage + 1}:${adminFlag}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId("tb_close_view")
      .setLabel("✖ Close")
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(navRow);

  return { embed, components, totalPages };
}

// ── Command ───────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewtradeblock")
  .setDescription("Browse active trade block listings and send offers")
  .addBooleanOption(o =>
    o.setName("public")
      .setDescription("Show the trade block to everyone in this channel (default: only you see it)")
  )
  .addBooleanOption(o =>
    o.setName("admin")
      .setDescription("Admin mode: show Remove buttons on every listing (commissioners only)")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.tradeBlockEnabled) {
    await interaction.reply({ content: "❌ The trade block is currently disabled by the commissioners.", ephemeral: true });
    return;
  }

  const isPublic      = interaction.options.getBoolean("public") ?? false;
  const wantsAdmin    = interaction.options.getBoolean("admin") ?? false;
  const isAdminMode   = wantsAdmin && await isAdminUser(interaction.user.id, interaction.guildId!);

  if (wantsAdmin && !isAdminMode) {
    await interaction.reply({ content: "❌ Admin mode is restricted to league commissioners.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: !isPublic });

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const { embed, components } = await buildPageResponse(interaction.user.id, 0, isAdminMode, season.id);

  await interaction.editReply({ embeds: [embed], components });
}
