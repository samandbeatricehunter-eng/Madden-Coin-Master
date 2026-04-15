import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("View all available bot commands")
  .addStringOption(o => o
    .setName("section")
    .setDescription("Which help section to view (admin section requires commissioner access)")
    .addChoices(
      { name: "Member Commands", value: "member" },
      { name: "Admin Commands",  value: "admin"  },
    )
    .setRequired(false),
  )
  .addBooleanOption(o => o
    .setName("public")
    .setDescription("Post the response publicly in the channel so others can see it (default: private)")
    .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const section   = interaction.options.getString("section") ?? "member";
    const isPublic  = interaction.options.getBoolean("public") ?? false;
    const ephemeral = !isPublic;

    const member = interaction.guild?.members.cache.get(interaction.user.id)
      ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

    const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
    const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);
    const isAdmin        = isDiscordAdmin || isDbAdmin;

    // ── Member embed ──────────────────────────────────────────────────────────
    const memberEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("🏈 REC League Econo-Bot — Member Commands")
      .addFields(
        {
          name: "💰 Economy",
          value: [
            "`/balance` — Check your current coin balance",
            "`/sendcoins @user [amount]` — Send coins to another player",
            "`/wager @user [amount]` — Challenge a player to a coin wager",
          ].join("\n"),
        },
        {
          name: "🛒 Store — Commands",
          value: [
            "`/viewstore` — Browse available items with current season prices",
            "`/purchase legend [name]` — Buy a legend player",
            "`/purchase attribute [player] [attr] [qty]` — Boost a player attribute",
            "`/purchase devup [player] [type] [qty]` — Dev upgrade (Star / Superstar)",
            "`/purchase agereset [player] [qty]` — Reset a player's age",
            "`/purchase customplayer [tier] [player]` — Buy a custom player slot",
            "`/inventory` — View your current season inventory",
            "`/availableupgrades` — See remaining upgrades for the season",
          ].join("\n"),
        },
        {
          name: "🛒 Store — Default Pricing & Limits",
          value: [
            "• **Legends** — 1,000 coins | 4 max all-time | max 4 in inventory",
            "• **Core Attributes** — 25 coins/pt | 16 pts/season",
            "• **Non-Core Attributes** — 10 coins/pt | 32 pts/season | Speed ≤5 pts/season",
            "• **Dev Upgrades** — 250 coins | 2/season",
            "• **Age Resets** — 250 coins | 2/season",
            "• **Custom Players** — Gold 300 / Silver 200 / Bronze 100 coins",
            "• Legends + Custom Players combined: max 4/season",
            "",
            "⚠️ *Commissioners may adjust any of these per season. Use `/viewstore` for live prices.*",
          ].join("\n"),
        },
        {
          name: "🏆 Game Payouts",
          value: [
            "**Payouts are issued automatically** when game data is uploaded via the Madden Companion App.",
            "  → H2H Win **+50 coins** | H2H Loss **+20 coins** | CPU Win **+20 coins**",
            "",
            "`/interviewrequest` — Submit a post-game interview for **+10 coins**",
            "  → One per week · Game must be uploaded from MCA first",
            "  → H2H players get an expanded question pool",
            "  → All interview payouts require commissioner approval",
          ].join("\n"),
        },
        {
          name: "📊 Rankings & Stats",
          value: [
            "`/userstats [@user]` — Detailed season stats for yourself or any member",
            "`/recenth2h @user` — View recent H2H game history",
            "`/seasonpr` — Current season power rankings",
            "`/alltimepr` — All-time power rankings across all seasons",
          ].join("\n"),
        },
        {
          name: "📅 Schedule & Teams",
          value: [
            "`/seasonschedule` — Full current-season schedule",
            "`/nextopp [@user]` — Your next opponent (or any member's)",
            "`/teamlist` — All members and their linked NFL teams",
            "`/openteams` — Unclaimed teams available for new members",
          ].join("\n"),
        },
        {
          name: "📋 League Rules",
          value: [
            "`/rules [section]` — Display all rules in a section",
            "`/rules [section] [rule_number]` — Quote a single rule",
            "`/rules [section] [rule_number] @user` — Share a rule with a member (posts publicly)",
          ].join("\n"),
        },
      )
      .setFooter({ text: "Use /viewstore for live prices. Purchases go to the commissioner for approval." })
      .setTimestamp();

    // ── Non-admins always get member help ─────────────────────────────────────
    if (!isAdmin) {
      if (section === "admin") {
        await interaction.reply({
          content: "❌ Commissioner access is required to view admin commands.",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ embeds: [memberEmbed], ephemeral });
      return;
    }

    // ── Admin chose member section ─────────────────────────────────────────────
    if (section === "member") {
      await interaction.reply({ embeds: [memberEmbed], ephemeral });
      return;
    }

    // ── Admin embed 1: User/Coin/Inventory/Legends/Rules ─────────────────────
    const adminEmbed1 = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⚙️ Admin Commands (1/2)")
      .addFields(
        {
          name: "👤 User Management",
          value: [
            "`/addnewuser @user [team] [balance]` — Register a new user and link their team",
            "`/deletemember [team]` — Permanently delete all data for a user",
            "`/setuser [team]` — Manually set any stat (coins, record, upgrades, etc.)",
            "`/setadmin @user [true/false]` — Grant or revoke bot-admin privileges",
            "`/clearteam @user` — Unlink a user from their team and clear season W/L",
            "`/admin-linkteam set @user [team]` — Safely assign a team without wiping data",
            "`/admin-linkteam view @user` — Show a user's current team link status",
          ].join("\n"),
        },
        {
          name: "💰 Coins & Transactions",
          value: [
            "`/addcoins [users] [amount]` — Add coins to up to 32 users at once",
            "`/removecoins @user [amount]` — Remove coins from a user's balance",
            "`/admin-transactions @user [limit]` — View recent transaction history",
            "`/admin-setpayouts [key] [value]` — Configure H2H win/loss/CPU win payout amounts",
          ].join("\n"),
        },
        {
          name: "📦 Inventory",
          value: [
            "`/admininventory view @user` — View inventory items with item IDs",
            "`/admininventory remove [item_id] [reason]` — Delete an inventory item",
            "`/admininventory move [item_id] @user` — Transfer an item to another user",
            "`/resetupgrades @user [type]` — Reset attribute/devup/agereset counts for the season",
          ].join("\n"),
        },
        {
          name: "🏆 Legends & Awards",
          value: [
            "`/legend add [name] [position] [cost]` — Add a legend to the store",
            "`/legend list` — View all legends (including sold/unavailable)",
            "`/legend edit [id]` — Edit a legend's details",
            "`/legend remove [id]` — Remove a legend from the catalog",
            "`/admin-legendvault` — View/manage the current-season and permanent vaults",
            "`/admin-gotw [winner] [opponent] [bonus]` — Award Game of the Week coins",
            "`/admin-potw [player] [bonus]` — Award Player of the Week coins",
          ].join("\n"),
        },
        {
          name: "📋 League Rules",
          value: [
            "`/adminrules new-section [key] [title]` — Create a new rules section",
            "`/adminrules list [section]` — Show rules with numbered entries",
            "`/adminrules set [section] [#] [text]` — Edit a rule by number",
            "`/adminrules add [section] [text]` — Append a new rule",
            "`/adminrules remove [section] [#]` — Remove a rule",
            "`/adminrules reset [section]` — Reset to defaults or clear a custom section",
          ].join("\n"),
        },
      );

    // ── Admin embed 2: Season/Records/MCA/Articles ────────────────────────────
    const adminEmbed2 = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⚙️ Admin Commands (2/2)")
      .addFields(
        {
          name: "📅 Season — Commands",
          value: [
            "`/season new` — Advance to the next season (max 5)",
            "`/season set [1–5]` — Jump to a specific season number",
            "`/season status` — View active season and all override settings",
            "`/season setbalance @user [amount]` — Set a user's exact coin balance",
            "`/season franchise-reset confirm:True` — ⚠️ End-of-franchise full reset",
            "`/admin-resetweek [week]` — Clear game records for a week so members can re-qualify",
            "`/setweek [week]` — Set the current league week",
          ].join("\n"),
        },
        {
          name: "📅 Season — Overrides & Core Attributes",
          value: [
            "**`/season override [options]`** — Adjust costs/caps for the current season only:",
            "`core_attr_cost` `core_attr_cap` `non_core_attr_cost` `non_core_attr_cap`",
            "`dev_ups_cost` `dev_ups_cap` `age_resets_cost` `age_resets_cap`",
            "`legend_cost` `custom_gold_cost` `custom_silver_cost` `custom_bronze_cost`",
            "`clear:True` — restore all defaults",
            "",
            "**`/season core-attrs [attr1]…[attr10]`** — Set which attributes count as Core this season",
            "Use `reset:True` to restore the default core attribute list.",
          ].join("\n"),
        },
        {
          name: "📊 Records & Power Rankings",
          value: [
            "`/admin-userstats @user` — View detailed stats for any user",
            "`/admin-listuserteams` — List all registered users and linked teams",
            "`/seasonpr` — Post current season power rankings",
            "`/alltimepr` — Post all-time power rankings",
            "📋 **PR Formula:** 60% × (W−L) + 40% × Point Differential",
          ].join("\n"),
        },
        {
          name: "🔄 MCA Webhook & Full Sync",
          value: [
            "`/webhookurl` — View the MCA webhook URL to paste into the Madden Companion App",
            "`/admin-catchup on` — Enable catchup mode (records stats only, no payouts)",
            "`/admin-catchup off` — Disable catchup mode (resume normal payouts)",
            "`/admin-catchup status` — Check whether catchup mode is active",
            "`/admin-fullsync` — Full sync: auto-link teams, process stored game files, award missed milestones",
            "`/admin-syncmilestones` — Check and award any missed career milestone bonuses",
          ].join("\n"),
        },
        {
          name: "📰 Articles & Weekly Posts",
          value: [
            "`/advanceweek [week]` — Advance the league week and post the recap article",
            "`/admin-resendarticle week:N` — Regenerate and post the recap for any previous week",
            "`/customarticle [prompt]` — Generate a custom AI article and post it to headlines",
            "`/endofseasonpayout` — Run end-of-season playoff ranking bonuses",
            "`/admin-playoffs [on/off]` — Toggle playoff mode on/off",
          ].join("\n"),
        },
      )
      .setFooter({ text: "Admin commands are only visible to bot admins and server administrators." })
      .setTimestamp();

    // Admin section — show both admin command pages
    await interaction.reply({ embeds: [adminEmbed1, adminEmbed2], ephemeral });
  } catch (err) {
    console.error("[/help] Error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `❌ Help failed: ${msg}` }).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ Help failed: ${msg}`, ephemeral: true }).catch(() => {});
    }
  }
}
