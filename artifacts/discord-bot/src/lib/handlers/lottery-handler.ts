/**
 * Draft Lottery — animated slot-machine style draft order reveal.
 *
 * Originally exposed as the `/lottery` slash command; now lives inside the
 * /menu → League Operations → Post Content hub as a button (`ao_lottery`).
 *
 * Flow:
 *   ao_lottery button  →  showRoleSelect (RoleSelectMenu + Count Modal trigger)
 *   role_lottery select →  showModal asking for count
 *   modal_lottery       →  resolve role + count → runDraftLottery
 */
import {
  ActionRowBuilder,
  ButtonInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  RoleSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Role,
} from "discord.js";

const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

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

/** Step 1 — `ao_lottery` button → show a Role select menu. */
export async function handleLotterySetup(interaction: ButtonInteraction): Promise<void> {
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId("role_lottery")
    .setPlaceholder("Pick the role to draw participants from…")
    .setMinValues(1)
    .setMaxValues(1);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎰 Draft Lottery — Setup")
        .setDescription("**Step 1 of 2:** Pick the Discord role whose members will be entered in the lottery (e.g. *Approved Member*)."),
    ],
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect)],
    ephemeral: true,
  });
}

/** Step 2 — Role selected → show a modal that asks how many participants to draw. */
export async function handleLotteryRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
  const roleId = interaction.values[0];
  if (!roleId) {
    await interaction.reply({ content: "❌ No role selected.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal_lottery:${roleId}`)
    .setTitle("Draft Lottery — How many picks?");

  const countInput = new TextInputBuilder()
    .setCustomId("count")
    .setLabel("Number of participants to draw (2–32)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2)
    .setPlaceholder("e.g. 12");

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(countInput));
  await interaction.showModal(modal);
}

/** Step 3 — Modal submitted → parse, validate, run the animated reveal. */
export async function handleLotteryCountModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, roleId] = interaction.customId.split(":");
  if (!roleId) {
    await interaction.reply({ content: "❌ Lottery setup expired — please start again.", ephemeral: true });
    return;
  }

  const raw = interaction.fields.getTextInputValue("count").trim();
  const count = Number.parseInt(raw, 10);
  if (!Number.isFinite(count) || count < 2 || count > 32) {
    await interaction.reply({ content: "❌ Count must be a number between 2 and 32.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "❌ Guild context missing.", ephemeral: true });
    return;
  }

  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    await interaction.reply({ content: "❌ Could not resolve that role — it may have been deleted.", ephemeral: true });
    return;
  }

  // Public reveal — defer in the channel so everyone sees it.
  await interaction.deferReply();
  await runDraftLottery(interaction, role, count);
}

/** The animated reveal. Shared by the modal flow and any future scripted entry point. */
export async function runDraftLottery(
  interaction: ModalSubmitInteraction,
  role: Role,
  count: number,
): Promise<void> {
  const guild = interaction.guild!;
  await guild.members.fetch();

  const eligible = guild.members.cache.filter((m) => !m.user.bot && m.roles.cache.has(role.id));

  if (eligible.size < 2) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Not Enough Participants")
          .setDescription(`Only **${eligible.size}** non-bot member(s) have the ${role} role. Need at least **2** to run a lottery.`),
      ],
    });
    return;
  }

  const effectiveCount = Math.min(count, eligible.size);
  if (effectiveCount < count) {
    const ch = interaction.channel;
    if (ch && "send" in ch) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle("⚠️ Lowered Count")
            .setDescription(`Requested **${count}** participants but only **${eligible.size}** member(s) have the ${role} role. Drawing **${eligible.size}** instead.`),
        ],
      });
    }
  }

  const pool     = shuffleArray(Array.from(eligible.values()));
  const selected = pool.slice(0, effectiveCount);
  const results  = shuffleArray(selected);

  const previewEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎰 DRAFT LOTTERY 🎰")
    .setDescription(
      `**Participants (${selected.length}):**\n` +
      selected.map((m) => `• ${m.displayName}`).join("\n"),
    )
    .setFooter({ text: `Drawing ${effectiveCount} from ${eligible.size} eligible members` })
    .setTimestamp();

  const message = await interaction.editReply({ embeds: [previewEmbed] });

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

  const revealed: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const spins = 3 + Math.floor(Math.random() * 2);
    for (let spin = 0; spin < spins; spin++) {
      const fake = results[Math.floor(Math.random() * results.length)]!;
      const rolling = new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle(`🎰 Drawing ${pickLabel(i + 1)}…`)
        .setDescription(
          (revealed.length ? revealed.join("\n") + "\n\n" : "") +
          `🎲 Rolling… **${fake.displayName}**`,
        );
      await message.edit({ embeds: [rolling] });
      await wait(400 + Math.random() * 300);
    }
    const member = results[i]!;
    revealed.push(`**${pickLabel(i + 1)}:** <@${member.id}>`);

    const reveal = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🎰 Draft Lottery Results")
      .setDescription(revealed.join("\n"))
      .setFooter({ text: `${i + 1} of ${results.length} picks revealed` });
    await message.edit({ embeds: [reveal] });
    await wait(900 + i * 150);
  }

  const finalEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏆  FINAL DRAFT ORDER  🏆")
    .setDescription(revealed.join("\n"))
    .setFooter({ text: `${results.length} picks · ${role.name} · ${new Date().toLocaleDateString()}` })
    .setTimestamp();

  await message.edit({ embeds: [finalEmbed] });
}
