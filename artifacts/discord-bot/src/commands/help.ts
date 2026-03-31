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
          "`/wager @user [amount]` — Challenge another player to a coin wager",
        ].join("\n"),
      },
      {
        name: "🛒 Store & Purchases",
        value: [
          "`/viewstore` — Browse all available items with **current season prices**",
          "`/purchase legend [name]` — Buy a legend player",
          "`/purchase attribute [player] [attr] [qty]` — Boost a player attribute",
          "`/purchase devup [player] [type] [qty]` — Dev upgrade (Star or Superstar)",
          "`/purchase agereset [player] [qty]` — Reset a player's age",
          "`/purchase customplayer [tier] [player]` — Buy a Gold/Silver/Bronze custom player",
          "",
          "📋 **Purchase Limits** *(default — commissioners may adjust per season)*",
          "• **Legends** — 1,000 coins | 4 max all-time | max 4 in inventory",
          "• **Core Attributes** — 25 coins/pt | 16 pts/season",
          "• **Non-Core Attributes** — 10 coins/pt | 32 pts/season | Speed capped 5 pts/season",
          "• **Dev Upgrades** — 250 coins | 2/season",
          "• **Age Resets** — 250 coins | 2/season",
          "• **Custom Players** — Gold 300 / Silver 200 / Bronze 100 coins",
          "• Combined Legends + Custom Players: max 4 per season",
          "",
          "⚠️ *Use `/viewstore` to see prices adjusted for the current season.*",
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
        name: "📊 Rankings & Stats",
        value: [
          "`/seasonpr` — View the current season power rankings",
          "`/alltimepr` — View all-time power rankings across all seasons",
          "`/recenth2h @user` — View a user's recent H2H game history",
          "`/userstats [@user]` — View detailed stats for yourself or another member",
        ].join("\n"),
      },
      {
        name: "🏆 Game Payouts & Interviews",
        value: [
          "**Game payouts are handled automatically** when the commissioner runs `/franchiseupdate` each week.",
          "  → H2H Win **+50 coins** | H2H Loss **+20 coins** | CPU Win **+20 coins**",
          "",
          "`/interviewrequest` — Submit a post-game interview for **+10 coins**",
          "  → One per week. Your game must be processed via the franchise update first.",
          "  → H2H game players get access to an expanded question pool.",
          "  → All interview payouts require commissioner approval.",
        ].join("\n"),
      },
      {
        name: "📅 Schedule & Matchups",
        value: [
          "`/seasonschedule` — View the full current-season schedule (all weeks)",
          "`/nextopp [@user]` — View your next opponent (or another member's next opponent)",
        ].join("\n"),
      },
      {
        name: "🏟️ Team Info",
        value: [
          "`/teamlist` — View all members and their linked NFL teams",
          "`/openteams` — View unclaimed NFL teams available for new members",
        ].join("\n"),
      },
      {
        name: "📋 League Rules",
        value: [
          "`/rules [section]` — Display all rules in a section",
          "`/rules [section] [rule_number]` — Quote a single rule from a section",
          "`/rules [section] [rule_number] @user` — Share a specific rule with a member (posts publicly)",
        ].join("\n"),
      },
    )
    .setFooter({ text: "All purchases are sent to the commissioner for approval. Use /viewstore for live prices." })
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
          "`/addnewuser @user [team] [starting_balance]` — Register a new user and link their NFL team",
          "`/deletemember [team]` — Permanently delete all data for a team or user",
          "`/setuser [team]` — Manually set any stat for a user (coins, record, upgrades, etc.)",
          "`/setadmin @user [true/false]` — Grant or revoke bot-admin privileges",
          "`/clearteam @user` — Unlink a user from their team and clear their season W/L records",
        ].join("\n"),
      },
      {
        name: "💰 Coins",
        value: [
          "`/addcoins [users] [amount]` — Add coins to up to 32 users at once (accepts @mentions or bare IDs)",
          "`/removecoins @user [amount]` — Remove coins from a user's balance",
        ].join("\n"),
      },
      {
        name: "📦 Inventory Management",
        value: [
          "`/admininventory view @user` — View all inventory items for a user (with item IDs)",
          "`/admininventory remove [item_id] [reason]` — Delete an inventory item by ID",
          "`/admininventory move [item_id] @user` — Transfer an inventory item to another user",
        ].join("\n"),
      },
      {
        name: "🏆 Legends & Vault",
        value: [
          "`/legend add [name] [position] [cost]` — Add a legend to the store",
          "`/legend list` — View all legends (including sold/unavailable)",
          "`/legend edit [id]` — Edit a legend's name, position, description, or availability",
          "`/legend remove [id]` — Remove a legend from the catalog",
          "`/admin-legendvault` — View/manage the current-season and permanent legend vaults",
        ].join("\n"),
      },
      {
        name: "📋 League Rules",
        value: [
          "`/adminrules new-section [key] [title]` — Create a new custom rules section",
          "`/adminrules list [section]` — Show current rules with numbered entries",
          "`/adminrules set [section] [#] [text]` — Edit a specific rule by number",
          "`/adminrules add [section] [text]` — Append a new rule to a section",
          "`/adminrules remove [section] [#]` — Remove a rule by number",
          "`/adminrules reset [section]` — Reset a built-in section to defaults, or clear a custom section",
        ].join("\n"),
      },
      {
        name: "📅 Season Management",
        value: [
          "`/season new` — Advance to the next season (max 5 per franchise)",
          "`/season set [1–5]` — Jump directly to a specific season number",
          "`/season status` — View the current active season and all override settings",
          "`/season addcoins @user [amount]` — Add coins to a user (alias for /addcoins)",
          "`/season setbalance @user [amount]` — Set a user's exact coin balance",
          "`/season franchise-reset confirm:True` — ⚠️ End-of-franchise: return all legends, reset coins, restart at Season 1",
          "",
          "**Season Overrides** — `/season override [options]`",
          "  Adjust costs and caps for the current season only:",
          "  `core_attr_cost` `core_attr_cap` `non_core_attr_cost` `non_core_attr_cap`",
          "  `dev_ups_cost` `dev_ups_cap` `age_resets_cost` `age_resets_cap`",
          "  `legend_cost` `custom_gold_cost` `custom_silver_cost` `custom_bronze_cost`",
          "  `clear:True` — restore all defaults",
          "",
          "**Custom Core Attributes** — `/season core-attrs [attr1] … [attr10]`",
          "  Set which attributes count as Core this season (1–10). Use `reset:True` to restore defaults.",
        ].join("\n"),
      },
      {
        name: "📊 Records & Rankings",
        value: [
          "`/seasonpr` — Post the current season power rankings",
          "`/alltimepr` — Post all-time power rankings",
          "`/recenth2h @user` — View a user's recent game results",
          "`/admin-userstats @user` — View detailed stats for any user",
          "`/admin-listuserteams` — List all registered users and their linked teams",
          "",
          "📋 **PR Formula:** PR Score = **60%** × (W−L) + **40%** × Point Differential",
        ].join("\n"),
      },
      {
        name: "🔄 Resets",
        value: [
          "`/resetupgrades @user [type]` — Reset a user's attribute/devup/agereset counts for the current season",
          "`/admin-resetweek [week]` — Clear franchise game records and interviews for a week so members can re-qualify",
        ].join("\n"),
      },
      {
        name: "🎮 Game & Week Management",
        value: [
          "`/franchiseupdate` — Import the franchise ZIP to process game results and award payouts",
          "`/advanceweek [week]` — Advance the league to the specified week",
          "`/admin-gotw [winner] [opponent] [bonus]` — Award Game of the Week bonus coins",
          "`/admin-potw [player] [bonus]` — Award Player of the Week bonus coins",
          "`/admin-playoffs [on/off]` — Toggle playoff mode",
          "`/seasonschedule` — View the full season schedule",
          "`/nextopp [@user]` — View next opponent for yourself or any member",
        ].join("\n"),
      },
      {
        name: "💳 Transactions",
        value: [
          "`/admin-transactions @user [limit]` — View recent transaction history for a user",
        ].join("\n"),
      },
    )
    .setFooter({ text: "Admin commands are only visible to bot admins and server administrators." })
    .setTimestamp();

  return interaction.reply({
    embeds: [memberEmbed, adminEmbed],
    ephemeral: true,
  });
}
