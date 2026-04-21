import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, Colors,
} from "discord.js";
import { getServerSettings } from "../lib/server-settings.js";
import type { ServerSettings } from "../lib/server-settings.js";
import { isAdminUser, getOrCreateUser, getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";
import { appendUserStatsFields } from "../lib/user-stats-embed.js";

export const data = new SlashCommandBuilder()
  .setName("actions")
  .setDescription("League hub — coins, wagers, rosters, standings, PR, and more in one place");

export function buildActionsHubEmbed(settings: ServerSettings, isAdmin: boolean): EmbedBuilder {
  const mcaVisible  = settings.mcaImportEnabled || isAdmin;
  const ecoVisible  = settings.coinEconomy;
  const wagerVisible = settings.coinEconomy && settings.wagerEnabled;

  const sections: string[] = [];

  const row1Items: string[] = [];
  if (ecoVisible)   row1Items.push("💳 Make a Purchase");
  if (wagerVisible) row1Items.push("⚔️ Place a Wager");
  if (ecoVisible)   row1Items.push("🪙 Coins");
  row1Items.push("🎙️ Interview", "🐦 Tweet");
  sections.push(`**Economy & Social**\n${row1Items.join(" · ")}`);

  if (mcaVisible) {
    sections.push("**Rosters**\n📋 My Roster · 👥 Any Roster · 🆓 Free Agents · 📊 Player Stats · 🏟️ Team Stats");
    sections.push("**League Info**\n📈 Standings · 👀 Teams to Watch · 👤 Any User Stats");
  }

  const row4Items: string[] = ["🥇 Season PR", "🏆 All-Time PR", "🌐 Global PR"];
  if (ecoVisible) row4Items.push("💰 EOS Payouts", "🎯 Milestones");
  sections.push(`**Rankings & Payouts**\n${row4Items.join(" · ")}`);

  sections.push("**Requests**\n🟢 Active Teams · 🔴 Open Teams · ✈️ Auto-Pilot · 📜 Rules · 🚨 Report Violation");

  return new EmbedBuilder()
    .setColor(0x1a1a2e)
    .setTitle("🏈 League Actions Hub")
    .setDescription(
      "Select any action below. All menus are private (visible only to you).\n\n" +
      sections.join("\n\n")
    )
    .setFooter({ text: "League Actions Hub — selections expire after 15 minutes" });
}

export function buildActionsHubRows(settings: ServerSettings, isAdmin: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const mcaVisible  = settings.mcaImportEnabled || isAdmin;
  const ecoVisible  = settings.coinEconomy;
  const wagerVisible = settings.coinEconomy && settings.wagerEnabled;

  const sec1: ButtonBuilder[] = [];
  if (ecoVisible)   sec1.push(new ButtonBuilder().setCustomId("ac_purchase").setLabel("💳 Make a Purchase").setStyle(ButtonStyle.Primary));
  if (wagerVisible) sec1.push(new ButtonBuilder().setCustomId("ac_wager").setLabel("⚔️ Place a Wager").setStyle(ButtonStyle.Danger));
  if (ecoVisible)   sec1.push(new ButtonBuilder().setCustomId("ac_coins").setLabel("🪙 View / Send Coins").setStyle(ButtonStyle.Success));
  sec1.push(
    new ButtonBuilder().setCustomId("ac_interview").setLabel("🎙️ Request Interview").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_tweet").setLabel("🐦 Post a Tweet").setStyle(ButtonStyle.Secondary),
  );

  const sec2: ButtonBuilder[] = [];
  if (mcaVisible) {
    sec2.push(
      new ButtonBuilder().setCustomId("ac_myroster").setLabel("📋 My Roster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_anyroster").setLabel("👥 Any Roster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_freeagents").setLabel("🆓 Free Agents").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_playerstats").setLabel("📊 Player Stats").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_teamstats").setLabel("🏟️ Team Stats").setStyle(ButtonStyle.Secondary),
    );
  }

  const sec3: ButtonBuilder[] = [];
  if (mcaVisible) {
    sec3.push(
      new ButtonBuilder().setCustomId("ac_standings").setLabel("📈 Standings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_teamstowatch").setLabel("👀 Teams to Watch").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_anyuserstats").setLabel("👤 Any User Stats").setStyle(ButtonStyle.Secondary),
    );
  }

  const sec4: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId("ac_seasonpr").setLabel("🥇 Season PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_alltimepr").setLabel("🏆 All-Time PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_globalpr").setLabel("🌐 Global PR").setStyle(ButtonStyle.Secondary),
  ];
  if (ecoVisible) {
    sec4.push(
      new ButtonBuilder().setCustomId("ac_eospayouts").setLabel("💰 EOS Payouts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_milestonepayouts").setLabel("🎯 Milestones").setStyle(ButtonStyle.Secondary),
    );
  }

  const sec5: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId("ac_activeteams").setLabel("🟢 Active Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_openteams").setLabel("🔴 Open Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_autopilot").setLabel("✈️ Auto-Pilot").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_violation").setLabel("🚨 Report Violation").setStyle(ButtonStyle.Danger),
  ];

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const section of [sec1, sec2, sec3, sec4, sec5]) {
    if (section.length > 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...section));
    }
  }
  return rows;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  const [settings, member, user, season] = await Promise.all([
    getServerSettings(gid),
    interaction.guild?.members.fetch(uid).catch(() => null),
    getOrCreateUser(uid, interaction.user.username, gid),
    getOrCreateActiveSeason(gid),
  ]);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(uid, gid);
  const isAdmin        = isDiscordAdmin || isDbAdmin;

  const rules = await getSeasonRules(season);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🏈 League Actions Hub — ${user.team ?? interaction.user.username}`)
    .setDescription("Select any action below. All menus are private (visible only to you).")
    .setFooter({ text: "League Actions Hub — selections expire after 15 minutes" });

  await appendUserStatsFields(embed, uid, gid, user, season, settings, rules, interaction.user.displayAvatarURL());

  await interaction.editReply({
    embeds:     [embed],
    components: buildActionsHubRows(settings, isAdmin),
  });
}
