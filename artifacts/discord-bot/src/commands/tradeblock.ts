import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, franchiseRostersTable, tradeBlockListingsTable, tradeBlockISOTable, franchiseDraftPicksTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

const TRADE_BLOCK_CHANNEL_ID = "1476975713734099067";

const MADDEN_POSITIONS = [
  "QB","HB","FB","WR","TE","LT","LG","C","RG","RT",
  "LE","RE","DT","LOLB","MLB","ROLB","CB","FS","SS","K","P",
];

// 0=Normal 1=Star 2=Superstar 3=X-Factor (per my-roster.ts)
function devBadge(d: number) {
  if (d >= 3) return " ⚡";
  if (d === 2) return " ★★★";
  if (d === 1) return " ★★";
  return "";
}

function devLabel(d: number) {
  if (d >= 3) return "X-Factor";
  if (d === 2) return "Superstar";
  if (d === 1) return "Star";
  return "Normal";
}

type TradeItem =
  | { type: "player"; firstName: string; lastName: string; position: string; overall: number; devTrait: number; playerId: number }
  | { type: "pick";   description: string }
  | { type: "coins";  amount: number };

function itemLine(item: TradeItem): string {
  if (item.type === "player") {
    return `🏈 **${item.firstName} ${item.lastName}** (${item.position}) — OVR ${item.overall}${devBadge(item.devTrait)}`;
  }
  if (item.type === "pick") return `📋 ${item.description}`;
  return `💰 ${item.amount.toLocaleString()} coins`;
}

function buildListingEmbed(teamName: string, items: TradeItem[], notes: string | null) {
  const offeringText = items.map(itemLine).join("\n");
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🔄 Trade Block — ${teamName}`)
    .addFields(
      { name: "📦 Offering", value: offeringText || "*Nothing listed*" },
      { name: "🔎 Looking For", value: notes || "*Open to offers*" },
    )
    .setTimestamp();
}

function buildISOEmbed(teamName: string, seekingType: string, seekingDetails: any, offering: any) {
  let seekingText = "";
  if (seekingType === "player_position") {
    seekingText = `**${seekingDetails.position ?? "?"}** position player`;
  } else if (seekingType === "draft_pick") {
    const rounds = (seekingDetails.rounds ?? []).join(", ");
    seekingText = `Draft picks (Round${(seekingDetails.rounds ?? []).length > 1 ? "s" : ""}: ${rounds || "?"})`;
  } else {
    seekingText = `${(seekingDetails.amount ?? 0).toLocaleString()} coins`;
  }

  const offeringLines: string[] = [];
  if (offering.players) offeringLines.push(`🏈 ${offering.players}`);
  if (offering.picks)   offeringLines.push(`📋 ${offering.picks}`);
  if (offering.coins)   offeringLines.push(`💰 ${offering.coins.toLocaleString()} coins`);

  return new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`🔍 ISO — ${teamName}`)
    .addFields(
      { name: "🎯 Seeking",        value: seekingText },
      { name: "📤 Offering Back",  value: offeringLines.join("\n") || "*Open to discussion*" },
    )
    .setTimestamp();
}

function buildListingButtons(listingId: number, posterDiscordId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tb_interested:${listingId}:${posterDiscordId}`)
      .setLabel("Interested!")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tb_close:${listingId}:${posterDiscordId}`)
      .setLabel("Close Negotiations")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildISOButtons(isoId: number, posterDiscordId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`tb_iso_offer:${isoId}:${posterDiscordId}`)
      .setLabel("Make An Offer")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tb_iso_close:${isoId}:${posterDiscordId}`)
      .setLabel("Close Negotiations")
      .setStyle(ButtonStyle.Danger),
  );
}

