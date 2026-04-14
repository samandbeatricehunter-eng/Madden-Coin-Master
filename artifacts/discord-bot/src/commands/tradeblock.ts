import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  AutocompleteInteraction, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, franchiseRostersTable, tradeBlockListingsTable, tradeBlockISOTable,
} from "@workspace/db";
import { eq, and, count, desc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";
import { logTradeEvent } from "../lib/league-twitter.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const ANNOUNCEMENT_CHANNEL_ID = "1476321282868908052";
const MAX_ACTIVE_LISTINGS      = 3;

const MADDEN_POSITIONS = [
  "QB","HB","FB","WR","TE","LT","LG","C","RG","RT",
  "LE","RE","DT","LOLB","MLB","ROLB","CB","FS","SS","K","P",
];

// ── Dev badge helpers ─────────────────────────────────────────────────────────

function devBadge(d: number) {
  if (d >= 3) return " ⚡";
  if (d === 2) return " ★★";
  if (d === 1) return " ★";
  return "";
}

function devLabel(d: number) {
  if (d >= 3) return "X-Factor";
  if (d === 2) return "Superstar";
  if (d === 1) return "Star";
  return "Normal";
}

// ── Trade item types ──────────────────────────────────────────────────────────

type TradeItem =
  | { type: "player"; firstName: string; lastName: string; position: string; overall: number; devTrait: number; playerId: number }
  | { type: "pick";   description: string }
  | { type: "coins";  amount: number };

export function formatPickInfo(pi: { round: string; qty?: number | null; year?: number | null }): string {
  const qtyStr  = (pi.qty && pi.qty > 1) ? `${pi.qty}x ` : "";
  const roundStr = pi.round === "any" ? "any round" : `Round ${pi.round}`;
  const yearStr  = pi.year ? ` in ${pi.year}` : "";
  return `📋 ${qtyStr}${roundStr} pick${pi.qty && pi.qty > 1 ? "s" : ""}${yearStr}`;
}

function itemLine(item: TradeItem): string {
  if (item.type === "player") return `🏈 **${item.firstName} ${item.lastName}** (${item.position}) OVR ${item.overall}${devBadge(item.devTrait)}`;
  if (item.type === "pick")   return `📋 ${item.description}`;
  return `💰 ${item.amount.toLocaleString()} coins`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePlayerOption(raw: string | null): TradeItem | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length < 5) return null;
  const [pidStr, name, pos, ovrStr, devStr] = parts as [string,string,string,string,string];
  const nameParts = name.trim().split(" ");
  return {
    type:      "player",
    playerId:  parseInt(pidStr, 10),
    firstName: nameParts.slice(0, -1).join(" ") || name,
    lastName:  nameParts.at(-1) ?? "",
    position:  pos,
    overall:   parseInt(ovrStr, 10),
    devTrait:  parseInt(devStr, 10),
  };
}

export async function getMyTeam(discordId: string): Promise<string> {
  const rows = await db.select({ team: usersTable.team }).from(usersTable)
    .where(eq(usersTable.discordId, discordId)).limit(1);
  return rows[0]?.team ?? "Unknown Team";
}

async function getActiveListingCount(discordId: string, seasonId: number): Promise<number> {
  const rows = await db.select({ c: count() }).from(tradeBlockListingsTable)
    .where(and(
      eq(tradeBlockListingsTable.discordId, discordId),
      eq(tradeBlockListingsTable.seasonId, seasonId),
      eq(tradeBlockListingsTable.status, "active"),
    ));
  return rows[0]?.c ?? 0;
}

async function postAnnouncement(
  client: ChatInputCommandInteraction["client"],
  teamName: string,
  items: TradeItem[],
  notes: string | null,
  isISO: boolean,
  isoSeeking?: string,
) {
  try {
    const ch = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
    if (!ch?.isTextBased()) return;

    let description: string;
    if (isISO) {
      description =
        `🔍 **${teamName}** is **In Search Of**: ${isoSeeking ?? "various assets"}\n` +
        (items.length ? `📤 **Offering:** ${items.map(itemLine).join(", ")}\n` : "") +
        `\nUse \`/viewtradeblock\` to browse listings and respond to this ISO!`;
    } else {
      const offeringText = items.map(itemLine).join("\n");
      description =
        `📦 **Offering:**\n${offeringText}\n` +
        (notes ? `\n🔎 **Looking For:** ${notes}\n` : "\n") +
        `\nUse \`/viewtradeblock\` to browse listings and send an offer!`;
    }

    const embed = new EmbedBuilder()
      .setColor(isISO ? Colors.Purple : Colors.Blue)
      .setTitle(isISO ? `🔍 ISO — ${teamName}` : `🔄 Trade Block — ${teamName}`)
      .setDescription(description)
      .setTimestamp();

    await (ch as TextChannel).send({ content: "@everyone", embeds: [embed] });
  } catch (_) {}
}

