import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser, getOrCreateActiveSeason, getSeasonRules } from "../../lib/db/db-helpers.js";
import { getServerSettings, type ServerSettings } from "../../lib/db/server-settings.js";

type SeasonRulesShape = { [k: string]: unknown };

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

// ── Shared embed builder (also used by init_post_help button to seed #help-and-faqs) ──
export function buildMemberHelpEmbed(
  settings?: ServerSettings | null,
  rules?: SeasonRulesShape | null,
): EmbedBuilder {
  const economy     = settings?.coinEconomy           ?? true;
  const legends     = economy && (settings?.legendsEnabled            ?? true);
  const custom      = economy && (settings?.customSuperstarsEnabled   ?? true);
  const devUpgrades = economy && (settings?.devUpgradesEnabled        ?? true);
  const ageResets   = economy && (settings?.ageResetsEnabled          ?? true);
  const wagers      = economy && (settings?.wagerEnabled              ?? true);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🏈 REC League Econo-Bot — Member Commands");

  if (economy) {
    const econLines = [
      "Use **/menu** to check your coin balance, send coins, manage savings, and place wagers",
    ];
    if (wagers) econLines.push("  → **/menu → Wager** — Challenge a player to a coin wager");
    embed.addFields({ name: "💰 Economy", value: econLines.join("\n") });
  }

  // Store — commands section (only if economy is on and at least one item type is enabled)
  const storeCommands: string[] = ["**/menu → Purchase** — Browse the store and manage your inventory"];
  if (legends)      storeCommands.push("`/buy-legend [name]` — Buy a legend player");
  if (devUpgrades)  storeCommands.push("`/buy-devup [player] [type]` — Dev upgrade (Star / Superstar / X-Factor)");
  if (ageResets)    storeCommands.push("`/buy-agereset [player]` — Reset a player's age");
  if (custom)       storeCommands.push("`/buy-customplayer` — Build and buy a custom player slot");

  if (economy) {
    embed.addFields({ name: "🛒 Store — Commands", value: storeCommands.join("\n") });

    const pricingLines: string[] = [];
    if (legends)      pricingLines.push("• **Legends** — 2,000 coins | 2 max per team | available Weeks 1–9");
    if (devUpgrades)  pricingLines.push("• **Dev Upgrades** — 750 coins | 1/season");
    if (ageResets)    pricingLines.push("• **Age Resets** — 1,000 coins | 1/season");
    if (custom)       pricingLines.push("• **Custom Players** — Bronze/Silver/Gold tiers | 1/season | available Weeks 1–9");
    pricingLines.push(
      "• **Training Packages** — Bronze 250 / Silver 500 / Gold 1,000 coins | available all season (subject to purchase cap)",
      "",
      "⚠️ *Commissioners may adjust prices per season.*",
    );

    if (pricingLines.length > 2) {
      embed.addFields({ name: "🛒 Store — Default Pricing & Limits", value: pricingLines.join("\n") });
    }

    embed.addFields({
      name: "🏆 Game Payouts",
      value: [
        "**Payouts are issued automatically** when game data is uploaded via the Madden Companion App.",
        "  → H2H Win **+50 coins** | H2H Loss **+20 coins** | CPU Win **+20 coins**",
        "",
        "**/menu → Interview** — Submit a post-game interview for **+10 coins**",
        "  → One per week · Game must be uploaded from MCA first",
        "  → H2H players get an expanded question pool",
        "  → All interview payouts require commissioner approval",
      ].join("\n"),
    });
  }

  embed.addFields(
    {
      name: "📊 Rankings & Stats",
      value: [
        "`/userstats [@user]` — Detailed season stats for yourself or any member",
        "`/h2hrecord @user` — View H2H record vs another member",
        "`/seasonpr` — Current season power rankings",
        "`/alltimepr` — All-time power rankings across all seasons",
        "`/globalrecords` — This server's members ranked globally (W/L, PD, wallet, SB)",
        "`/availableupgrades` — See remaining upgrades + which core attrs are locked per player",
      ].join("\n"),
    },
    {
      name: "📅 Schedule, Teams & Rules",
      value: [
        "**/menu → Schedule** — Full current-season schedule (private, visible only to you)",
        "**/menu → Rules** — Browse the full league rulebook",
        "**/menu → Standings** — Current season standings with In The Hunt & Teams to Watch",
        "**/menu → Rosters** — Browse any team's roster, All Players, Free Agents, and player cards",
      ].join("\n"),
    },
  );

  embed
    .setFooter({ text: "Use /menu to make purchases. Purchases go to the commissioner for approval." })
    .setTimestamp();

  return embed;
}

// ── Execute ────────────────────────────────────────────────────────────────────
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

    // ── Fetch guild-specific settings + season rules ──────────────────────────
    const [settings, activeSeason] = await Promise.all([
      getServerSettings(interaction.guildId!).catch(() => null),
      getOrCreateActiveSeason(interaction.guildId!).catch(() => null),
    ]);
    const rules = activeSeason ? await getSeasonRules(activeSeason).catch(() => null) : null;

    // ── Non-admins always get member help ─────────────────────────────────────
    if (!isAdmin) {
      if (section === "admin") {
        await interaction.reply({
          content: "❌ Commissioner access is required to view admin commands.",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ embeds: [buildMemberHelpEmbed(settings, rules)], ephemeral });
      return;
    }

    // ── Admin chose member section ─────────────────────────────────────────────
    if (section === "member") {
      await interaction.reply({ embeds: [buildMemberHelpEmbed(settings, rules)], ephemeral });
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
          name: "📅 Season — Cost & Cap Overrides",
          value: [
            "**`/season override [options]`** — Adjust costs/caps for the current season only:",
            "`dev_ups_cost` `dev_ups_cap` `age_resets_cost` `age_resets_cap`",
            "`legend_cost` `custom_gold_cost` `custom_silver_cost` `custom_bronze_cost`",
            "`clear:True` — restore all defaults",
          ].join("\n"),
        },
        {
          name: "📊 Records & Power Rankings",
          value: [
            "`/admin-userstats @user` — View detailed stats for any user",
            "`/admin-listuserteams` — List all registered users and linked teams",
            "`/seasonpr` — Post current season power rankings",
            "`/alltimepr` — Post all-time power rankings",
            "`/globalrecords` — This server's players ranked globally (W/L, PD, SB, wallet)",
            "📋 **PR Formula:** 60% × (W−L) + 40% × Point Differential",
          ].join("\n"),
        },
        {
          name: "🔄 MCA Webhook & Full Sync",
          value: [
            "**MCA webhook URL** — View via `/adminserver` → Server Settings or the Admin Operations hub",
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
            "**Post Custom Article** — Available via the Admin Operations hub (`/admin-operations`)",
            "**Post Matchups/GOTW** — Available via the Admin Operations hub (`/admin-operations`)",
            "`/endofseasonpayout` — Run end-of-season playoff ranking bonuses",
            "Playoff flows (seeds, division bonus, matchups, payouts) run **automatically** when advancing weeks",
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