export const data = new SlashCommandBuilder()
  .setName("tradeblock")
  .setDescription("Manage your trade block listings")
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Post items to the trade block (up to 7 items)")
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Draft pick from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)").setAutocomplete(true))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins to include").setMinValue(1))
      .addStringOption(o => o.setName("looking_for").setDescription("What you want in return"))
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove one of your active trade block listings")
      .addStringOption(o => o.setName("listing").setDescription("Select the listing to remove").setAutocomplete(true).setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("update")
      .setDescription("Update and repost one of your trade block listings")
      .addStringOption(o => o.setName("listing").setDescription("Select the listing to update").setAutocomplete(true).setRequired(true))
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Draft pick from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)").setAutocomplete(true))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins to include").setMinValue(1))
      .addStringOption(o => o.setName("looking_for").setDescription("What you want in return"))
  )
  .addSubcommand(sub =>
    sub.setName("send-offer")
      .setDescription("Send a private trade offer DM directly to another user")
      .addUserOption(o => o.setName("to").setDescription("The user you want to trade with").setRequired(true))
      .addStringOption(o => o.setName("player1").setDescription("Player from your roster to offer").setAutocomplete(true))
      .addStringOption(o => o.setName("player2").setDescription("2nd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player3").setDescription("3rd player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player4").setDescription("4th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("player5").setDescription("5th player (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick1").setDescription("Draft pick from your roster").setAutocomplete(true))
      .addStringOption(o => o.setName("pick2").setDescription("2nd draft pick (optional)").setAutocomplete(true))
      .addStringOption(o => o.setName("pick3").setDescription("3rd draft pick (optional)").setAutocomplete(true))
      .addIntegerOption(o => o.setName("coins").setDescription("Coins to include in the offer").setMinValue(1))
      .addStringOption(o => o.setName("looking_for").setDescription("What you want in return (players, picks, coins, etc.)"))
      .addStringOption(o => o.setName("message").setDescription("Optional personal message to include"))
  )
  .addSubcommand(sub =>
    sub.setName("iso")
      .setDescription("Post what you're looking for (ISO) in the trade block channel")
      .addStringOption(o =>
        o.setName("seeking_type")
          .setDescription("What type of asset are you seeking?")
          .setRequired(true)
          .addChoices(
            { name: "Player (by position)", value: "player_position" },
            { name: "Draft Picks (by round)", value: "draft_pick" },
            { name: "Coins", value: "coins" },
          )
      )
      .addStringOption(o =>
        o.setName("position")
          .setDescription("Position sought — required for Player type")
          .addChoices(...MADDEN_POSITIONS.map(p => ({ name: p, value: p })))
      )
      .addStringOption(o => o.setName("rounds").setDescription("Rounds sought, comma-separated (e.g. '1, 2') — for Draft Pick type"))
      .addIntegerOption(o => o.setName("coins_amount").setDescription("Coins amount sought — for Coins type").setMinValue(1))
      .addStringOption(o => o.setName("offering_players").setDescription("Players you're offering (describe)"))
      .addStringOption(o => o.setName("offering_picks").setDescription("Picks you're offering (e.g. '2025 Round 1')"))
      .addIntegerOption(o => o.setName("offering_coins").setDescription("Coins you're offering").setMinValue(1))
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  const sub     = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);
  const query   = (focused.value as string).toLowerCase();

  // Player autocomplete (player1-5) — covers add, update, and send-offer subcommands
  if (["player1","player2","player3","player4","player5"].includes(focused.name)) {
    const season = await getOrCreateActiveSeason();
    const userRows = await db.select({ team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.discordId, interaction.user.id))
      .limit(1);
    const myTeam = userRows[0]?.team;

    const rosterRows = await db.select({
      playerId:  franchiseRostersTable.playerId,
      firstName: franchiseRostersTable.firstName,
      lastName:  franchiseRostersTable.lastName,
      position:  franchiseRostersTable.position,
      overall:   franchiseRostersTable.overall,
      devTrait:  franchiseRostersTable.devTrait,
    })
      .from(franchiseRostersTable)
      .where(
        and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.discordId, interaction.user.id),
        )
      )
      .limit(200);

    const filtered = query
      ? rosterRows.filter(p =>
          `${p.firstName} ${p.lastName}`.toLowerCase().includes(query) ||
          p.position.toLowerCase().includes(query)
        )
      : rosterRows;

    const choices = filtered.slice(0, 25).map(p => {
      const name = `${p.firstName} ${p.lastName} (${p.position}) OVR ${p.overall} — ${devLabel(p.devTrait)}`;
      const value = `${p.playerId}|${p.firstName} ${p.lastName}|${p.position}|${p.overall}|${p.devTrait}`;
      return { name: name.slice(0, 100), value: value.slice(0, 100) };
    });

    await interaction.respond(choices).catch(() => {});
    return;
  }

  // Pick autocomplete (pick1-3) — covers add, update, and send-offer subcommands
  if (["pick1","pick2","pick3"].includes(focused.name)) {
    const season = await getOrCreateActiveSeason();
    const picks = await db.select()
      .from(franchiseDraftPicksTable)
      .where(
        and(
          eq(franchiseDraftPicksTable.seasonId, season.id),
          eq(franchiseDraftPicksTable.discordId, interaction.user.id),
        ),
      )
      .orderBy(
        asc(franchiseDraftPicksTable.draftYear),
        asc(franchiseDraftPicksTable.round),
        asc(franchiseDraftPicksTable.pickNum),
      )
      .limit(200);

    function pickLabel(p: typeof picks[0]): string {
      const pickStr = p.pickNum > 0 ? `, Pick #${p.pickNum}` : "";
      const origStr = p.originalTeamName ? ` (from ${p.originalTeamName})` : "";
      return `${p.draftYear} Round ${p.round}${pickStr}${origStr}`;
    }

    const filtered = query
      ? picks.filter(p => pickLabel(p).toLowerCase().includes(query))
      : picks;

    const choices = filtered.slice(0, 25).map(p => {
      const label = pickLabel(p);
      return { name: label.slice(0, 100), value: label.slice(0, 100) };
    });

    await interaction.respond(choices).catch(() => {});
    return;
  }

  // Listing autocomplete (remove/update)
  if (focused.name === "listing") {
    const season = await getOrCreateActiveSeason();
    const listings = await db.select()
      .from(tradeBlockListingsTable)
      .where(
        and(
          eq(tradeBlockListingsTable.discordId, interaction.user.id),
          eq(tradeBlockListingsTable.seasonId, season.id),
          eq(tradeBlockListingsTable.status, "active"),
        )
      )
      .limit(25);

    const choices = listings
      .filter(l => {
        if (!query) return true;
        const items = (l.items as TradeItem[]);
        const first = items[0];
        const label = first?.type === "player"
          ? `${first.firstName} ${first.lastName}`
          : first?.type === "pick" ? first.description
          : first?.type === "coins" ? `${first.amount} coins` : "";
        return label.toLowerCase().includes(query);
      })
      .map(l => {
        const items = (l.items as TradeItem[]);
        const parts = items.slice(0, 3).map(item => {
          if (item.type === "player") return `${item.firstName} ${item.lastName} (${item.position})`;
          if (item.type === "pick")   return item.description;
          return `${item.amount} coins`;
        });
        const label = `#${l.id}: ${parts.join(", ")}${items.length > 3 ? ` +${items.length - 3} more` : ""}`;
        return { name: label.slice(0, 100), value: String(l.id) };
      });

    await interaction.respond(choices).catch(() => {});
    return;
  }

  await interaction.respond([]).catch(() => {});
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function parsePlayerOption(raw: string | null): TradeItem | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length < 5) return null;
  const [pidStr, name, pos, ovrStr, devStr] = parts as [string, string, string, string, string];
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