// ── Command definition ────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("tradeblock")
  .setDescription("Manage your trade block listings")

  // ── add ────────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Post items to the trade block (up to 3 active listings, 7 players/picks each)")
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Draft pick to offer, e.g. '2027 Round 1' or '2026 Round 2 (from Raiders)'"))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)"))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)"))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins to include").setMinValue(1))
      .addStringOption(o => o.setName("looking_for").setDescription("What you want in return (describes to other managers)"))
  )

  // ── remove ─────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove one of your active trade block listings")
      .addStringOption(o =>
        o.setName("listing")
          .setDescription("Select the listing to remove")
          .setAutocomplete(true)
          .setRequired(true)
      )
  )

  // ── update ─────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("update")
      .setDescription("Update one of your trade block listings with new items")
      .addStringOption(o =>
        o.setName("listing")
          .setDescription("Select the listing to update")
          .setAutocomplete(true)
          .setRequired(true)
      )
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Draft pick to offer, e.g. '2027 Round 1' or '2026 Round 2 (from Raiders)'"))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)"))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)"))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins to include").setMinValue(1))
      .addStringOption(o => o.setName("looking_for").setDescription("What you want in return"))
  )

  // ── iso ────────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("iso")
      .setDescription("Post an ISO — specify what you're looking for and what you'll offer in return")
      // What you're seeking
      .addStringOption(o =>
        o.setName("seeking_pos1")
          .setDescription("Position you're looking for (required unless seeking picks)")
          .addChoices(...MADDEN_POSITIONS.map(p => ({ name: p, value: p })))
      )
      .addStringOption(o =>
        o.setName("seeking_pos2")
          .setDescription("2nd position (optional)")
          .addChoices(...MADDEN_POSITIONS.map(p => ({ name: p, value: p })))
      )
      .addStringOption(o =>
        o.setName("seeking_pos3")
          .setDescription("3rd position (optional)")
          .addChoices(...MADDEN_POSITIONS.map(p => ({ name: p, value: p })))
      )
      .addStringOption(o =>
        o.setName("seeking_picks")
          .setDescription("Pick round(s) you're looking for (or 'Any round')")
          .addChoices(
            { name: "Any round",   value: "any" },
            { name: "Round 1",     value: "1" },
            { name: "Round 2",     value: "2" },
            { name: "Round 3",     value: "3" },
            { name: "Round 4",     value: "4" },
            { name: "Round 5",     value: "5" },
            { name: "Round 6",     value: "6" },
            { name: "Round 7",     value: "7" },
          )
      )
      .addIntegerOption(o =>
        o.setName("seeking_pick_qty")
          .setDescription("How many of those picks are you looking for? (default: 1)")
          .setMinValue(1)
          .setMaxValue(5)
      )
      .addIntegerOption(o =>
        o.setName("seeking_pick_year")
          .setDescription("Specific draft year for those picks (e.g. 2028), leave blank for any year")
          .setMinValue(2025)
          .setMaxValue(2035)
      )
      .addBooleanOption(o =>
        o.setName("seeking_coins")
          .setDescription("Are you also looking for coins?")
      )
      // What you're offering in return (same autocomplete as regular listing)
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster you're offering").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Pick you're offering, e.g. '2027 Round 1' or '2026 Round 2 (from Raiders)'"))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)"))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)"))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins you're offering in return").setMinValue(1))
      .addStringOption(o => o.setName("notes").setDescription("Any additional details about what you're seeking"))
  )

  // ── send-offer ─────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("send-offer")
      .setDescription("Send a direct trade offer DM to another user")
      .addUserOption(o => o.setName("to").setDescription("The user you want to trade with").setRequired(true))
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  const query   = (focused.value as string).toLowerCase();

  // Player autocomplete — covers add, update, iso, send-offer
  if (["player1","player2","player3","player4","player5"].includes(focused.name)) {
    const season = await getOrCreateActiveSeason(interaction.guildId!);
    const rosterRows = await db.select({
      playerId:  franchiseRostersTable.playerId,
      firstName: franchiseRostersTable.firstName,
      lastName:  franchiseRostersTable.lastName,
      position:  franchiseRostersTable.position,
      overall:   franchiseRostersTable.overall,
      devTrait:  franchiseRostersTable.devTrait,
    })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.discordId, interaction.user.id),
      ))
      .limit(200);

    const filtered = query
      ? rosterRows.filter(p => `${p.firstName} ${p.lastName}`.toLowerCase().includes(query) || p.position.toLowerCase().includes(query))
      : rosterRows;

    await interaction.respond(
      filtered.slice(0, 25).map(p => ({
        name:  `${p.firstName} ${p.lastName} (${p.position}) OVR ${p.overall} — ${devLabel(p.devTrait)}`.slice(0, 100),
        value: `${p.playerId}|${p.firstName} ${p.lastName}|${p.position}|${p.overall}|${p.devTrait}`.slice(0, 100),
      }))
    ).catch(() => {});
    return;
  }

  // Listing autocomplete — for remove/update
  if (focused.name === "listing") {
    const season   = await getOrCreateActiveSeason(interaction.guildId!);
    const listings = await db.select().from(tradeBlockListingsTable)
      .where(and(
        eq(tradeBlockListingsTable.discordId, interaction.user.id),
        eq(tradeBlockListingsTable.seasonId, season.id),
        eq(tradeBlockListingsTable.status, "active"),
      ))
      .limit(25);

    const choices = listings
      .filter(l => {
        if (!query) return true;
        const items  = l.items as TradeItem[];
        const first  = items[0];
        const label  = first?.type === "player"
          ? `${first.firstName} ${first.lastName}`
          : first?.type === "pick" ? first.description
          : first?.type === "coins" ? `${first.amount} coins` : "";
        return label.toLowerCase().includes(query);
      })
      .map(l => {
        const items = l.items as TradeItem[];
        const parts = items.slice(0, 3).map(i => {
          if (i.type === "player") return `${i.firstName} ${i.lastName} (${i.position})`;
          if (i.type === "pick")   return i.description;
          return `${i.amount} coins`;
        });
        const label = `#${l.id}: ${parts.join(", ")}${items.length > 3 ? ` +${items.length - 3} more` : ""}`;
        return { name: label.slice(0, 100), value: String(l.id) };
      });

    await interaction.respond(choices).catch(() => {});
    return;
  }

  await interaction.respond([]).catch(() => {});
}

