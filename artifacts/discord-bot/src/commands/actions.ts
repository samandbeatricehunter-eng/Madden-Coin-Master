import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("actions")
  .setDescription("League hub — coins, wagers, rosters, standings, PR, and more in one place");

export function buildActionsHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x1a1a2e)
    .setTitle("🏈 League Actions Hub")
    .setDescription(
      "Select any action below. All menus are private (visible only to you).\n\n" +
      "**Row 1 — Economy & Social**\n" +
      "💳 Make a Purchase · ⚔️ Place a Wager · 🪙 Coins · 🎙️ Interview · 🐦 Tweet\n\n" +
      "**Row 2 — Rosters**\n" +
      "📋 My Roster · 👥 Any Roster · 🆓 Free Agents · 📊 Player Stats · 🏟️ Team Stats\n\n" +
      "**Row 3 — League Info**\n" +
      "📈 Standings · 👀 Teams to Watch · 🧑 My Stats · 👤 Any User Stats\n\n" +
      "**Row 4 — Rankings & Payouts**\n" +
      "🥇 Season PR · 🏆 All-Time PR · 🌐 Global PR · 💰 EOS Payouts · 🎯 Milestones\n\n" +
      "**Row 5 — Requests**\n" +
      "🟢 Active Teams · 🔴 Open Teams · ✈️ Auto-Pilot · 📜 Rules · 🚨 Report Violation"
    )
    .setFooter({ text: "League Actions Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildActionsHubRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_purchase").setLabel("💳 Make a Purchase").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_wager").setLabel("⚔️ Place a Wager").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_coins").setLabel("🪙 View / Send Coins").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_interview").setLabel("🎙️ Request Interview").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_tweet").setLabel("🐦 Post a Tweet").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_myroster").setLabel("📋 My Roster").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_anyroster").setLabel("👥 Any Roster").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_freeagents").setLabel("🆓 Free Agents").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_playerstats").setLabel("📊 Player Stats").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_teamstats").setLabel("🏟️ Team Stats").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_standings").setLabel("📈 Standings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_teamstowatch").setLabel("👀 Teams to Watch").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_myuserstats").setLabel("🧑 My User Stats").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_anyuserstats").setLabel("👤 Any User Stats").setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_seasonpr").setLabel("🥇 Season PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_alltimepr").setLabel("🏆 All-Time PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_globalpr").setLabel("🌐 Global PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_eospayouts").setLabel("💰 EOS Payouts").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_milestonepayouts").setLabel("🎯 Milestones").setStyle(ButtonStyle.Secondary),
  );
  const row5 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_activeteams").setLabel("🟢 Active Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_openteams").setLabel("🔴 Open Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_autopilot").setLabel("✈️ Auto-Pilot").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_violation").setLabel("🚨 Report Violation").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3, row4, row5];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    embeds: [buildActionsHubEmbed()],
    components: buildActionsHubRows(),
    ephemeral: true,
  });
}
