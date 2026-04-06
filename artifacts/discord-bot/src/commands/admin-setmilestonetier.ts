import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const MILESTONES = [
  { tier: 0, label: "None (no milestone awarded)",     wins: 0,  bonus: 0    },
  { tier: 1, label: "Tier 1 — 5 All-Time Wins",        wins: 5,  bonus: 100  },
  { tier: 2, label: "Tier 2 — 12 All-Time Wins",       wins: 12, bonus: 250  },
  { tier: 3, label: "Tier 3 — 25 All-Time Wins",       wins: 25, bonus: 500  },
  { tier: 4, label: "Tier 4 — 50 All-Time Wins",       wins: 50, bonus: 1000 },
] as const;

function tierLabel(tier: number): string {
  return MILESTONES.find(m => m.tier === tier)?.label ?? `Tier ${tier}`;
}

export const data = new SlashCommandBuilder()
  .setName("admin-setmilestonetier")
  .setDescription("Admin: manually set a user's career milestone tier (does not adjust coins)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o =>
    o.setName("user")
      .setDescription("The user whose milestone tier you want to set")
      .setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("tier")
      .setDescription("The milestone tier to assign")
      .setRequired(true)
      .addChoices(
        { name: "0 — None (no milestone awarded yet)",  value: 0 },
        { name: "1 — 5 All-Time Wins  (+100 coins)",   value: 1 },
        { name: "2 — 12 All-Time Wins (+250 coins)",   value: 2 },
        { name: "3 — 25 All-Time Wins (+500 coins)",   value: 3 },
        { name: "4 — 50 All-Time Wins (+1000 coins)",  value: 4 },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target  = interaction.options.getUser("user", true);
  const newTier = interaction.options.getInteger("tier", true);

  const [userRow] = await db.select({
    discordUsername:      usersTable.discordUsername,
    team:                 usersTable.team,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
    allTimeH2HWins:       usersTable.allTimeH2HWins,
  })
    .from(usersTable)
    .where(eq(usersTable.discordId, target.id))
    .limit(1);

  if (!userRow) {
    await interaction.editReply({ content: `❌ <@${target.id}> is not registered in the economy system.` });
    return;
  }

  const oldTier = userRow.milestoneTierAwarded ?? 0;

  if (oldTier === newTier) {
    await interaction.editReply({
      content: `ℹ️ <@${target.id}> is already at **${tierLabel(newTier)}** — no change made.`,
    });
    return;
  }

  await db.update(usersTable)
    .set({ milestoneTierAwarded: newTier, updatedAt: new Date() })
    .where(eq(usersTable.discordId, target.id));

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🎯 Milestone Tier Updated")
    .addFields(
      { name: "Player",        value: `<@${target.id}> (${userRow.team ?? "No team"})`, inline: false },
      { name: "All-Time H2H Wins", value: String(userRow.allTimeH2HWins ?? 0),          inline: true  },
      { name: "Previous Tier", value: tierLabel(oldTier),                                inline: true  },
      { name: "New Tier",      value: tierLabel(newTier),                                inline: true  },
    )
    .setDescription(
      "⚠️ This command only updates the tier record — it does **not** add or remove coins. " +
      "Use `/admin-addcoins` or `/admin-removecoins` separately if a coin adjustment is needed."
    )
    .setFooter({ text: `Set by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
