import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { customPlayerSettingsTable } from "@workspace/db";
import { createSession } from "../lib/custom-player-session.js";
import { positionSelectRow } from "../lib/custom-player-helpers.js";
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

  // ── Start builder flow ─────────────────────────────────────────────────────
  const sessionId = createSession(discordId, interaction.guild?.id ?? "");

  const slotsLeft  = cap - combined;
  const remainNote = `\n\n*You have **${combined}** of **${cap}** season inventory slots used (legends + custom players combined). **${slotsLeft}** slot${slotsLeft !== 1 ? "s" : ""} remaining.*`;

  await interaction.editReply({
    content:
      "**🏈 Custom Player Builder — Step 1 of 8**\n\n" +
      "Select your player's position to get started:" +
      remainNote,
    components: [positionSelectRow(sessionId)],
  });
}
