import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { deleteAllUserData, findUserByTeam } from "../lib/user-data.js";

// ── /addnewuser ───────────────────────────────────────────────────────────────
export const addNewUserData = new SlashCommandBuilder()
  .setName("addnewuser")
  .setDescription("Commissioner: Add a new user to a team slot (clears the old owner's data)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The new Discord member joining this team").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("team").setDescription("Team name / franchise name").setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("starting_balance")
      .setDescription("Starting coin balance (default: 0)")
      .setRequired(false)
      .setMinValue(0)
  );

export async function executeAddNewUser(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const newUser = interaction.options.getUser("user", true);
  const teamName = interaction.options.getString("team", true).trim();
  const startingBalance = interaction.options.getInteger("starting_balance") ?? 0;

  // 1. Find any existing occupant of this team
  const oldOccupant = await findUserByTeam(teamName);

  let clearedOldUser = false;
  if (oldOccupant && oldOccupant.discordId !== newUser.id) {
    await deleteAllUserData(oldOccupant.discordId);
    clearedOldUser = true;
  }

  // 2. If the new user already exists in the system, clear their old data too
  //    (they may have been on a different team) then re-create them fresh
  const existingNewUser = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, newUser.id)).limit(1);

  if (existingNewUser.length > 0) {
    // Remove their old economy data and re-insert fresh
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
  try {
    await newUser.send(
      `🏈 You've been added to **${teamName}** in the Madden League!\n` +
      `Starting balance: **${startingBalance.toLocaleString()} coins** 🪙\n` +
      `Use \`/balance\`, \`/viewstore\`, and \`/inventory\` to get started.`
    ).catch(() => {});
  } catch (_) {}

  return interaction.editReply({ embeds: [embed] });
}

// ── /deletemember ─────────────────────────────────────────────────────────────
export const deleteMemberData = new SlashCommandBuilder()
  .setName("deletemember")
  .setDescription("Commissioner: Permanently delete all data for a team/user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("team").setDescription("Team name to remove (leave blank to use @user instead)").setRequired(false)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Discord user to remove (used if no team name provided)").setRequired(false)
  );

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

  let discordId: string | null = null;
  let displayName = "";

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Team Not Found")
            .setDescription(`No user found for team **${teamName}**.`),
        ],
      });
    }
    discordId = found.discordId;
    displayName = `${found.discordUsername} (${teamName})`;
  } else if (targetUser) {
    const found = await db.select().from(usersTable)
      .where(eq(usersTable.discordId, targetUser.id)).limit(1);
    if (!found[0]) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ User Not Found")
            .setDescription(`${targetUser.toString()} has no data in the league system.`),
        ],
      });
    }
    discordId = targetUser.id;
    displayName = `${found[0].discordUsername}${found[0].team ? ` (${found[0].team})` : ""}`;
  }

  await deleteAllUserData(discordId!);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("🗑️ Member Deleted")
    .setDescription(
      `All data for **${displayName}** has been permanently removed.\n\n` +
      `This includes: balance, purchases, inventory, upgrade counts, and H2H records.`
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