// ── Execute ───────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const settings = await getServerSettings();
  if (!settings.tradeBlockEnabled) {
    await interaction.reply({ content: "❌ The trade block is currently disabled by the commissioners.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === "add")        return handleAdd(interaction);
  if (sub === "remove")     return handleRemove(interaction);
  if (sub === "update")     return handleUpdate(interaction);
  if (sub === "iso")        return handleISO(interaction);
  if (sub === "send-offer") return handleSendOffer(interaction);
}

// ── /tradeblock add ───────────────────────────────────────────────────────────

async function handleAdd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season   = await getOrCreateActiveSeason(interaction.guildId!);
  const teamName = await getMyTeam(interaction.user.id);

  // Enforce 3-listing cap
  const activeCount = await getActiveListingCount(interaction.user.id, season.id);
  if (activeCount >= MAX_ACTIVE_LISTINGS) {
    await interaction.editReply({
      content: `❌ You already have **${activeCount}** active listing${activeCount > 1 ? "s" : ""} on the block. Remove or update an existing one first (max ${MAX_ACTIVE_LISTINGS} at a time).`,
    });
    return;
  }

  const items: TradeItem[] = [];
  for (const key of ["player1","player2","player3","player4","player5"] as const) {
    const p = parsePlayerOption(interaction.options.getString(key));
    if (p) items.push(p);
  }
  for (const key of ["pick1","pick2","pick3"] as const) {
    const desc = interaction.options.getString(key)?.trim();
    if (desc) items.push({ type: "pick", description: desc });
  }
  const coins = interaction.options.getInteger("coins");
  if (coins) items.push({ type: "coins", amount: coins });

  if (items.length === 0) {
    await interaction.editReply({ content: "❌ You must include at least one player, pick, or coin amount." });
    return;
  }
  if (items.filter(i => i.type !== "coins").length > 7) {
    await interaction.editReply({ content: "❌ You can list at most 7 players/picks per trade. Coins don't count toward this limit." });
    return;
  }

  const notes = interaction.options.getString("looking_for");

  const [inserted] = await db.insert(tradeBlockListingsTable).values({
    discordId: interaction.user.id,
    teamName,
    seasonId:  season.id,
    items,
    notes,
    status:    "active",
  }).returning({ id: tradeBlockListingsTable.id });

  const listingId = inserted!.id;

  await interaction.editReply({
    content: `✅ Listing #${listingId} posted! Use \`/viewtradeblock\` to see it on the block.`,
  });

  void logTradeEvent({
    seasonId:  season.id,
    eventType: "listing_posted",
    summary:   `${teamName} posted a trade block listing (Listing #${listingId})${notes ? ` — looking for: ${notes}` : ""}`,
    teamA:     teamName,
  });

  // Announce to general channel
  await postAnnouncement(interaction.client, teamName, items, notes ?? null, false);
}

// ── /tradeblock remove ────────────────────────────────────────────────────────

async function handleRemove(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const listingId = parseInt(interaction.options.getString("listing", true), 10);
  const season    = await getOrCreateActiveSeason(interaction.guildId!);

  const [listing] = await db.select().from(tradeBlockListingsTable)
    .where(and(
      eq(tradeBlockListingsTable.id, listingId),
      eq(tradeBlockListingsTable.discordId, interaction.user.id),
      eq(tradeBlockListingsTable.seasonId, season.id),
      eq(tradeBlockListingsTable.status, "active"),
    )).limit(1);

  if (!listing) {
    await interaction.editReply({ content: "❌ Listing not found or already removed." });
    return;
  }

  // Ask if a deal was reached before removing
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
  const dealRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tb_deal_yes:${listingId}:L`)
      .setLabel("✅ Yes — We made a deal")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tb_deal_no:${listingId}:L`)
      .setLabel("❌ No deal, just remove")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: "🤝 **Was a trade deal reached through this listing?**\nIf yes, we'll announce it to the server!",
    components: [dealRow],
  });
}

