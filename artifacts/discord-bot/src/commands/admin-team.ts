import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { deleteAllUserData, findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

function teamAutocomplete(focused: string) {
  const query = focused.toLowerCase();
  return NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(query))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
}

// ── /addnewuser ───────────────────────────────────────────────────────────────
export const addNewUserData = new SlashCommandBuilder()
  .setName("addnewuser")
  .setDescription("Commissioner: Add a new user to a team slot (clears the old owner's data)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The new Discord member joining this team").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name (e.g. Cowboys, Eagles)")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(opt =>
    opt.setName("starting_balance")
      .setDescription("Starting coin balance (default: 0)")
      .setRequired(false)
      .setMinValue(0)
  );

export async function autocompleteAddNewUser(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused();
  await interaction.respond(teamAutocomplete(focused));
}

export async function executeAddNewUser(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const newUser = interaction.options.getUser("user", true);
  const teamName = interaction.options.getString("team", true).trim();
  const startingBalance = interaction.options.getInteger("starting_balance") ?? 0;

  // Validate it's a real NFL team
  if (!(NFL_TEAMS as readonly string[]).includes(teamName)) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Invalid Team")
          .setDescription(`**${teamName}** is not a valid NFL team name. Choose from the autocomplete list.`),
      ],
    });
  }

  // 1. Find any existing occupant of this team
  const oldOccupant = await findUserByTeam(teamName);
  let clearedOldUser = false;
  if (oldOccupant && oldOccupant.discordId !== newUser.id) {
    await deleteAllUserData(oldOccupant.discordId);
    clearedOldUser = true;
  }

  // 2. If the new user already exists, wipe their old data for a fresh start
  const existingNewUser = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, newUser.id)).limit(1);
  if (existingNewUser.length > 0) {
    await deleteAllUserData(newUser.id);
  }

  // 3. Create the new user entry with the team assigned
  await db.insert(usersTable).values({
    discordId: newUser.id,
    discordUsername: newUser.username,
    team: teamName,
    balance: startingBalance,
    totalLegendPurchases: 0,
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ New User Added")
    .addFields(
      { name: "Player", value: newUser.toString(), inline: true },
      { name: "Team", value: teamName, inline: true },
      { name: "Starting Balance", value: `${startingBalance.toLocaleString()} coins`, inline: true },
    )
    .setTimestamp();

  if (clearedOldUser) {
    embed.addFields({
      name: "⚠️ Previous Owner Cleared",
      value: `**${oldOccupant!.discordUsername}** was removed from the **${teamName}** slot and all their data was wiped.`,
    });
  }

  // Notify the new user
  await newUser.send(
    `🏈 You've been added to the **${teamName}** in the Madden League!\n` +
    `Starting balance: **${startingBalance.toLocaleString()} coins** 🪙\n` +
    `Use \`/balance\`, \`/viewstore\`, and \`/inventory\` to get started.`
  ).catch(() => {});

  return interaction.editReply({ embeds: [embed] });
}

// ── /deletemember ─────────────────────────────────────────────────────────────
export const deleteMemberData = new SlashCommandBuilder()
  .setName("deletemember")
  .setDescription("Commissioner: Permanently delete all data for a team/user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name (leave blank to use @user instead)")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Discord user to remove (used if no team name provided)").setRequired(false)
  );

export async function autocompleteDeleteMember(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused();
  await interaction.respond(teamAutocomplete(focused));
}

export async function executeDeleteMember(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const teamName = interaction.options.getString("team")?.trim();
  const targetUser = interaction.options.getUser("user");

  if (!teamName && !targetUser) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Missing Input")
          .setDescription("Please provide either a **team** name or **@user** to delete."),
      ],
    });
  }

  let discordId: string;
  let displayName = "";

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Team Not Found")
            .setDescription(`No user is currently assigned to the **${teamName}**.`),
        ],
      });
    }
    discordId = found.discordId;
    displayName = `${found.discordUsername} (${teamName})`;
  } else {
    const found = await db.select().from(usersTable)
      .where(eq(usersTable.discordId, targetUser!.id)).limit(1);
    if (!found[0]) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ User Not Found")
            .setDescription(`${targetUser!.toString()} has no data in the league system.`),
        ],
      });
    }
    discordId = targetUser!.id;
    displayName = `${found[0].discordUsername}${found[0].team ? ` (${found[0].team})` : ""}`;
  }

  await deleteAllUserData(discordId);

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ Member Deleted")
        .setDescription(
          `All data for **${displayName}** has been permanently removed.\n\n` +
          `This includes: balance, purchases, inventory, upgrade counts, and H2H records.`
        )
        .setTimestamp(),
    ],
  });
}
