import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { customPlayersTable, customPlayerSettingsTable } from "@workspace/db";
import { eq, and, ne, count } from "drizzle-orm";
import { createSession } from "../lib/custom-player-session.js";
import { positionSelectRow } from "../lib/custom-player-helpers.js";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("purchasecustomplayer")
  .setDescription("Build and purchase a custom player for the draft class");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();
  const discordId = interaction.user.id;

  // ── Fetch settings + current season count in parallel ─────────────────────
  const [[settingsRow], [countRow]] = await Promise.all([
    db.select().from(customPlayerSettingsTable).limit(1),
    db.select({ total: count() })
      .from(customPlayersTable)
      .where(and(
        eq(customPlayersTable.discordId, discordId),
        eq(customPlayersTable.seasonId, season.id),
        ne(customPlayersTable.status, "refunded"),
      )),
  ]);

  const settings    = settingsRow ?? { seasonLimit: 0 };
  const seasonUsed  = countRow?.total ?? 0;
  const limit       = settings.seasonLimit ?? 0;

  // ── Limit check ────────────────────────────────────────────────────────────
  if (limit > 0 && seasonUsed >= limit) {
    const limitEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Custom Player Limit Reached")
      .setDescription(
        `You have already created **${seasonUsed}** custom player${seasonUsed !== 1 ? "s" : ""} this season, ` +
        `which is the maximum allowed (**${limit}**).`,
      )
      .addFields({
        name: "This Season",
        value: `${seasonUsed} / ${limit} custom players used`,
        inline: true,
      })
      .setFooter({ text: "Contact a commissioner if you believe this is an error." })
      .setTimestamp();

    await interaction.editReply({ embeds: [limitEmbed] });
    return;
  }

  // ── Start builder flow ─────────────────────────────────────────────────────
  const sessionId = createSession(discordId, interaction.guild?.id ?? "");

  const remainingNote = limit > 0
    ? `\n\n*You have used **${seasonUsed}** of your **${limit}** allowed custom players this season.*`
    : "";

  await interaction.editReply({
    content:
      "**🏈 Custom Player Builder — Step 1 of 8**\n\n" +
      "Select your player's position to get started:" +
      remainingNote,
    components: [positionSelectRow(sessionId)],
  });
}