// ── /tradeblock update ────────────────────────────────────────────────────────

async function handleUpdate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const listingId = parseInt(interaction.options.getString("listing", true), 10);
  const season    = await getOrCreateActiveSeason(interaction.guildId!);
  const teamName  = await getMyTeam(interaction.user.id);

  const [listing] = await db.select().from(tradeBlockListingsTable)
    .where(and(
      eq(tradeBlockListingsTable.id, listingId),
      eq(tradeBlockListingsTable.discordId, interaction.user.id),
      eq(tradeBlockListingsTable.seasonId, season.id),
      eq(tradeBlockListingsTable.status, "active"),
    )).limit(1);

  if (!listing) {
    await interaction.editReply({ content: "❌ Listing not found or already removed." });
    return;
  }

  const items: TradeItem[] = [];
  for (const key of ["player1","player2","player3","player4","player5"] as const) {
    const p = parsePlayerOption(interaction.options.getString(key));
    if (p) items.push(p);
  }
  for (const key of ["pick1","pick2","pick3"] as const) {
    const desc = interaction.options.getString(key)?.trim();
    if (desc) items.push({ type: "pick", description: desc });
  }
  const coins = interaction.options.getInteger("coins");
  if (coins) items.push({ type: "coins", amount: coins });

  const finalItems = items.length > 0 ? items : (listing.items as TradeItem[]);
  const finalNotes = interaction.options.getString("looking_for") ?? listing.notes ?? null;

  if (finalItems.filter(i => i.type !== "coins").length > 7) {
    await interaction.editReply({ content: "❌ You can list at most 7 players/picks per trade. Coins don't count toward this limit." });
    return;
  }

  await db.update(tradeBlockListingsTable)
    .set({ items: finalItems, notes: finalNotes })
    .where(eq(tradeBlockListingsTable.id, listingId));

  await interaction.editReply({ content: `✅ Listing #${listingId} updated! Use \`/viewtradeblock\` to see it.` });
}

// ── /tradeblock iso ───────────────────────────────────────────────────────────