async function getMyTeam(discordId: string): Promise<string> {
  const rows = await db.select({ team: usersTable.team }).from(usersTable)
    .where(eq(usersTable.discordId, discordId)).limit(1);
  return rows[0]?.team ?? "Unknown Team";
}

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  const settings = await getServerSettings();
  if (!settings.tradeBlockEnabled) {
    await interaction.reply({ content: "❌ The trade block is currently disabled by the commissioners.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === "add")         return handleAdd(interaction);
  if (sub === "remove")      return handleRemove(interaction);
  if (sub === "update")      return handleUpdate(interaction);
  if (sub === "iso")         return handleISO(interaction);
  if (sub === "send-offer")  return handleSendOffer(interaction);
}

// ── /tradeblock add ────────────────────────────────────────────────────────────
async function handleAdd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();
  const teamName = await getMyTeam(interaction.user.id);

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
  if (items.length > 7) {
    await interaction.editReply({ content: "❌ You can list at most 7 items at a time." });
    return;
  }

  const notes = interaction.options.getString("looking_for");

  // Post to trade block channel first (need the message ID)
  const channel = await interaction.client.channels.fetch(TRADE_BLOCK_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: "❌ Could not access the trade block channel." });
    return;
  }

  // Insert listing to get an ID
  const [inserted] = await db.insert(tradeBlockListingsTable).values({
    discordId: interaction.user.id,
    teamName,
    seasonId:  season.id,
    items,
    notes,
    status:    "active",
  }).returning({ id: tradeBlockListingsTable.id });

  const listingId = inserted!.id;
  const embed = buildListingEmbed(teamName, items, notes);
  const row   = buildListingButtons(listingId, interaction.user.id);

  const msg = await (channel as any).send({
    content:    "@everyone",
    embeds:     [embed],
    components: [row],
  });

  // Store the message/channel IDs
  await db.update(tradeBlockListingsTable)
    .set({ messageId: msg.id, channelId: TRADE_BLOCK_CHANNEL_ID })
    .where(eq(tradeBlockListingsTable.id, listingId));

  await interaction.editReply({ content: `✅ Your trade block listing has been posted! (Listing #${listingId})` });
}

