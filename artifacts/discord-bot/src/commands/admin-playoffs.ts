import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { isAdminUser, addBalance, logTransaction } from "../lib/db-helpers.js";

export const DIVISION_BONUS = 25;

export const data = new SlashCommandBuilder()
  .setName("admin-playoffs")
  .setDescription("Playoff seeding, division bonuses, and seed management (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  // ── Set NFC seeds ─────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("setnfcseeds")
    .setDescription("Register NFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
    .addUserOption(o => o.setName("seed1").setDescription("NFC seed #1").setRequired(true))
    .addUserOption(o => o.setName("seed2").setDescription("NFC seed #2").setRequired(true))
    .addUserOption(o => o.setName("seed3").setDescription("NFC seed #3").setRequired(true))
    .addUserOption(o => o.setName("seed4").setDescription("NFC seed #4").setRequired(true))
    .addUserOption(o => o.setName("seed5").setDescription("NFC seed #5 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed6").setDescription("NFC seed #6 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed7").setDescription("NFC seed #7 (wildcard)").setRequired(false))
  )

  // ── Set AFC seeds ─────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("setafcseeds")
    .setDescription("Register AFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
    .addUserOption(o => o.setName("seed1").setDescription("AFC seed #1").setRequired(true))
    .addUserOption(o => o.setName("seed2").setDescription("AFC seed #2").setRequired(true))
    .addUserOption(o => o.setName("seed3").setDescription("AFC seed #3").setRequired(true))
    .addUserOption(o => o.setName("seed4").setDescription("AFC seed #4").setRequired(true))
    .addUserOption(o => o.setName("seed5").setDescription("AFC seed #5 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed6").setDescription("AFC seed #6 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed7").setDescription("AFC seed #7 (wildcard)").setRequired(false))
  )

  // ── Division winner bonus ─────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("divisionbonus")
    .setDescription(`Award +${DIVISION_BONUS} coin division winner bonus (run at season end)`)
    .addUserOption(o => o.setName("winner1").setDescription("Division winner").setRequired(true))
    .addUserOption(o => o.setName("winner2").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner3").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner4").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner5").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner6").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner7").setDescription("Division winner").setRequired(false))
    .addUserOption(o => o.setName("winner8").setDescription("Division winner").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member       = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── Set NFC / AFC seeds ───────────────────────────────────────────────────
  if (sub === "nfc_seeds" || sub === "afc_seeds") {
    const conference = sub === "nfc_seeds" ? "NFC" : "AFC";
    const entries: { userId: string; username: string; seed: number }[] = [];

    for (let s = 1; s <= 7; s++) {
      const user = interaction.options.getUser(`seed${s}`);
      if (!user) break;
      entries.push({ userId: user.id, username: user.username, seed: s });
    }

    for (const entry of entries) {
      await db.update(usersTable)
        .set({ playoffSeed: entry.seed, playoffConference: conference, updatedAt: new Date() })
        .where(eq(usersTable.discordId, entry.userId));
    }

    const lines = entries.map(e =>
      `${e.seed <= 4 ? "🏆" : "🃏"} Seed #${e.seed} — <@${e.userId}> ${e.seed <= 4 ? "(Top 4 → +75/win)" : "(Wildcard → +100/win)"}`,
    );

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`📋 ${conference} Playoff Seeds Set`)
      .setDescription(lines.join("\n"))
      .addFields({
        name: "Payout Rates",
        value: "Seeds 1–4: **+75 coins/win** | Seeds 5–7: **+100 coins/win** | All losses: **+50 coins**",
      })
      .setFooter({ text: `Set by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Division winner bonus ─────────────────────────────────────────────────
  if (sub === "division_bonus") {
    const winners: { user: any; username: string }[] = [];

    for (let i = 1; i <= 8; i++) {
      const user = interaction.options.getUser(`winner${i}`);
      if (!user) break;
      winners.push({ user, username: user.username });
    }

    const lines: string[] = [];
    for (const { user } of winners) {
      await addBalance(user.id, DIVISION_BONUS);
      await logTransaction(user.id, DIVISION_BONUS, "addcoins", "Division winner bonus", interaction.user.id);
      lines.push(`✅ <@${user.id}> → +**${DIVISION_BONUS} coins**`);
      try {
        const discordUser = await interaction.client.users.fetch(user.id);
        await discordUser.send(`🏆 **Division Winner Bonus!** You've been awarded **+${DIVISION_BONUS} coins** for winning your division this season!`).catch(() => {});
      } catch (_) {}
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🏆 Division Winner Bonuses Awarded`)
      .setDescription(lines.join("\n"))
      .addFields({ name: "Bonus Per Winner", value: `**+${DIVISION_BONUS} coins**` })
      .setFooter({ text: `Issued by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
