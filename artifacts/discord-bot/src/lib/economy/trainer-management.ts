import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  EmbedBuilder, Colors, StringSelectMenuBuilder, StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { db, positionalTrainersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { addBalance, deductBalance, logTransaction } from "../db/db-helpers.js";
import { type TrainerFocus } from "./positional-trainer.js";

async function rowsOf<T=any>(q:any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

async function activeTrainers(guildId: string, userId: string) {
  return rowsOf<any>(sql`
    select *
    from positional_trainers
    where guild_id=${guildId}
      and owner_discord_id=${userId}
      and status='active'
    order by hired_at desc
  `);
}

export async function renderTrainerManage(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const rows = await activeTrainers(interaction.guildId!, interaction.user.id);
  if (!rows.length) {
    const payload = { content: "You do not have any active trainers to manage.", components: [] };
    if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
    else await (interaction as any).reply({ ...payload, ephemeral: true });
    return;
  }
  const embed = new EmbedBuilder().setColor(Colors.Blurple).setTitle("🏋️ Manage Active Trainers").setDescription("Select an active trainer to extend, change focus, or fire.");
  const menu = new StringSelectMenuBuilder().setCustomId("ac_trainer_select").setPlaceholder("Select an active trainer…");
  for (const t of rows.slice(0,25)) {
    menu.addOptions(new StringSelectMenuOptionBuilder()
      .setLabel(`${String(t.tier).toUpperCase()} — ${t.player_name}`.slice(0,100))
      .setDescription(`${t.player_pos} · ${t.focus} · ${t.weeks_remaining}/${t.weeks_total} weeks · ${t.weekly_cost} coins/wk`.slice(0,100))
      .setValue(String(t.id)));
  }
  const payload = { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
  if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
  else if ((interaction as any).update) await (interaction as any).update(payload).catch(()=> (interaction as any).reply({ ...payload, ephemeral: true }));
  else await (interaction as any).reply({ ...payload, ephemeral: true });
}

async function renderTrainerActions(interaction: StringSelectMenuInteraction | ButtonInteraction, trainerId: number) {
  const [t] = await db.select().from(positionalTrainersTable).where(eq(positionalTrainersTable.id, trainerId)).limit(1);
  if (!t || t.ownerDiscordId !== interaction.user.id || t.guildId !== interaction.guildId || t.status !== "active") {
    await (interaction as any).reply?.({ content: "Trainer not found or not active.", ephemeral: true }).catch(()=>null);
    return;
  }
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle(`🏋️ ${t.playerName} Trainer`).setDescription(`**Tier:** ${t.tier}\n**Focus:** ${t.focus}\n**Weeks:** ${t.weeksRemaining}/${t.weeksTotal}\n**Weekly Cost:** ${t.weeklyCost} coins`);
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ac_trainer_extend:${trainerId}`).setLabel("Extend Contract").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ac_trainer_focus:${trainerId}`).setLabel("Change Focus").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ac_trainer_fire:${trainerId}`).setLabel("Fire Trainer").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_trainer_manage").setLabel("← Back to Trainers").setStyle(ButtonStyle.Secondary),
    ),
  ];
  await (interaction as any).update({ embeds: [embed], components: rows }).catch(()=> (interaction as any).editReply({ embeds: [embed], components: rows }));
}

export async function handleTrainerManagementButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("ac_trainer_")) return false;
  if (interaction.customId === "ac_trainer_manage") { await renderTrainerManage(interaction); return true; }
  const match = interaction.customId.match(/^ac_trainer_(extend|focus|fire|fire_confirm|select_back):(\d+)$/);
  if (!match) return false;
  const action = match[1];
  const trainerId = Number(match[2]);
  if (action === "extend") {
    const menu = new StringSelectMenuBuilder().setCustomId(`ac_trainer_extend_weeks:${trainerId}`).setPlaceholder("Choose additional weeks…").addOptions(
      [1,2,3,4,5,6,7,8].map(w => new StringSelectMenuOptionBuilder().setLabel(`${w} week${w===1?"":"s"}`).setValue(String(w)))
    );
    await interaction.update({ content: "How many weeks do you want to add?", embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
    return true;
  }
  if (action === "focus") {
    const menu = new StringSelectMenuBuilder().setCustomId(`ac_trainer_focus_pick:${trainerId}`).setPlaceholder("Choose new focus…").addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Speed").setValue("speed"),
      new StringSelectMenuOptionBuilder().setLabel("Power").setValue("power"),
      new StringSelectMenuOptionBuilder().setLabel("Balanced").setValue("balanced"),
      new StringSelectMenuOptionBuilder().setLabel("Position").setValue("position"),
    );
    await interaction.update({ content: "Choose the new focus. It applies on the next advance roll.", embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
    return true;
  }
  if (action === "fire") {
    const [t] = await db.select().from(positionalTrainersTable).where(eq(positionalTrainersTable.id, trainerId)).limit(1);
    const refund = Math.max(0, Number(t?.weeksRemaining ?? 0) * Number(t?.weeklyCost ?? 0));
    await interaction.update({
      content: `Fire this trainer now? Refund for unused future weeks: **${refund} coins**.`,
      embeds: [],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ac_trainer_fire_confirm:${trainerId}`).setLabel("Confirm Fire").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`ac_trainer_select_back:${trainerId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    });
    return true;
  }
  if (action === "fire_confirm") {
    const [t] = await db.select().from(positionalTrainersTable).where(eq(positionalTrainersTable.id, trainerId)).limit(1);
    if (!t || t.ownerDiscordId !== interaction.user.id || t.guildId !== interaction.guildId || t.status !== "active") { await interaction.reply({ content: "Trainer not found or already inactive.", ephemeral: true }); return true; }
    const refund = Math.max(0, Number(t.weeksRemaining) * Number(t.weeklyCost));
    await db.update(positionalTrainersTable).set({ status: "fired", expiredAt: new Date(), weeksRemaining: 0 }).where(eq(positionalTrainersTable.id, trainerId));
    if (refund > 0) {
      await addBalance(t.ownerDiscordId, refund, t.guildId);
      await logTransaction(t.ownerDiscordId, refund, "trainer_refund", `Refund for firing trainer ${t.playerName}`, t.guildId);
    }
    await interaction.update({ content: `Trainer fired. Refunded **${refund} coins**.`, embeds: [], components: [] });
    return true;
  }
  return false;
}

export async function handleTrainerManagementSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("ac_trainer_")) return false;
  if (interaction.customId === "ac_trainer_select") { await renderTrainerActions(interaction, Number(interaction.values[0])); return true; }
  if (interaction.customId.startsWith("ac_trainer_extend_weeks:")) {
    const trainerId = Number(interaction.customId.split(":")[1]);
    const weeks = Number(interaction.values[0]);
    const [t] = await db.select().from(positionalTrainersTable).where(eq(positionalTrainersTable.id, trainerId)).limit(1);
    if (!t || t.ownerDiscordId !== interaction.user.id || t.guildId !== interaction.guildId || t.status !== "active") { await interaction.update({ content: "Trainer not found or already inactive.", components: [] }); return true; }
    const cost = weeks * Number(t.weeklyCost);
    const ok = await deductBalance(t.ownerDiscordId, cost, t.guildId).catch(()=>false);
    if (!ok) { await interaction.update({ content: `Insufficient coins. Extension costs **${cost} coins**.`, components: [] }); return true; }
    await db.update(positionalTrainersTable).set({ weeksTotal: Number(t.weeksTotal) + weeks, weeksRemaining: Number(t.weeksRemaining) + weeks, totalCost: Number(t.totalCost) + cost }).where(eq(positionalTrainersTable.id, trainerId));
    await logTransaction(t.ownerDiscordId, -cost, "trainer_extension", `Extended trainer ${t.playerName} by ${weeks} week(s)`, t.guildId);
    await interaction.update({ content: `Trainer extended by **${weeks}** week(s). Charged **${cost} coins**.`, components: [] });
    return true;
  }
  if (interaction.customId.startsWith("ac_trainer_focus_pick:")) {
    const trainerId = Number(interaction.customId.split(":")[1]);
    const focus = interaction.values[0] as TrainerFocus;
    const [t] = await db.select().from(positionalTrainersTable).where(eq(positionalTrainersTable.id, trainerId)).limit(1);
    if (!t || t.ownerDiscordId !== interaction.user.id || t.guildId !== interaction.guildId || t.status !== "active") { await interaction.update({ content: "Trainer not found or already inactive.", components: [] }); return true; }
    await db.update(positionalTrainersTable).set({ focus }).where(eq(positionalTrainersTable.id, trainerId));
    await interaction.update({ content: `Trainer focus changed to **${focus}**. This applies on the next advance roll.`, components: [] });
    return true;
  }
  return false;
}