async function handleISO(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season   = await getOrCreateActiveSeason(interaction.guildId!);
  const teamName = await getMyTeam(interaction.user.id);

  // Seeking
  const pos1         = interaction.options.getString("seeking_pos1") ?? null;
  const pos2         = interaction.options.getString("seeking_pos2") ?? null;
  const pos3         = interaction.options.getString("seeking_pos3") ?? null;
  const picksRound   = interaction.options.getString("seeking_picks") ?? null;   // "any" | "1"-"7" | null
  const picksQty     = interaction.options.getInteger("seeking_pick_qty") ?? 1;
  const picksYear    = interaction.options.getInteger("seeking_pick_year") ?? null;
  const wantsCoins   = interaction.options.getBoolean("seeking_coins") ?? false;

  const positions: string[] = [pos1, pos2, pos3].filter(Boolean) as string[];

  if (positions.length === 0 && !picksRound) {
    await interaction.editReply({ content: "❌ You must specify at least a position **or** a pick round you're looking for." });
    return;
  }
  const pickInfo = picksRound ? { round: picksRound, qty: picksQty, year: picksYear } : undefined;

  const seekingDetails = { positions, pickInfo, wantsCoins };
  const seekingType    = "multi";

  // Offering (same autocomplete as regular listing)
  const offeringItems: TradeItem[] = [];
  for (const key of ["player1","player2","player3","player4","player5"] as const) {
    const p = parsePlayerOption(interaction.options.getString(key));
    if (p) offeringItems.push(p);
  }
  for (const key of ["pick1","pick2","pick3"] as const) {
    const desc = interaction.options.getString(key)?.trim();
    if (desc) offeringItems.push({ type: "pick", description: desc });
  }
  const offerCoins = interaction.options.getInteger("coins");
  if (offerCoins) offeringItems.push({ type: "coins", amount: offerCoins });

  if (offeringItems.length === 0) {
    await interaction.editReply({ content: "❌ You must include at least one item you're offering in return (player, pick, or coins)." });
    return;
  }

  const notes = interaction.options.getString("notes");

  // Build seeking summary for display / announcement
  const seekingParts: string[] = [];
  if (positions.length) seekingParts.push(positions.join(", "));
  if (pickInfo)          seekingParts.push(formatPickInfo(pickInfo));
  if (wantsCoins)        seekingParts.push("💰 Coins");
  const seekingSummary = seekingParts.join(" · ");

  const [inserted] = await db.insert(tradeBlockISOTable).values({
    discordId:      interaction.user.id,
    teamName,
    seasonId:       season.id,
    seekingType,
    seekingDetails,
    offering:       { items: offeringItems },
    status:         "active",
  }).returning({ id: tradeBlockISOTable.id });

  const isoId = inserted!.id;

  await interaction.editReply({
    content: `✅ ISO #${isoId} posted! Use \`/viewtradeblock\` to see it on the block.`,
  });

  void logTradeEvent({
    seasonId:  season.id,
    eventType: "iso_posted",
    summary:   `${teamName} posted an ISO (seeking: ${seekingSummary || seekingType})`,
    teamA:     teamName,
  });

  // Announce to general channel
  await postAnnouncement(interaction.client, teamName, offeringItems, notes ?? null, true, seekingSummary);
}

// ── /tradeblock send-offer — shared state & page builder ─────────────────────

export interface SoPlayerRow {
  playerId:  string;
  firstName: string;
  lastName:  string;
  position:  string;
  overall:   number;
}

export interface SoState {
  targetId: string;
  players:  SoPlayerRow[];
  selected: Set<string>;   // Set of playerId strings
  page:     number;
}

/** In-memory session store. Key: `${senderDiscordId}:${targetDiscordId}` */
export const sendOfferState = new Map<string, SoState>();

// Max players shown on one page. 15 = 3 action rows × 5 buttons, leaving 2 rows for nav + done.
const SO_PAGE_SIZE = 15;
// If roster fits on a single page with no nav bar needed, we can use up to 20 (4 rows).
const SO_SINGLE_PAGE_MAX = 20;

/**
 * Builds the ephemeral reply for the current page of the roster toggle UI.
 * Returns `content` and `components` ready for `interaction.editReply()` or `interaction.update()`.
 */
