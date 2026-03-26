import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { wagersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "../lib/db-helpers.js";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("wager")
  .setDescription("Place a coin wager on the outcome of a game with another user")
  .addUserOption(opt =>
    opt.setName("opponent")
      .setDescription("The user you are wagering against")
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("amount")
      .setDescription("Coins to stake — each player puts in this amount")
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption(opt =>
    opt.setName("your_team")
      .setDescription("Your team in this matchup")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(opt =>
    opt.setName("opponent_team")
      .setDescription("Your opponent's team in this matchup")
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction: any) {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = (NFL_TEAMS as readonly string[])
    .filter(t => t.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices.map(t => ({ name: t, value: t })));
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const opponent   = interaction.options.getUser("opponent", true);
  const amount     = interaction.options.getInteger("amount", true);
  const teamFor    = interaction.options.getString("your_team", true);
  const teamAgainst = interaction.options.getString("opponent_team", true);

  if (opponent.id === interaction.user.id) {
    return interaction.editReply({ content: "❌ You can't wager against yourself." });
  }
  if (opponent.bot) {
    return interaction.editReply({ content: "❌ You can't wager against a bot." });
  }

  const challenger = await getOrCreateUser(interaction.user.id, interaction.user.username);
  if (challenger.balance < amount) {
    return interaction.editReply({
      content: `❌ Insufficient coins. Your balance: **${challenger.balance.toLocaleString()} coins**, wager: **${amount.toLocaleString()} coins**.`,
    });
  }

  await getOrCreateUser(opponent.id, opponent.username);

  const [wager] = await db.insert(wagersTable).values({
    challengerId:      interaction.user.id,
    challengerUsername: interaction.user.username,
    opponentId:        opponent.id,
    opponentUsername:  opponent.username,
    amount,
    pot:       amount * 2,
    teamFor,
    teamAgainst,
    status: "pending",
  }).returning();

  if (!wager) {
    return interaction.editReply({ content: "❌ Failed to create wager. Please try again." });
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚔️ Wager Challenge!")
    .setDescription(`<@${interaction.user.id}> has challenged <@${opponent.id}> to a coin wager!`)
    .addFields(
      { name: "💰 Stake",    value: `**${amount.toLocaleString()} coins** each (total pot: **${(amount * 2).toLocaleString()} coins**)` },
      { name: "🏈 Matchup", value: `**${teamFor}** vs **${teamAgainst}**` },
      { name: "📋 Status",  value: "⏳ Waiting for opponent to respond…" },
    )
    .setFooter({ text: `Wager #${wager.id}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wager_accept:${wager.id}`)
      .setLabel("✅ Accept Wager")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`wager_refuse:${wager.id}`)
      .setLabel("❌ Refuse")
      .setStyle(ButtonStyle.Danger),
  );

  let challengeMsg: any = null;
  try {
    if (interaction.channel) {
      challengeMsg = await (interaction.channel as any).send({
        content: `<@${opponent.id}> — you have a wager challenge!`,
        embeds: [embed],
        components: [row],
      });
    }
  } catch (err) {
    console.error("Failed to send wager challenge message:", err);
  }

  if (challengeMsg) {
    await db.update(wagersTable)
      .set({ challengeMessageId: challengeMsg.id })
      .where(eq(wagersTable.id, wager.id));
  }

  return interaction.editReply({
    content: `✅ Wager challenge sent! **Wager #${wager.id}** — waiting for <@${opponent.id}> to respond.`,
  });
}
