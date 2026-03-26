import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("View all available bot commands");

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin = await isAdminUser(interaction.user.id);
  const isAdmin = isDiscordAdmin || isDbAdmin;

  const memberEmbed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🏈 REC League Econo-Bot — Member Commands")
    .addFields(
      {
        name: "💰 Economy",
        value: [
          "`/balance` — Check your current coin balance",
          "`/sendcoins @user [amount]` — Send coins to another player",
        ].join("\n"),
      },
      {
        name: "🛒 Store & Purchases",
        value: [
          "`/viewstore` — Browse all available items and legends",
          "`/purchase [type]` — Buy a legend, attribute upgrade, dev up, age reset, or custom player",
        ].join("\n"),
      },
      {
        name: "📦 Inventory & Upgrades",
        value: [
          "`/inventory` — View your current season inventory",
          "`/availableupgrades` — See how many upgrades you have left this season",
        ].join("\n"),
      },
      {
        name: "📊 Rankings & Records",
        value: [
          "`/seasonpr` — View the current season power rankings",
          "`/alltimepr` — View all-time power rankings across all seasons",
          "`/recenth2h @user` — View a user's recent game history",
        ].join("\n"),
      },
      {
        name: "🏆 Game Payouts & Interviews",
        value: [
          "`/reportscore h2h [opponent team] [your score] [their score]` — Report an H2H game",
          "  → Winner **+50 coins**, loser **+20 coins**. Ties pay nothing. Counts toward power rankings.",
          "`/reportscore cpu [cpu team] [your score] [cpu score]` — Report a CPU game",
          "  → Win pays **+20 coins**, loss/tie pays nothing. Does NOT count toward power rankings.",
          "`/interviewrequest` — Submit a post-game interview for **+10 coins**",
          "  → One interview allowed per game reported. Must report a new score before submitting another.",
          "  → All payouts require commissioner approval.",
        ].join("\n"),
      },
      {
        name: "📋 League Rules",
        value: [
          "`/rules [section]` — Display a league rules section",
          "`/rules [section] @user` — Share a rules section with a specific member",
        ].join("\n"),
      },
      {
        name: "📋 Purchase Limits",
        value: [
          "• **Legends** — 1,000 coins | 4 max all-time | max 4 in inventory",
          "• **Attributes** — 40 coins | 20/season | Speed capped at 5 pts/season",
          "• **Dev Upgrades** — 250 coins | 2/season | Star or Superstar only",
          "• **Age Resets** — 250 coins | 2/season",
          "• **Custom Players** — Gold 300 / Silver 200 / Bronze 100 coins",
        ].join("\n"),
      },
    )
    .setFooter({ text: "All purchases are sent to the commissioner for approval." })
    .setTimestamp();

  if (!isAdmin) {
    return interaction.reply({ embeds: [memberEmbed], ephemeral: true });
  }

  const adminEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("⚙️ REC League Econo-Bot — Admin Commands")
    .addFields(
      {
        name: "👤 User Management",
        value: [
          "`/addnewuser @user [team] [starting_balance]` — Add a new user to a team slot",
          "`/deletemember [team]` — Permanently delete all data for a team or user",
          "`/setuser [team]` — Manually set any stat for a user (coins, record, upgrades, etc.)",
          "`/setadmin @user [true/false]` — Grant or revoke bot-admin status for a user",
        ].join("\n"),
      },
      {
        name: "💰 Coins",
        value: [
          "`/addcoins @user [amount]` — Add coins to a user's balance",
          "`/removecoins @user [amount]` — Remove coins from a user's balance",
        ].join("\n"),
      },
      {
        name: "📦 Inventory Management",
        value: [
          "`/admininventory view @user` — View all inventory items for a user (shows IDs)",
          "`/admininventory remove [item_id] [reason]` — Delete an inventory item by ID",
          "`/admininventory move [item_id] @user` — Transfer an inventory item to another user",
        ].join("\n"),
      },
      {
        name: "🏆 Legends",
        value: [
          "`/legend add [name] [position] [cost]` — Add a legend to the store",
          "`/legend list` — View all legends (including sold ones)",
          "`/legend edit [id]` — Edit a legend's details",
          "`/legend remove [id]` — Remove a legend from the store",
        ].join("\n"),
      },
      {
        name: "📋 League Rules",
        value: [
          "`/adminrules list [section]` — Show current rules with numbered list",
          "`/adminrules set [section] [#] [text]` — Edit a specific rule by number",
          "`/adminrules add [section] [text]` — Append a new rule to a section",
          "`/adminrules remove [section] [#]` — Remove a rule by number",
          "`/adminrules reset [section]` — Reset a section to the default rules",
        ].join("\n"),
      },
      {
        name: "📅 Season Management",
        value: [
          "`/season new` — Advance to the next season (max 5 total)",
          "`/season set [1–5]` — Jump directly to a specific season number",
          "`/season status` — View the current active season",
          "`/season addcoins @user [amount]` — Add coins to a user",
          "`/season setbalance @user [amount]` — Set a user's exact coin balance",
        ].join("\n"),
      },
      {
        name: "📊 Records",
        value: [
          "`/updaterecord [win/loss] [spread] [team/@user]` — Log a game result",
          "`/seasonpr` — Post the current season power rankings",
          "`/alltimepr` — Post all-time power rankings",
          "`/recenth2h @user` — View a user's recent game results",
        ].join("\n"),
      },
      {
        name: "🔄 Resets",
        value: [
          "`/resetupgrades @user [type]` — Reset a user's upgrade counts for the current season",
        ].join("\n"),
      },
      {
        name: "📋 PR Formula",
        value: "PR Score = **60%** × (W−L) + **40%** × Point Differential",
      },
    )
    .setFooter({ text: "Admin commands are only visible to bot admins and server administrators." })
    .setTimestamp();

  return interaction.reply({
    embeds: [memberEmbed, adminEmbed],
    ephemeral: true,
  });
}