// ── /tradeblock remove ─────────────────────────────────────────────────────────
async function handleRemove(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const listingId = parseInt(interaction.options.getString("listing", true), 10);
  const season    = await getOrCreateActiveSeason();

  const [listing] = await db.select().from(tradeBlockListingsTable)
    .where(
      and(
        eq(tradeBlockListingsTable.id, listingId),
        eq(tradeBlockListingsTable.discordId, interaction.user.id),
        eq(tradeBlockListingsTable.seasonId, season.id),
        eq(tradeBlockListingsTable.status, "active"),
      )
    ).limit(1);

  if (!listing) {
    await interaction.editReply({ content: "❌ Listing not found or already removed." });
    return;
  }

  await db.update(tradeBlockListingsTable).set({ status: "removed" }).where(eq(tradeBlockListingsTable.id, listingId));

  // Delete Discord message
  if (listing.messageId && listing.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(listing.channelId);
      if (ch?.isTextBased()) {
        const msg = await (ch as any).messages.fetch(listing.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch (_) {}
  }

  await interaction.editReply({ content: `✅ Listing #${listingId} has been removed from the trade block.` });
}

// ── /tradeblock update ─────────────────────────────────────────────────────────
async function handleUpdate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const listingId = parseInt(interaction.options.getString("listing", true), 10);
  const season    = await getOrCreateActiveSeason();
  const teamName  = await getMyTeam(interaction.user.id);

  const [listing] = await db.select().from(tradeBlockListingsTable)
    .where(
      and(
        eq(tradeBlockListingsTable.id, listingId),
        eq(tradeBlockListingsTable.discordId, interaction.user.id),
        eq(tradeBlockListingsTable.seasonId, season.id),
        eq(tradeBlockListingsTable.status, "active"),
      )
    ).limit(1);

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

  // If no new items specified, keep existing items
  const finalItems = items.length > 0 ? items : (listing.items as TradeItem[]);
  const finalNotes = interaction.options.getString("looking_for") ?? listing.notes ?? null;

  if (finalItems.length > 7) {
    await interaction.editReply({ content: "❌ You can list at most 7 items at a time." });
    return;
  }

  // Delete old Discord message
  if (listing.messageId && listing.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(listing.channelId);
      if (ch?.isTextBased()) {
        const msg = await (ch as any).messages.fetch(listing.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch (_) {}
  }

  // Post updated listing
  const channel = await interaction.client.channels.fetch(TRADE_BLOCK_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: "❌ Could not access the trade block channel." });
    return;
  }

  const embed = buildListingEmbed(teamName, finalItems, finalNotes);
  const row   = buildListingButtons(listingId, interaction.user.id);

  const msg = await (channel as any).send({
    content:    "@everyone",
    embeds:     [embed],
    components: [row],
  });

  await db.update(tradeBlockListingsTable).set({
    items:     finalItems,
    notes:     finalNotes,
    messageId: msg.id,
    channelId: TRADE_BLOCK_CHANNEL_ID,
  }).where(eq(tradeBlockListingsTable.id, listingId));

  await interaction.editReply({ content: `✅ Listing #${listingId} has been updated and reposted!` });
}

// ── /tradeblock iso ────────────────────────────────────────────────────────────
async function handleISO(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const seekingType = interaction.options.getString("seeking_type", true) as "player_position" | "draft_pick" | "coins";
  const season      = await getOrCreateActiveSeason();
  const teamName    = await getMyTeam(interaction.user.id);

  // Validate type-specific required fields
  let seekingDetails: any = {};

  if (seekingType === "player_position") {
    const pos = interaction.options.getString("position");
    if (!pos) {
      await interaction.editReply({ content: "❌ Please specify a **position** when seeking a player." });
      return;
    }
    seekingDetails = { position: pos };

    // Enforce 1 active ISO per position
    const existingPos = await db.select().from(tradeBlockISOTable).where(
      and(
        eq(tradeBlockISOTable.discordId, interaction.user.id),
        eq(tradeBlockISOTable.seasonId, season.id),
        eq(tradeBlockISOTable.status, "active"),
        eq(tradeBlockISOTable.seekingType, "player_position"),
      )
    );
    const conflicting = existingPos.find(e => (e.seekingDetails as any)?.position === pos);
    if (conflicting) {
      await interaction.editReply({ content: `❌ You already have an active ISO for **${pos}**. Close it first before posting a new one.` });
      return;
    }
  } else if (seekingType === "draft_pick") {
    const roundsRaw = interaction.options.getString("rounds");
    if (!roundsRaw) {
      await interaction.editReply({ content: "❌ Please specify which **rounds** you're seeking (e.g. `1, 2`)." });
      return;
    }
    const rounds = roundsRaw.split(",").map(s => s.trim()).filter(Boolean);
    seekingDetails = { rounds };
  } else {
    // coins
    const amount = interaction.options.getInteger("coins_amount");
    if (!amount) {
      await interaction.editReply({ content: "❌ Please specify the **coins amount** you're seeking." });
      return;
    }
    seekingDetails = { amount };

    // Enforce 1 active coins ISO
    const existing = await db.select({ id: tradeBlockISOTable.id }).from(tradeBlockISOTable).where(
      and(
        eq(tradeBlockISOTable.discordId, interaction.user.id),
        eq(tradeBlockISOTable.seasonId, season.id),
        eq(tradeBlockISOTable.status, "active"),
        eq(tradeBlockISOTable.seekingType, "coins"),
      )
    ).limit(1);
    if (existing.length > 0) {
      await interaction.editReply({ content: "❌ You already have an active Coins ISO. Close it first before posting a new one." });
      return;
    }
  }

  const offering = {
    players: interaction.options.getString("offering_players") ?? undefined,
    picks:   interaction.options.getString("offering_picks") ?? undefined,
    coins:   interaction.options.getInteger("offering_coins") ?? undefined,
  };

  if (!offering.players && !offering.picks && !offering.coins) {
    await interaction.editReply({ content: "❌ You must specify at least one thing you're offering in return (players, picks, or coins)." });
    return;
  }

  const channel = await interaction.client.channels.fetch(TRADE_BLOCK_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: "❌ Could not access the trade block channel." });
    return;
  }

  const [inserted] = await db.insert(tradeBlockISOTable).values({
    discordId: interaction.user.id,
    teamName,
    seasonId:  season.id,
    seekingType,
    seekingDetails,
    offering,
    status:    "active",
  }).returning({ id: tradeBlockISOTable.id });

  const isoId = inserted!.id;
  const embed = buildISOEmbed(teamName, seekingType, seekingDetails, offering);
  const row   = buildISOButtons(isoId, interaction.user.id);

  const msg = await (channel as any).send({
    content:    "@everyone",
    embeds:     [embed],
    components: [row],
  });

  await db.update(tradeBlockISOTable)
    .set({ messageId: msg.id, channelId: TRADE_BLOCK_CHANNEL_ID })
    .where(eq(tradeBlockISOTable.id, isoId));

  await interaction.editReply({ content: `✅ Your ISO has been posted to the trade block! (ISO #${isoId})` });
}

