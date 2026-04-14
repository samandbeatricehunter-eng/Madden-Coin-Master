/**
 * /initialize-server — One-time server setup wizard for new REC League servers.
 *
 * Creates the exact category/channel structure matching the primary REC League
 * server, assigns permissions, registers channel IDs in the DB, and creates
 * Season 1 for the new guild.
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
import { isAdminUser, setGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

// ── Channel name → DB key mapping ─────────────────────────────────────────────
// Must exactly match the `name` fields in SERVER_BLUEPRINT below.
const CHANNEL_KEY_MAP: Record<string, string> = {
  "general-discussion":    CHANNEL_KEYS.GENERAL,
  "season-schedule":       CHANNEL_KEYS.SCHEDULE,
  "weekly-matchups":       CHANNEL_KEYS.MATCHUPS,
  "weekly-gotw-spotlight":    CHANNEL_KEYS.GOTW,
  "league-twitter":           CHANNEL_KEYS.LEAGUE_TWITTER,
  "league-headlines":         CHANNEL_KEYS.HEADLINES,
  "h2h-goty-candidates":      CHANNEL_KEYS.GOTY,
  "position-change-requests": CHANNEL_KEYS.DRAFT_TRACKER,
  "commissioners-office":     CHANNEL_KEYS.COMMISSIONER,
  "violation-log":         CHANNEL_KEYS.VIOLATION_LOG,
  "transactions-log":      CHANNEL_KEYS.TRANSACTIONS,
  "end-of-season-payouts": CHANNEL_KEYS.PAYOUTS,
};

// ── Type definitions ───────────────────────────────────────────────────────────
type ChannelKind = "text" | "voice";

interface ChannelDef {
  name: string;
  kind?: ChannelKind;   // defaults to "text"
  topic?: string;
  readOnly?: boolean;   // @everyone can read, cannot send
  private?: boolean;    // @everyone cannot see at all
}

interface CategoryDef {
  name: string;
  private?: boolean;    // entire category hidden from @everyone
  channels: ChannelDef[];
}

// ── Standalone channels (no category parent) ───────────────────────────────────
// Created first so they appear at the top of the channel list.
const STANDALONE_CHANNELS: ChannelDef[] = [
  {
    name:     "welcome",
    topic:    "Welcome to the league — read the rules and introduce yourself!",
    readOnly: true,
  },
];

// ── Categories and their channels ─────────────────────────────────────────────
// Mirrors the primary REC League Discord server structure exactly.
const SERVER_BLUEPRINT: CategoryDef[] = [
  {
    name: "🔒 MEMBERS ONLY",
    channels: [
      { name: "general-discussion",  topic: "General league discussion"                                        },
      { name: "member-league-chat",  topic: "Member-only league chat"                                         },
      { name: "league-announcements",topic: "Commissioner announcements", readOnly: true                       },
    ],
  },
  {
    // Voice channel in its own category so it stays in order
    name: "🎙️ VOICE",
    channels: [
      { name: "Trash Talk", kind: "voice" },
    ],
  },
  {
    name: "🏈 GAMEDAY CENTER",
    channels: [
      { name: "season-schedule",   topic: "Full season schedule — posted by bot each new season", readOnly: true },
      { name: "weekly-matchups",   topic: "Weekly matchup embeds — posted by bot",                readOnly: true },
      { name: "weekly-gotw-spotlight", topic: "Game of the Week spotlight and poll"                              },
    ],
  },
  {
    name: "📰 R.E.C. LEAGUE MEDIA",
    channels: [
      { name: "league-twitter",      topic: "AI-generated league news feed",                    readOnly: true },
      { name: "league-headlines",    topic: "Season recap headlines posted by bot",             readOnly: true },
      { name: "highlights",          topic: "Share your best plays and highlights"                             },
      { name: "streams",             topic: "Post your stream links here"                                      },
      { name: "h2h-goty-candidates", topic: "Game of the Year candidates — voted on during playoffs"          },
    ],
  },
  {
    name: "🏢 FRONT OFFICE",
    private: true,
    channels: [
      { name: "position-change-requests", topic: "Legend and custom player position change tracker", readOnly: true, private: true },
      { name: "commissioners-office",    topic: "Private commissioner coordination channel",                   private: true },
      { name: "commissioners-log",       topic: "Commissioner rulings and decisions",                          private: true },
      { name: "referral-log",      topic: "Member referral tracking",                                         private: true },
      { name: "violation-log",     topic: "Stat padding violations and rule infractions",                     private: true },
      { name: "transactions-log",  topic: "All transactions — trades, signings, and releases", readOnly: true, private: true },
    ],
  },
  {
    name: "🏆 THE HALL OF FAME AND SHAME",
    channels: [
      { name: "the-quit-list",            topic: "Members who have left the league",            readOnly: true },
      { name: "historical-records-season",topic: "Season-by-season historical records",          readOnly: true },
      { name: "historical-records-alltime",topic: "All-time league records",                     readOnly: true },
    ],
  },
  {
    name: "🎊 END OF SEASON PAYOUTS",
    channels: [
      { name: "end-of-season-payouts", topic: "End-of-season coin payouts posted by bot", readOnly: true },
    ],
  },
];

// ── Setup checklist shown in the summary embed ─────────────────────────────────
const SETUP_STEPS = [
  { step: "1", icon: "✅", label: "Channels & roles created",                                                          done: true },
  { step: "2", icon: "⚙️", label: "Configure feature settings (Economy, Wagers, MCA, etc.)"                                       },
  { step: "3", icon: "👥", label: "Link each manager to their NFL team (`/admin-linkteam set`)"                                    },
  { step: "4", icon: "🔗", label: "Connect to EA for automatic data imports (`/admin_ea_connect start`)"                           },
  { step: "5", icon: "📤", label: "Or set up MCA webhook URL if using manual export (`/webhookurl`)"                               },
  { step: "6", icon: "💰", label: "Configure end-of-season payout tiers (`/admin-setpayouts`)"                                    },
  { step: "7", icon: "🏈", label: "Import league teams + rosters from EA (`/admin_ea_export` or MCA)"                             },
  { step: "8", icon: "📋", label: "Customize league rules for your league (`/rules` → section editor)"                            },
  { step: "9", icon: "🏆", label: "Post opening week schedule (`/admin-postfullseasonschedule`)"                                  },
];

// ── Command definition ─────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("initialize-server")
  .setDescription("First-time server setup: creates channels, roles, and walks through configuration")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption(o =>
    o.setName("confirm")
      .setDescription("Set to true to confirm you want to run first-time setup on this server")
      .setRequired(true),
  );

// ── Execute ────────────────────────────────────────────────────────────────────
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

  const guildId           = interaction.guildId!;
  const log: string[]                    = [];
  const channelMentions: Record<string, string> = {};
  const channelIds: Record<string, string>      = {};

  try {
    // ── Step 1: Roles ──────────────────────────────────────────────────────────
    const commRole   = await ensureRole(guild, "Commissioner",    0xFFD700);
    const coCommRole = await ensureRole(guild, "Co-Commissioner", 0x4FC3F7);
    log.push(`Roles: **Commissioner** <@&${commRole.id}> · **Co-Commissioner** <@&${coCommRole.id}>`);

    // ── Step 2: Standalone channels (no category) ──────────────────────────────
    for (const chDef of STANDALONE_CHANNELS) {
      const existing = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === chDef.name && !c.parentId,
      );
      if (existing) {
        channelMentions[chDef.name] = `<#${existing.id}>`;
        channelIds[chDef.name]      = existing.id;
        continue;
      }
      const perms = buildPerms(guild, commRole, coCommRole, chDef, false);
      const created = await guild.channels.create({
        name:                chDef.name,
        type:                ChannelType.GuildText,
        topic:               chDef.topic,
        permissionOverwrites: perms,
      });
      channelMentions[chDef.name] = `<#${created.id}>`;
      channelIds[chDef.name]      = created.id;
    }

    // ── Step 3: Categories and their channels ──────────────────────────────────
    for (const catDef of SERVER_BLUEPRINT) {
      const existingCat = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === catDef.name,
      ) as CategoryChannel | undefined;

      let category: CategoryChannel;
      if (existingCat) {
        category = existingCat;
        log.push(`↩️ Reused category: ${catDef.name}`);
      } else {
        const catPerms: OverwriteResolvable[] = catDef.private
          ? [
              { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
              { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
              { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ]
          : [];

        category = await guild.channels.create({
          name:                catDef.name,
          type:                ChannelType.GuildCategory,
          permissionOverwrites: catPerms,
        });
        log.push(`✅ Created category: ${catDef.name}`);
      }

      for (const chDef of catDef.channels) {
        const isVoice   = chDef.kind === "voice";
        const chType    = isVoice ? ChannelType.GuildVoice : ChannelType.GuildText;
        const existing  = guild.channels.cache.find(
          c => c.type === chType && c.name === chDef.name && c.parentId === category.id,
        );
        if (existing) {
          if (!isVoice) {
            channelMentions[chDef.name] = `<#${existing.id}>`;
            channelIds[chDef.name]      = existing.id;
          }
          continue;
        }

        const perms = buildPerms(guild, commRole, coCommRole, chDef, catDef.private ?? false);

        if (isVoice) {
          await guild.channels.create({
            name:                chDef.name,
            type:                ChannelType.GuildVoice,
            parent:              category.id,
            permissionOverwrites: perms,
          });
        } else {
          const created = await guild.channels.create({
            name:                chDef.name,
            type:                ChannelType.GuildText,
            parent:              category.id,
            topic:               chDef.topic,
            permissionOverwrites: perms,
          });
          channelMentions[chDef.name] = `<#${created.id}>`;
          channelIds[chDef.name]      = created.id;
        }
      }
    }

    // ── Step 4: Save channel IDs to DB ─────────────────────────────────────────
    const saves: Promise<void>[] = [];
    for (const [name, id] of Object.entries(channelIds)) {
      const key = CHANNEL_KEY_MAP[name];
      if (key) saves.push(setGuildChannel(guildId, key, id));
    }
    await Promise.all(saves);
    log.push(`💾 Saved ${saves.length} channel IDs to database`);

    // ── Step 5: Season 1 ───────────────────────────────────────────────────────
    const existing = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(eq(seasonsTable.guildId, guildId))
      .limit(1);

    let seasonNote: string;
    if (existing.length > 0) {
      seasonNote = `Season ${existing[0]!.seasonNumber} already exists — no new season created.`;
    } else {
      await db.insert(seasonsTable).values({ guildId, seasonNumber: 1, isActive: true });
      seasonNote = "Season 1 created and set as active.";
    }
    log.push(`🗓️ ${seasonNote}`);

    // ── Step 6: Server settings row ────────────────────────────────────────────
    await getServerSettings();

  } catch (err: any) {
    console.error("[initialize-server] Error during setup:", err);
    await interaction.editReply({
      content: `❌ An error occurred during initialization:\n\`\`\`${err?.message ?? String(err)}\`\`\`\nPartial setup may have completed — check above.`,
    });
    return;
  }

  // ── Build summary embed ────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 Server Initialized — REC League Bot Setup")
    .setDescription(
      "Your server structure has been created. Work through the checklist below to finish setup.\n\n" +
      SETUP_STEPS.map(s => `**Step ${s.step}** ${s.icon} ${s.label}`).join("\n"),
    )
    .setTimestamp();

  const channelCard = [
    `💬 ${channelMentions["general-discussion"]     ?? "#general-discussion"}     — General`,
    `📅 ${channelMentions["season-schedule"]         ?? "#season-schedule"}         — Schedule`,
    `🏟️ ${channelMentions["weekly-matchups"]         ?? "#weekly-matchups"}         — Matchups`,
    `🗳️ ${channelMentions["weekly-gotw-spotlight"]    ?? "#weekly-gotw-spotlight"}    — GOTW Spotlight`,
    `🐦 ${channelMentions["league-twitter"]          ?? "#league-twitter"}           — League Twitter`,
    `📰 ${channelMentions["league-headlines"]        ?? "#league-headlines"}         — Headlines`,
    `🆚 ${channelMentions["h2h-goty-candidates"]     ?? "#h2h-goty-candidates"}      — GOTY`,
    `📋 ${channelMentions["position-change-requests"] ?? "#position-change-requests"} — Position Changes`,
    `🔒 ${channelMentions["commissioners-office"]    ?? "#commissioners-office"}     — Commissioner (private)`,
    `⚠️ ${channelMentions["violation-log"]           ?? "#violation-log"}           — Violations (private)`,
    `💱 ${channelMentions["transactions-log"]        ?? "#transactions-log"}        — Transactions (private)`,
    `🎊 ${channelMentions["end-of-season-payouts"]   ?? "#end-of-season-payouts"}   — EOS Payouts`,
  ].join("\n");

  embed.addFields(
    { name: "📌 Key Channels", value: channelCard, inline: false },
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("init_settings") .setLabel("⚙️ Configure Features").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("init_teamguide").setLabel("👥 Team Linking Guide") .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("init_ea")       .setLabel("🔗 Connect EA")         .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("init_payouts")  .setLabel("💰 Payout Guide")       .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [row] });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function ensureRole(guild: Guild, name: string, color: number): Promise<Role> {
  const existing = guild.roles.cache.find(r => r.name === name);
  if (existing) return existing;
  return guild.roles.create({ name, color, reason: "REC League bot initialization" });
}

function buildPerms(
  guild:      Guild,
  commRole:   Role,
  coCommRole: Role,
  chDef:      ChannelDef,
  catPrivate: boolean,
): OverwriteResolvable[] {
  const isPrivate = chDef.private || catPrivate;
  if (isPrivate) {
    return [
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
  }
  if (chDef.readOnly) {
    return [
      { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
  }
  return [];
}
