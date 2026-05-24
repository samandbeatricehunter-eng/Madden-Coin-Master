import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { customPlayerSettingsTable } from "@workspace/db";
import { createSession } from "../../lib/handlers/custom-player-session.js";
import { getOrCreateActiveSeason, getInventoryCount } from "../../lib/db/db-helpers.js";
import { LIMITS, LEGEND_CUSTOM_PURCHASE_WEEKS } from "../../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("purchasecustomplayer")
  .setDescription("Build and purchase a custom player for the draft class (available through Week 18)");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season    = await getOrCreateActiveSeason(interaction.guildId!);
  const discordId = interaction.user.id;

  // Purchase window: custom players available through Week 18; closes once Wildcard week is reached
  if (!LEGEND_CUSTOM_PURCHASE_WEEKS.has(season.currentWeek ?? "")) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("❌ Purchase Window Closed")
        .setDescription(`Custom player purchases must be submitted before the league advances to Wildcard week. Current week: **Week ${season.currentWeek ?? "?"}**.`)],
    });
    return;
  }

  // ── Fetch settings + combined season inventory count in parallel ───────────
  const [[settingsRow], invCount] = await Promise.all([
    db.select().from(customPlayerSettingsTable).limit(1),
    getInventoryCount(discordId, season.id),
  ]);

  const customsCap = LIMITS.customPlayersPerDraft;

  if (invCount.customs >= customsCap) {
    const limitEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Custom Player Limit Reached")
      .setDescription(
        `You have already purchased **${invCount.customs}** custom player this season ` +
        `(max **${customsCap}** per season). You cannot purchase another until next season.`,
      )
      .setFooter({ text: "Contact a commissioner if you believe this is an error." })
      .setTimestamp();

    await interaction.editReply({ embeds: [limitEmbed] });
    return;
  }

  // ── Show upfront draft-pick warning before starting the builder ───────────
  const sessionId = createSession(discordId, interaction.guild?.id ?? "", season.id);

  const warningEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚠️ Before You Start — Draft Pick Required")
    .setDescription(
      "Purchasing a custom player **does not automatically place them on your roster**.\n\n" +
      "You must use **a draft pick** to select your custom player during the annual draft. " +
      "If you do not have a draft pick available, you will not be able to add this player to your team.",
    )
    .addFields(
      {
        name: "What happens after you purchase?",
        value:
          "1. You build your player's position, archetype, attributes, and appearance.\n" +
          "2. A commissioner adds them to the MCA draft class.\n" +
          "3. You use a draft pick to select them in the draft.\n" +
          "4. They join your roster once drafted.",
      },
      {
        name: "Custom player limit",
        value: `You have used **${invCount.customs}** of **${customsCap}** custom player slot this season.`,
      },
    )
    .setFooter({ text: "Make sure you have a draft pick saved before proceeding." });

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_preconfirm:${sessionId}`)
      .setLabel("✅ I understand, start building")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ccp_cancel:${sessionId}`)
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [warningEmbed], components: [confirmRow] });
}