// ── /tradeblock send-offer ─────────────────────────────────────────────────────
async function handleSendOffer(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("to", true);

  // Can't send an offer to yourself
  if (target.id === interaction.user.id) {
    await interaction.editReply({ content: "❌ You can't send a trade offer to yourself." });
    return;
  }

  // Build the offering items
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
    await interaction.editReply({ content: "❌ You must include at least one player, pick, or coin amount in your offer." });
    return;
  }
  if (items.length > 7) {
    await interaction.editReply({ content: "❌ You can include at most 7 items in a single offer." });
    return;
  }

  const lookingFor = interaction.options.getString("looking_for");
  const message    = interaction.options.getString("message");
  const myTeam     = await getMyTeam(interaction.user.id);

  // Build the DM embed
  const offeringText = items.map(itemLine).join("\n");

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🤝 Trade Offer from ${myTeam}`)
    .setDescription(
      `<@${interaction.user.id}> has sent you a trade offer!` +
      (message ? `\n\n💬 *"${message}"*` : "")
    )
    .addFields({ name: "📦 They're Offering", value: offeringText })
    .addFields({ name: "🔎 They Want in Return", value: lookingFor || "*Open to discussion — reply to discuss*" })
    .setFooter({ text: `Reply to this DM or reach out to ${interaction.user.username} in the server to respond.` })
    .setTimestamp();

  // Attempt to DM the target user
  try {
    const targetUser = await interaction.client.users.fetch(target.id);
    await targetUser.send({ embeds: [embed] });
  } catch (_) {
    await interaction.editReply({
      content: `❌ Could not DM <@${target.id}>. They may have DMs disabled. Try reaching out to them directly in the server.`,
    });
    return;
  }

  // Confirm to the sender (ephemeral)
  const confirmEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Trade Offer Sent")
    .setDescription(`Your offer was sent to <@${target.id}> via DM.`)
    .addFields({ name: "📦 You Offered", value: offeringText })
    .addFields({ name: "🔎 Looking For", value: lookingFor || "*Open to discussion*" })
    .setTimestamp();

  await interaction.editReply({ embeds: [confirmEmbed] });
}