export function buildSendOfferPage(
  state: SoState,
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const { players, selected, page, targetId } = state;

  const needsPages  = players.length > SO_SINGLE_PAGE_MAX;
  const pageSize    = needsPages ? SO_PAGE_SIZE : players.length;
  const totalPages  = needsPages ? Math.ceil(players.length / SO_PAGE_SIZE) : 1;
  const pageStart   = page * pageSize;
  const pagePlayers = players.slice(pageStart, pageStart + pageSize);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  // ── Player toggle buttons (5 per row) ───────────────────────────────────────
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  for (let i = 0; i < pagePlayers.length; i++) {
    const p         = pagePlayers[i];
    const isSel     = selected.has(p.playerId);
    const initial   = p.firstName.charAt(0).toUpperCase();
    // Keep label short: "☐ J. Jefferson (WR) 98"  — safely within 80-char limit
    const nameStr   = `${initial}. ${p.lastName}`.slice(0, 22);
    const label     = `${isSel ? "✅" : "☐"} ${nameStr} (${p.position}) ${p.overall}`.slice(0, 80);

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`so_tog:${targetId}:${p.playerId}`)
        .setLabel(label)
        .setStyle(isSel ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    if ((i + 1) % 5 === 0 || i === pagePlayers.length - 1) {
      components.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
    }
  }

  // ── Navigation row (only when paginating) ───────────────────────────────────
  if (needsPages) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`so_pg:${targetId}:prev`)
          .setLabel("◀ Prev")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`so_pg:${targetId}:info`)
          .setLabel(`Page ${page + 1} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`so_pg:${targetId}:next`)
          .setLabel("Next ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      ),
    );
  }

  // ── Continue / done row ──────────────────────────────────────────────────────
  const doneLabel = selected.size > 0
    ? `📤 Continue with ${selected.size} player${selected.size !== 1 ? "s" : ""} →`
    : "📝 Continue — No Players →";

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`so_done:${targetId}`)
        .setLabel(doneLabel)
        .setStyle(selected.size > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  // ── Content summary ──────────────────────────────────────────────────────────
  const selNames = [...selected].map(id => {
    const p = players.find(x => x.playerId === id);
    return p ? `${p.firstName} ${p.lastName} (${p.position})` : id;
  });

  const lines = [
    `📤 **Building a trade offer for <@${targetId}>**`,
    ``,
    `**Step 1 — Select Players You're Offering**`,
    `Toggle players on/off below (up to 7). Hit **Continue** when ready — you'll enter picks, coins & requests next.`,
  ];
  if (selected.size > 0) {
    lines.push(``, `✅ **Selected (${selected.size}/7):** ${selNames.join(", ")}`);
  }

  return { content: lines.join("\n"), components };
}

// ── /tradeblock send-offer ────────────────────────────────────────────────────
// Step 1: show paginated roster toggle UI.
// Each player is a button; clicking toggles selection.
// "Continue →" button opens the offer detail modal.

async function handleSendOffer(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("to", true);

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "❌ You can't send a trade offer to yourself.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const season     = await getOrCreateActiveSeason(interaction.guildId!);
  const rosterRows = await db.select({
    playerId:  franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    position:  franchiseRostersTable.position,
    overall:   franchiseRostersTable.overall,
  })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.discordId, interaction.user.id),
    ))
    .orderBy(desc(franchiseRostersTable.overall));

  // Empty roster — skip straight to the offer detail modal
  if (rosterRows.length === 0) {
    await interaction.editReply({
      content: `📤 Building a trade offer for <@${target.id}>. Your roster is empty — click below to fill in picks, coins, and what you want back.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`so_continue:${target.id}`)
            .setLabel("📝 No Players — Continue to Offer Details →")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // Convert to SoPlayerRow (playerId from DB is a number — store as string for Set membership)
  const players: SoPlayerRow[] = rosterRows.map(r => ({
    playerId:  String(r.playerId),
    firstName: r.firstName ?? "",
    lastName:  r.lastName  ?? "",
    position:  r.position  ?? "?",
    overall:   r.overall   ?? 0,
  }));

  const key: string = `${interaction.user.id}:${target.id}`;
  const state: SoState = { targetId: target.id, players, selected: new Set(), page: 0 };
  sendOfferState.set(key, state);

  // Auto-expire after 20 minutes
  setTimeout(() => { if (sendOfferState.get(key) === state) sendOfferState.delete(key); }, 20 * 60 * 1000);

  const { content, components } = buildSendOfferPage(state);
  await interaction.editReply({ content, components });
}
