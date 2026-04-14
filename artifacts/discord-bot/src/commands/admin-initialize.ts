/**
 * /initialize-server — One-time server setup wizard for new REC League servers.
 *
 * Phase 1 (automatic):
 *   - Creates Commissioner + Co-Commissioner roles (if missing)
 *   - Creates the full category/channel structure mirroring the primary server
 *   - Sets channel permissions (info channels read-only, commissioner channel private)
 *   - Creates Season 1 in the DB for this guild if no season exists yet
 *
 * Phase 2 (interactive buttons embedded in the summary):
 *   - Feature settings toggle
 *   - Team linking guide
 *   - EA Direct Connect instructions
 *   - Payout config pointer
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, OverwriteResolvable,
  Guild, Role, CategoryChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

// ── Channel blueprint ────────────────────────────────────────────────────────
// Mirrors the primary REC League Discord server structure.
// readOnly: @everyone can read but not send messages
// private:  @everyone has no access — Commissioner role only

interface ChannelDef {
  name: string;
  topic?: string;
  readOnly?: boolean;
  private?: boolean;
}

interface CategoryDef {
  name: string;
  private?: boolean;
  channels: ChannelDef[];
}

const SERVER_BLUEPRINT: CategoryDef[] = [
  {
    name: "📢 INFORMATION",
    channels: [
      { name: "rules",           topic: "League rules — use /rules to view sections",          readOnly: true  },
      { name: "announcements",   topic: "Commissioner announcements",                          readOnly: true  },
      { name: "season-schedule", topic: "Full season schedule — posted by bot each new season", readOnly: true  },
      { name: "standings",       topic: "Live league standings",                               readOnly: true  },
    ],
  },
  {
    name: "🏈 LEAGUE HUB",
    channels: [
      { name: "general",      topic: "General league discussion"       },
      { name: "transactions", topic: "Trades, signings, and releases — bot-posted", readOnly: true },
      { name: "trade-block",  topic: "Use /tradeblock to list or browse trades"     },
      { name: "trash-talk",   topic: "Trash talk goes here — keep it friendly"      },
    ],
  },
  {
    name: "🎮 GAME WEEK",
    channels: [
      { name: "matchups",      topic: "Weekly matchup embeds — posted by bot",          readOnly: true },
      { name: "gotw-voting",   topic: "Game of the Week poll — highest-stakes matchup"               },
      { name: "league-twitter", topic: "AI-generated league news feed — League Twitter", readOnly: true },
    ],
  },
  {
    name: "📊 STATS & AWARDS",
    channels: [
      { name: "stat-leaders",  topic: "Top performers each week — use /view player_stats", readOnly: true },
      { name: "headlines",     topic: "Season recap headlines posted by bot",              readOnly: true },
      { name: "draft-tracker", topic: "Legend and custom player draft tracker",            readOnly: true },
    ],
  },
  {
    name: "💰 ECONOMY",
    channels: [
      { name: "store",   topic: "Use /view store to see available legends & upgrades" },
      { name: "payouts", topic: "End-of-season payouts posted here by bot"            },
      { name: "savings", topic: "Use /savings to check your coin savings progress"    },
    ],
  },
  {
    name: "🏆 SEASON AWARDS",
    channels: [
      { name: "goty-candidates", topic: "Game of the Year candidates — voted on during playoffs" },
    ],
  },
  {
    name: "🔒 COMMISSIONER",
    private: true,
    channels: [
      { name: "commissioner-chat", topic: "Private commissioner coordination channel", private: true },
      { name: "violation-log",     topic: "Stat padding violations & rule infractions", private: true },
    ],
  },
];

// ── Friendly names for the setup checklist embed ────────────────────────────
const SETUP_STEPS = [
  { step: "1", icon: "✅", label: "Channels & roles created", done: true },
  { step: "2", icon: "⚙️", label: "Configure feature settings (Economy, Wagers, MCA, etc.)" },
  { step: "3", icon: "👥", label: "Link each manager to their NFL team (`/admin-linkteam set`)" },
  { step: "4", icon: "🔗", label: "Connect to EA for automatic data imports (`/admin_ea_connect start`)" },
  { step: "5", icon: "📤", label: "Or set up MCA webhook URL if using manual export (`/webhookurl`)" },
  { step: "6", icon: "💰", label: "Configure end-of-season payout tiers (`/admin-setpayouts`)" },
  { step: "7", icon: "🏈", label: "Import league teams + rosters from EA (`/admin_ea_export` or MCA)" },
  { step: "8", icon: "📋", label: "Customize league rules for your league (`/rules` → section editor)" },
  { step: "9", icon: "🏆", label: "Post opening week schedule (`/admin-postfullseasonschedule`)" },
];

// ── Command definition ───────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("initialize-server")
  .setDescription("First-time server setup: creates channels, roles, and walks through configuration")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption(o =>
    o.setName("confirm")
      .setDescription("Set to true to confirm you want to run first-time setup on this server")
      .setRequired(true),
  );

// ── Execute ──────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const confirm = interaction.options.getBoolean("confirm", true);
  if (!confirm) {
    await interaction.reply({
      content:
        "❌ You must set `confirm: true` to run server initialization. " +
        "This creates channels, roles, and a Season 1 record — run it only once on a new server.",
      ephemeral: true,
    });
    return;
  }

  // Permission check: Discord admin OR DB admin
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ Server initialization requires Administrator permission." });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ This command must be run inside a Discord server." });
    return;
  }

  await interaction.editReply({ content: "⏳ Starting server initialization… this may take 15–30 seconds." });

  const log: string[] = [];
  const channelMentions: Record<string, string> = {};

  try {
    // ── Step 1: Create roles ────────────────────────────────────────────────
    const commRole    = await ensureRole(guild, "Commissioner",    0xFFD700); // gold
    const coCommRole  = await ensureRole(guild, "Co-Commissioner", 0x4FC3F7); // light blue
    log.push(`Roles: **Commissioner** <@&${commRole.id}> · **Co-Commissioner** <@&${coCommRole.id}>`);

    // ── Step 2: Create categories and channels ──────────────────────────────
    for (const catDef of SERVER_BLUEPRINT) {
      // Reuse existing category if name matches, otherwise create
      const existingCat = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === catDef.name,
      ) as CategoryChannel | undefined;

      let category: CategoryChannel;
      if (existingCat) {
        category = existingCat;
        log.push(`↩️ Reused existing category: ${catDef.name}`);
      } else {
        const permOverwrites = catDef.private
          ? [
              { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
              { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
              { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ]
          : [];

        category = await guild.channels.create({
          name:                catDef.name,
          type:                ChannelType.GuildCategory,
          permissionOverwrites: permOverwrites,
        });
        log.push(`✅ Created category: ${catDef.name}`);
      }

      // Create channels within the category
      for (const chDef of catDef.channels) {
        const existing = guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.name === chDef.name && c.parentId === category.id,
        );
        if (existing) {
          channelMentions[chDef.name] = `<#${existing.id}>`;
          continue;
        }

        let permOverwrites: OverwriteResolvable[];
        if (chDef.private || catDef.private) {
          // Private: only Commissioner + Co-Commissioner roles can see
          permOverwrites = [
            { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
            { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
            { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ];
        } else if (chDef.readOnly) {
          // Read-only: everyone can view, only Commissioner/Co-Comm can post
          permOverwrites = [
            { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
            { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
            { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ];
        } else {
          // Normal public channel — inherits category permissions
          permOverwrites = [];
        }

        const created = await guild.channels.create({
          name:                 chDef.name,
          type:                 ChannelType.GuildText,
          parent:               category.id,
          topic:                chDef.topic,
          permissionOverwrites: permOverwrites,
        });
        channelMentions[chDef.name] = `<#${created.id}>`;
      }
    }

    // ── Step 3: Ensure Season 1 exists for this guild ───────────────────────
    const guildId = interaction.guildId!;
    const existingSeason = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(eq(seasonsTable.guildId, guildId))
      .limit(1);

    let seasonNote: string;
    if (existingSeason.length > 0) {
      seasonNote = `Season ${existingSeason[0]!.seasonNumber} already exists — no new season created.`;
    } else {
      await db.insert(seasonsTable).values({
        guildId:      guildId,
        seasonNumber: 1,
        isActive:     true,
      });
      seasonNote = "Season 1 created and set as active.";
    }
    log.push(`🗓️ ${seasonNote}`);

    // ── Step 4: Ensure server settings row exists ──────────────────────────
    await getServerSettings();

  } catch (err: any) {
    console.error("[initialize-server] Error during setup:", err);
    await interaction.editReply({
      content: `❌ An error occurred during initialization:\n\`\`\`${err?.message ?? String(err)}\`\`\`\nPartial setup may have completed — check the log above.`,
    });
    return;
  }

  // ── Build the summary embed ─────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 Server Initialized — REC League Bot Setup")
    .setDescription(
      "Your server structure has been created. Work through the checklist below to finish setup.\n\n" +
      SETUP_STEPS.map(s =>
        `**Step ${s.step}** ${s.icon} ${s.label}`,
      ).join("\n"),
    )
    .setTimestamp();

  // Channel reference card
  const channelCard = [
    `📢 ${channelMentions["announcements"] ?? "#announcements"} — Announcements`,
    `📋 ${channelMentions["rules"] ?? "#rules"} — League Rules`,
    `📅 ${channelMentions["season-schedule"] ?? "#season-schedule"} — Schedule`,
    `📊 ${channelMentions["standings"] ?? "#standings"} — Standings`,
    `💬 ${channelMentions["general"] ?? "#general"} — General`,
    `↔️ ${channelMentions["transactions"] ?? "#transactions"} — Transactions`,
    `🏟️ ${channelMentions["matchups"] ?? "#matchups"} — Matchups`,
    `🗳️ ${channelMentions["gotw-voting"] ?? "#gotw-voting"} — GOTW Voting`,
    `📰 ${channelMentions["league-twitter"] ?? "#league-twitter"} — League Twitter`,
    `📈 ${channelMentions["stat-leaders"] ?? "#stat-leaders"} — Stat Leaders`,
    `💰 ${channelMentions["store"] ?? "#store"} — Store`,
    `💵 ${channelMentions["payouts"] ?? "#payouts"} — Payouts`,
    `🔒 ${channelMentions["commissioner-chat"] ?? "#commissioner-chat"} — Commissioner (private)`,
    `⚠️ ${channelMentions["violation-log"] ?? "#violation-log"} — Violations (private)`,
  ].join("\n");

  embed.addFields(
    { name: "📌 Key Channels", value: channelCard, inline: false },
    {
      name: "⚠️ Important: Channel IDs",
      value:
        "The bot currently uses channel IDs from the primary server for automated posts " +
        "(matchups, schedule, payouts, GOTW). For full multi-server support, run each feature " +
        "command once in this server to allow the bot to auto-detect the correct channels, " +
        "or reach out to your bot admin to update the server's environment configuration.",
      inline: false,
    },
    {
      name: "📖 After Setup — Key Commands",
      value: [
        "`/admin-linkteam set` — Assign users to their NFL teams",
        "`/admin_ea_connect start` — Connect EA franchise for auto-imports",
        "`/webhookurl` — Get MCA webhook URL (if using manual MCA export)",
        "`/admin-setpayouts` — Configure EOS coin payouts",
        "`/rules` — View and customize league rules per section",
        "`/adminserver server_bot_settings` — Toggle economy features",
        "`/admin-season new` — Start Season 2 when ready",
      ].join("\n"),
      inline: false,
    },
  );

  embed.setFooter({ text: `Initialized by ${interaction.user.tag} • Guild ${interaction.guildId}` });

  // ── Interactive buttons ────────────────────────────────────────────────────
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("init_settings")
      .setLabel("⚙️ Configure Features")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("init_teamguide")
      .setLabel("👥 Team Linking Guide")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("init_ea")
      .setLabel("🔗 Connect EA")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("init_payouts")
      .setLabel("💰 Payout Guide")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [row1] });
}

// ── Role helper ───────────────────────────────────────────────────────────────
async function ensureRole(guild: Guild, name: string, color: number): Promise<Role> {
  const existing = guild.roles.cache.find(r => r.name === name);
  if (existing) return existing;
  return guild.roles.create({ name, color, reason: "REC League bot initialization" });
}
