import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, StringSelectMenuInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, usersTable, franchiseRostersTable } from "@workspace/db";
import { eq, and, or, desc } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const ITEM_TYPE_LABELS: Record<string, string> = {
  legend: "Legend",
  attribute: "Attribute",
  dev_up: "Dev Up",
  age_reset: "Age Reset",
  custom_player_gold: "Custom Player (Gold)",
  custom_player_silver: "Custom Player (Silver)",
  custom_player_bronze: "Custom Player (Bronze)",
};

const DEV_LABEL: Record<number, string> = {
  0: "Normal", 1: "Impact", 2: "Star", 3: "Superstar", 4: "X-Factor",
};

const POSITION_ORDER = [
  "QB","HB","FB",
  "WR","TE",
  "LT","LG","C","RG","RT",
  "LEDGE","LE","REDGE","RE","DT","NT",
  "WILL","ROLB","MIKE","MLB","SAM","LOLB","ILB","OLB",
  "CB","FS","SS",
  "K","P","LS",
];

function sortPositions(positions: string[]): string[] {
  const known   = POSITION_ORDER.filter(p => positions.includes(p));
  const unknown = positions.filter(p => !POSITION_ORDER.includes(p)).sort();
  return [...known, ...unknown];
}

function itemSummary(item: typeof inventoryTable.$inferSelect): string {
  const type = ITEM_TYPE_LABELS[item.itemType] ?? item.itemType;
  const parts: string[] = [];
  if (item.legendName) parts.push(item.legendName);
  if (item.playerName) parts.push(item.playerName);
  if (item.playerPosition) parts.push(`(${item.playerPosition})`);
  if (item.attributeName) parts.push(`— ${item.attributeName}`);
  if (item.notes) parts.push(`[${item.notes}]`);
  const perm = item.legendCategory === "permanent" ? " 🔒" : "";
  const detail = parts.length > 0 ? ` — ${parts.join(" ")}` : "";
  return `**ID ${item.id}** · ${type}${perm}${detail}`;
}

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id, interaction.guildId!);
}

