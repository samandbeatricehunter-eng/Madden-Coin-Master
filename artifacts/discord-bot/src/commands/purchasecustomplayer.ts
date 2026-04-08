import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { customPlayerSettingsTable } from "@workspace/db";
import { createSession } from "../lib/custom-player-session.js";
import { getOrCreateActiveSeason, getInventoryCount } from "../lib/db-helpers.js";
import { LIMITS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("purchasecustomplayer")
  .setDescription("Build and purchase a custom player for the draft class");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season    = await getOrCreateActiveSeason();
  const discordId = interaction.user.id;

  // ── Fetch settings + combined season inventory count in parallel ───────────
  const [[settingsRow], invCount] = await Promise.all([
    db.select().from(customPlayerSettingsTable).limit(1),
    getInventoryCount(discordId, season.id),
  ]);

  const combined = invCount.legends + invCount.customs;
  const cap      = LIMITS.maxLegendsPlusCustomPlayers;

  // ── Combined season inventory limit check ──────────────────────────────────
  if (combined >= cap) {
    const limitEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Season Inventory Full")
      .setDescription(
        `You already have **${combined}** combined legends and custom players in your season inventory ` +
        `(max **${cap}**). You cannot add another custom player this season.`,
      )
      .addFields(
        { name: "Legends",        value: `${invCount.legends}`, inline: true },
        { name: "Custom Players", value: `${invCount.customs}`, inline: true },
        { name: "Limit",          value: `${cap} combined`,     inline: true },
      )
      .setFooter({ text: "Contact a commissioner if you believe this is an error." })
      .setTimestamp();

    await interaction.editReply({ embeds: [limitEmbed] });
    return;
  }

  // ── Show upfront draft-pick warning before starting the builder ───────────
  const sessionId = createSession(discordId, interaction.guild?.id ?? "");

  const slotsLeft = cap - combined;

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
        name: "Season inventory slots",
        value: `You have **${combined}** of **${cap}** slots used. **${slotsLeft}** slot${slotsLeft !== 1 ? "s" : ""} remaining.`,
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
