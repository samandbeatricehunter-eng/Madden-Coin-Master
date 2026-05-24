/**
 * /lottery — Draft Lottery
 *
 * Admin-only command that runs an animated slot-machine style draft order reveal.
 * Pulls members with a specified role, randomly selects `count` participants,
 * and reveals the draft order one pick at a time with rolling suspense animations.
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
  Role,
} from "discord.js";
import { isAdminUser } from "../../lib/db/db-helpers.js";

const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function pickLabel(n: number): string {
  if (n === 1) return "1st Pick";
  if (n === 2) return "2nd Pick";
  if (n === 3) return "3rd Pick";
  return `${n}th Pick`;
}

export const data = new SlashCommandBuilder()
  .setName("lottery")
  .setDescription("Commissioner: Run an animated draft lottery")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption(opt =>
    opt.setName("role")
      .setDescription("Role to draw participants from (e.g. Approved Member)")
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("count")
      .setDescription("Number of participants to select (2–32)")
      .setRequired(true)
      .setMinValue(2)
      .setMaxValue(32)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const isAdmin = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (!isAdmin && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Access Denied").setDescription("This command is restricted to commissioners.")],
      ephemeral: true,
    });
  }

  const role  = interaction.options.getRole("role", true) as Role;
  const count = interaction.options.getInteger("count", true);

  await interaction.deferReply();

  const guild = interaction.guild!;
  await guild.members.fetch();

  // Filter to non-bot members who have the specified role
  const eligible = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(role.id));

  if (eligible.size < 2) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Not Enough Participants")
          .setDescription(`Only **${eligible.size}** non-bot member(s) have the ${role} role. Need at least **2** to run a lottery.`),
      ],
    });
  }

  if (eligible.size < count) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Not Enough Members")
          .setDescription(`Requested **${count}** participants but only **${eligible.size}** member(s) have the ${role} role.\n\nLowering the count to **${eligible.size}**.`),
      ],
    });
  }

  const pool     = shuffleArray(Array.from(eligible.values()));
  const selected = pool.slice(0, count);
  const results  = shuffleArray(selected);

  // ── Participant Preview ─────────────────────────────────────────────────────
  const previewEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎰 DRAFT LOTTERY 🎰")
    .setDescription(
      `**Participants (${selected.length}):**\n` +
      selected.map(m => `• ${m.displayName}`).join("\n"),
    )
    .setFooter({ text: `Drawing ${count} from ${eligible.size} eligible members` })
    .setTimestamp();

  const message = await interaction.editReply({ embeds: [previewEmbed] });

  // ── Drumroll ────────────────────────────────────────────────────────────────
  await wait(1800);
  await message.edit({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("🥁  D R U M R O L L  P L E A S E . . .  🥁")
        .setDescription("The lottery is about to begin!"),
    ],
  });
  await wait(2200);

  // ── Reveal each pick ────────────────────────────────────────────────────────
  const revealed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const spins = 3 + Math.floor(Math.random() * 2);

    for (let spin = 0; spin < spins; spin++) {
      const fake = results[Math.floor(Math.random() * results.length)]!;

      const rollingEmbed = new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle(`🎰 Drawing ${pickLabel(i + 1)}…`)
        .setDescription(
          (revealed.length ? revealed.join("\n") + "\n\n" : "") +
          `🎲 Rolling… **${fake.displayName}**`,
        );

      await message.edit({ embeds: [rollingEmbed] });
      await wait(400 + Math.random() * 300);
    }

    // Real reveal
    const member = results[i]!;
    revealed.push(`**${pickLabel(i + 1)}:** <@${member.id}>`);

    const revealEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🎰 Draft Lottery Results")
      .setDescription(revealed.join("\n"))
      .setFooter({ text: `${i + 1} of ${results.length} picks revealed` });

    await message.edit({ embeds: [revealEmbed] });
    await wait(900 + i * 150);
  }

  // ── Final Board ─────────────────────────────────────────────────────────────
  const finalEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏆  FINAL DRAFT ORDER  🏆")
    .setDescription(revealed.join("\n"))
    .setFooter({ text: `${results.length} picks · ${role.name} · ${new Date().toLocaleDateString()}` })
    .setTimestamp();

  return message.edit({ embeds: [finalEmbed] });
}