export const data = new SlashCommandBuilder()
  .setName("admininventory")
  .setDescription("Admin: view, remove, transfer, or manually add inventory items")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove an inventory item by its ID")
      .addIntegerOption(opt =>
        opt.setName("item_id").setDescription("The item ID (see /admininventory view)").setRequired(true).setMinValue(1)
      )
      .addStringOption(opt =>
        opt.setName("reason").setDescription("Optional reason for the removal").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName("move")
      .setDescription("Transfer an inventory item to a different user")
      .addIntegerOption(opt =>
        opt.setName("item_id").setDescription("The item ID (see /admininventory view)").setRequired(true).setMinValue(1)
      )
      .addUserOption(opt =>
        opt.setName("to_user").setDescription("The user who will receive the item").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("add_custom_player")
      .setDescription("Add a permanent custom player for a user — picks from their team's live roster")
      .addUserOption(opt =>
        opt.setName("user").setDescription("The user who owns this custom player").setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("notes").setDescription("Optional notes (e.g. archetype, backstory)").setRequired(false)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await checkAdmin(interaction))) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── REMOVE ──────────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const itemId = interaction.options.getInteger("item_id", true);
    const reason = interaction.options.getString("reason");

    const existing = await db.select().from(inventoryTable).where(eq(inventoryTable.id, itemId)).limit(1);
    if (existing.length === 0) {
      await interaction.reply({ content: `❌ No inventory item found with ID **${itemId}**.`, ephemeral: true });
      return;
    }

    const item = existing[0]!;
    await db.delete(inventoryTable).where(eq(inventoryTable.id, itemId));

    const ownerInfo = await db.select({ discordUsername: usersTable.discordUsername })
      .from(usersTable).where(and(eq(usersTable.discordId, item.discordId), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    const ownerName = ownerInfo[0]?.discordUsername ?? item.discordId;

    const reasonNote = reason ? `\n**Reason:** ${reason}` : "";
    await interaction.reply({
      content: `🗑️ Removed **${itemSummary(item)}** from **${ownerName}**'s inventory.${reasonNote}`,
      ephemeral: true,
    });
    return;
  }

  // ── MOVE ────────────────────────────────────────────────────────────────────
  if (sub === "move") {
    const itemId = interaction.options.getInteger("item_id", true);
    const toUser = interaction.options.getUser("to_user", true);

    const existing = await db.select().from(inventoryTable).where(eq(inventoryTable.id, itemId)).limit(1);
    if (existing.length === 0) {
      await interaction.reply({ content: `❌ No inventory item found with ID **${itemId}**.`, ephemeral: true });
      return;
    }

    const item = existing[0]!;
    const oldOwnerInfo = await db.select({ discordUsername: usersTable.discordUsername })
      .from(usersTable).where(and(eq(usersTable.discordId, item.discordId), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    const oldOwnerName = oldOwnerInfo[0]?.discordUsername ?? item.discordId;

    await db.update(inventoryTable)
      .set({ discordId: toUser.id })
      .where(eq(inventoryTable.id, itemId));

    await interaction.reply({
      content: `🔄 Transferred **${itemSummary(item)}** from **${oldOwnerName}** → **${toUser.username}**.`,
      ephemeral: true,
    });
    return;
  }

  // ── ADD CUSTOM PLAYER ────────────────────────────────────────────────────────
  // Step 1: Look up the user's linked team, then show a position dropdown from
  //         their live franchise roster. Format: acp_pos:<targetDiscordId>:<seasonId>:<notes|->
  if (sub === "add_custom_player") {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user", true);
    const notes      = interaction.options.getString("notes")?.trim() ?? "";

    const season = await getOrCreateActiveSeason(interaction.guildId!);

    const [userRow] = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
      .from(usersTable)
      .where(and(eq(usersTable.discordId, targetUser.id), eq(usersTable.guildId, interaction.guildId!)))
      .limit(1);

    if (!userRow) {
      await interaction.editReply(`❌ **${targetUser.username}** is not registered in the bot. Use \`/admin linkteam\` first.`);
      return;
    }

    if (!userRow.team) {
      await interaction.editReply(`❌ **${targetUser.username}** is not linked to a team yet. Use \`/admin linkteam\` first.`);
      return;
    }

    // Load distinct positions for this user's team from the live roster
    const rosterPositions = await db
      .selectDistinct({ position: franchiseRostersTable.position })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.teamName, userRow.team),
      ));

    if (rosterPositions.length === 0) {
      await interaction.editReply(
        `❌ No roster data found for **${userRow.team}**. Make sure the MCA roster has been imported.`
      );
      return;
    }

    const positions = sortPositions(
      rosterPositions.map(r => r.position).filter((p): p is string => Boolean(p))
    );

    // Encode notes in the customId, replacing colons and encoding empty as "-"
    const notesEncoded = (notes || "-").replace(/:/g, "COLON");

    const posMenu = new StringSelectMenuBuilder()
      .setCustomId(`acp_pos:${targetUser.id}:${season.id}:${notesEncoded}`)
      .setPlaceholder(`Select a position from ${userRow.team}…`)
      .addOptions(
        positions.slice(0, 25).map(pos =>
          new StringSelectMenuOptionBuilder().setLabel(pos).setValue(pos)
        )
      );

    await interaction.editReply({
      content: `**Add Custom Player for ${userRow.discordUsername ?? targetUser.username}** (${userRow.team})\nSelect a position:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(posMenu)],
    });
  }
}

// ── Step 2: Position selected → show player dropdown ─────────────────────────
// customId: acp_pos:<targetDiscordId>:<seasonId>:<notesEncoded>
export async function handleAcpPositionSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  const parts           = interaction.customId.split(":");
  const targetDiscordId = parts[1] ?? "";
  const seasonId        = parseInt(parts[2] ?? "0", 10);
  const notesEncoded    = parts[3] ?? "-";
  const position        = interaction.values[0]!;

  // Look up the user's team name
  const [userRow] = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetDiscordId), eq(usersTable.guildId, interaction.guildId!)))
    .limit(1);

  if (!userRow?.team) {
    await interaction.editReply({ content: "❌ Could not find team for this user.", components: [] });
    return;
  }

  // Load players at this position on the team, sorted by OVR desc
  const players = await db.select({
    playerId:  franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    overall:   franchiseRostersTable.overall,
    devTrait:  franchiseRostersTable.devTrait,
    jerseyNum: franchiseRostersTable.jerseyNum,
  })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamName, userRow.team),
      eq(franchiseRostersTable.position, position),
    ))
    .orderBy(desc(franchiseRostersTable.overall))
    .limit(25);

  if (players.length === 0) {
    await interaction.editReply({
      content: `❌ No **${position}** players found on **${userRow.team}**'s roster.`,
      components: [],
    });
    return;
  }

  const playerMenu = new StringSelectMenuBuilder()
    .setCustomId(`acp_player:${targetDiscordId}:${seasonId}:${notesEncoded}`)
    .setPlaceholder(`Select a ${userRow.team} ${position}…`)
    .addOptions(
      players.map(p => {
        const name  = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || `Player ${p.playerId}`;
        const jersey = p.jerseyNum != null ? `#${p.jerseyNum} ` : "";
        const dev   = DEV_LABEL[p.devTrait ?? 0] ?? "Normal";
        const label = `${jersey}${name}`.slice(0, 100);
        const desc  = `${p.overall ?? 0} OVR · ${dev}`;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setDescription(desc)
          .setValue(`${p.playerId}:${name}:${position}`);
      })
    );

  await interaction.editReply({
    content: `**${userRow.team} — ${position}s** · Select the player to mark as a custom player:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playerMenu)],
    embeds: [],
  });
}

// ── Step 3: Player selected → insert inventory item ───────────────────────────
// customId: acp_player:<targetDiscordId>:<seasonId>:<notesEncoded>
// value:    <playerId>:<playerName>:<position>
export async function handleAcpPlayerSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  const parts           = interaction.customId.split(":");
  const targetDiscordId = parts[1] ?? "";
  const seasonId        = parseInt(parts[2] ?? "0", 10);
  const notesEncoded    = parts[3] ?? "-";
  const notes           = notesEncoded === "-" ? null : notesEncoded.replace(/COLON/g, ":");

  const valueParts = (interaction.values[0] ?? "").split(":");
  const playerName = valueParts[1] ?? "Unknown";
  const position   = valueParts[2] ?? "";

  // Look up the user's team
  const [userRow] = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetDiscordId), eq(usersTable.guildId, interaction.guildId!)))
    .limit(1);

  const [inserted] = await db.insert(inventoryTable).values({
    discordId:      targetDiscordId,
    seasonId,
    purchaseId:     0,
    itemType:       "custom_player_gold",
    playerName,
    playerPosition: position,
    notes,
    legendCategory: "permanent",
    team:           userRow?.team ?? null,
  }).returning();

  const ownerName  = userRow?.discordUsername ?? `<@${targetDiscordId}>`;
  const teamNote   = userRow?.team ? ` (${userRow.team})` : "";
  const notesNote  = notes ? `\n📝 Notes: ${notes}` : "";

  await interaction.editReply({
    content: [
      `✅ Added **${playerName}** (${position}) as a permanent custom player for **${ownerName}**${teamNote}.`,
      `They will now appear under 🗃️ Permanent Custom Players in \`/userstats\`.`,
      notesNote,
      `\n*Item ID: ${inserted?.id ?? "—"} — use \`/admininventory remove\` to undo.*`,
    ].filter(Boolean).join("\n"),
    components: [],
    embeds: [],
  });
}
