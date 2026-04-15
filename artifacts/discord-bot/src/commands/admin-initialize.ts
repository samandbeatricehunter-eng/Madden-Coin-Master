/**
 * /initialize-server — One-time server setup wizard for new REC League servers.
 *
 * Creates the exact category/channel structure matching the primary REC League
 * server, assigns permissions, registers channel IDs in the DB, creates
 * Season 1, and seeds 32 NFL team placeholder slots.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, OverwriteResolvable,
  Guild, Role, CategoryChannel, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable, usersTable, serverSettingsTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { isAdminUser, setGuildChannel, CHANNEL_KEYS, DEFAULT_RULES, SECTION_META } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";
import { registerCommandsForGuild } from "../lib/register-commands.js";
import { NFL_TEAMS } from "../lib/constants.js";

// ── Channel name → DB key mapping ─────────────────────────────────────────────
const CHANNEL_KEY_MAP: Record<string, string> = {
  "welcome":               CHANNEL_KEYS.WELCOME,
  "league-announcements":  CHANNEL_KEYS.ANNOUNCEMENTS,
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
  name:               string;
  kind?:              ChannelKind;
  topic?:             string;
  readOnly?:          boolean;
  private?:           boolean;
  memberReadOnly?:    boolean; // Override: Approved Members can see + read but NOT write (even inside a private category)
  commissionerWrite?: boolean; // Approved Members/Co-Comm can read; only Commissioner can write
}

interface CategoryDef {
  name:     string;
  private?: boolean;
  channels: ChannelDef[];
}

// ── Standalone channels (no category parent) ───────────────────────────────────
const STANDALONE_CHANNELS: ChannelDef[] = [
  {
    name:     "welcome",
    topic:    "Welcome to the league — read the rules and introduce yourself!",
    readOnly: true,
  },
];

// ── Categories and their channels ─────────────────────────────────────────────
const SERVER_BLUEPRINT: CategoryDef[] = [
  {
    name: "🔒 MEMBERS ONLY",
    channels: [
      { name: "general-discussion",   topic: "General league discussion"                                              },
      { name: "member-league-chat",   topic: "Member-only league chat"                                               },
      { name: "league-announcements", topic: "Commissioner announcements",                    readOnly: true          },
      { name: "help-and-faqs",        topic: "Bot command guide and how-to resources for members", commissionerWrite: true },
    ],
  },
  {
    name: "🎙️ VOICE",
    channels: [
      { name: "Trash Talk", kind: "voice" },
    ],
  },
  {
    name: "🏈 GAMEDAY CENTER",
    channels: [
      { name: "season-schedule",       topic: "Full season schedule — posted by bot each new season", readOnly: true },
      { name: "weekly-matchups",       topic: "Weekly matchup embeds — posted by bot",                readOnly: true },
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
      { name: "position-change-requests", topic: "Legend and custom player position change tracker", memberReadOnly: true },
      { name: "commissioners-office",     topic: "Private commissioner coordination channel",                   private: true },
      { name: "commissioners-log",        topic: "Commissioner rulings and decisions",                          private: true },
      { name: "referral-log",             topic: "Member referral tracking",                                    private: true },
      { name: "violation-log",            topic: "Stat padding violations and rule infractions",                private: true },
      { name: "transactions-log",         topic: "All transactions — trades, signings, and releases", readOnly: true, private: true },
    ],
  },
  {
    name: "🏆 THE HALL OF FAME AND SHAME",
    channels: [],
  },
  {
    name: "🎊 END OF SEASON PAYOUTS",
    channels: [
      { name: "end-of-season-payouts", topic: "End-of-season coin payouts posted by bot", readOnly: true },
    ],
  },
];

// ── Setup checklist ────────────────────────────────────────────────────────────
const SETUP_STEPS = [
  { step: "1", icon: "✅", label: "Channels, roles, and team slots created"                                                         },
  { step: "2", icon: "⚙️", label: "Configure feature settings (Economy, Wagers, MCA, etc.)"                                        },
  { step: "3", icon: "👥", label: "Link each manager to their NFL team (`/admin-linkteam set`)"                                     },
  { step: "4", icon: "🔗", label: "Connect to EA for automatic data imports (`/admin_ea_connect start`)"                            },
  { step: "5", icon: "📤", label: "Or set up MCA webhook URL if using manual export (`/webhookurl`)"                                },
  { step: "6", icon: "💰", label: "Configure end-of-season payout tiers (`/admin-setpayouts`)"                                     },
  { step: "7", icon: "🏈", label: "Import league teams + rosters from EA (`/admin_ea_export` or MCA)"                              },
  { step: "8", icon: "📋", label: "Customize league rules for your league (`/rules` → section editor) — **be sure to fill in the League Info section with your in-game league name & password so members can join**" },
  { step: "9", icon: "🏆", label: "Post opening week schedule (`/admin-postfullseasonschedule`)"                                   },
];

// ── Command definition ─────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("initialize-server")
  .setDescription("First-time server setup: creates channels, roles, team slots, and walks through configuration")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption(o =>
    o.setName("confirm")
      .setDescription("Set to true to confirm you want to run first-time setup on this server")
      .setRequired(true),
  )
  .addStringOption(o =>
    o.setName("starting_week")
      .setDescription("What week should Season 1 start on? (default: Training Camp)")
      .setRequired(false)
      .addChoices(
        { name: "Training Camp (default)", value: "training_camp" },
        { name: "Week 1",                  value: "1"             },
        { name: "Week 2",                  value: "2"             },
        { name: "Week 3",                  value: "3"             },
        { name: "Week 4",                  value: "4"             },
        { name: "Week 5",                  value: "5"             },
        { name: "Week 6",                  value: "6"             },
        { name: "Week 7",                  value: "7"             },
        { name: "Week 8",                  value: "8"             },
        { name: "Week 9",                  value: "9"             },
        { name: "Week 10",                 value: "10"            },
        { name: "Week 11",                 value: "11"            },
        { name: "Week 12",                 value: "12"            },
        { name: "Week 13",                 value: "13"            },
        { name: "Week 14",                 value: "14"            },
        { name: "Week 15",                 value: "15"            },
        { name: "Week 16",                 value: "16"            },
        { name: "Week 17",                 value: "17"            },
        { name: "Week 18",                 value: "18"            },
        { name: "Wild Card",               value: "wildcard"      },
        { name: "Divisional Round",        value: "divisional"    },
        { name: "Conference Championship", value: "conference"    },
        { name: "Super Bowl",              value: "superbowl"     },
        { name: "Off-Season",              value: "offseason"     },
      ),
  )
  .addIntegerOption(o =>
    o.setName("franchise_length")
      .setDescription("Total number of seasons this franchise will run (default: 10)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(30),
  )
  .addIntegerOption(o =>
    o.setName("current_season")
      .setDescription("Starting season number — set above 1 if joining an existing franchise mid-run (default: 1)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(30),
  );

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const confirm             = interaction.options.getBoolean("confirm", true);
  const startingWeek        = interaction.options.getString("starting_week")  ?? "training_camp";
  const franchiseLength     = interaction.options.getInteger("franchise_length") ?? 10;
  const currentSeasonNumber = interaction.options.getInteger("current_season")   ?? 1;

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

  await interaction.editReply({ content: "⏳ Starting server initialization… this may take 30–60 seconds." });

  const guildId                                     = interaction.guildId!;
  const log: string[]                               = [];
  const channelMentions: Record<string, string>     = {};
  const channelIds: Record<string, string>          = {};

  try {
    // ── Step 1: Roles ──────────────────────────────────────────────────────────
    const commRole     = await ensureRole(guild, "Commissioner",    0x9B59B6); // Purple
    const coCommRole   = await ensureRole(guild, "Co-Commissioner", 0xFFD700); // Gold/Yellow
    const approvedRole = await ensureRole(guild, "Approved Member", 0xE74C3C); // Red
    log.push(
      `Roles: **Commissioner** <@&${commRole.id}> · **Co-Commissioner** <@&${coCommRole.id}> · **Approved Member** <@&${approvedRole.id}>`,
    );

    // ── Step 2: Delete all pre-existing channels ────────────────────────────────
    // Fetch fresh so we have everything including default "general" / voice channels.
    await guild.channels.fetch();
    const toDelete = [...guild.channels.cache.values()];
    let deleted = 0;
    for (const ch of toDelete) {
      await ch.delete("REC League initialization — clearing pre-existing channels").catch(() => null);
      deleted++;
    }
    log.push(`🗑️ Removed ${deleted} pre-existing channel(s)`);

    // ── Step 3: Standalone channels ────────────────────────────────────────────
    for (const chDef of STANDALONE_CHANNELS) {
      const perms = buildPerms(guild, commRole, coCommRole, approvedRole, chDef, false);
      const created = await guild.channels.create({
        name:                 chDef.name,
        type:                 ChannelType.GuildText,
        topic:                chDef.topic,
        permissionOverwrites: perms,
      });
      channelMentions[chDef.name] = `<#${created.id}>`;
      channelIds[chDef.name]      = created.id;
    }

    // ── Step 4: Categories and their channels ──────────────────────────────────
    for (const catDef of SERVER_BLUEPRINT) {
      const catPerms: OverwriteResolvable[] = catDef.private
        ? [
            { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
            { id: approvedRole,         deny:  [PermissionFlagsBits.ViewChannel] },
            { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
          ]
        : [
            { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
            { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
          ];

      const category: CategoryChannel = await guild.channels.create({
        name:                 catDef.name,
        type:                 ChannelType.GuildCategory,
        permissionOverwrites: catPerms,
      });
      log.push(`✅ Created category: ${catDef.name}`);

      for (const chDef of catDef.channels) {
        const isVoice = chDef.kind === "voice";
        const perms   = buildPerms(guild, commRole, coCommRole, approvedRole, chDef, catDef.private ?? false);

        if (isVoice) {
          await guild.channels.create({
            name:                 chDef.name,
            type:                 ChannelType.GuildVoice,
            parent:               category.id,
            permissionOverwrites: perms,
          });
        } else {
          const created = await guild.channels.create({
            name:                 chDef.name,
            type:                 ChannelType.GuildText,
            parent:               category.id,
            topic:                chDef.topic,
            permissionOverwrites: perms,
          });
          channelMentions[chDef.name] = `<#${created.id}>`;
          channelIds[chDef.name]      = created.id;
        }
      }
    }

    // ── Step 5: Save channel IDs to DB ─────────────────────────────────────────
    const saves: Promise<void>[] = [];
    for (const [name, id] of Object.entries(channelIds)) {
      const key = CHANNEL_KEY_MAP[name];
      if (key) saves.push(setGuildChannel(guildId, key, id));
    }
    await Promise.all(saves);
    log.push(`💾 Saved ${saves.length} channel IDs to database`);

    // ── Step 6: Season 1 ───────────────────────────────────────────────────────
    const existingSeasons = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(eq(seasonsTable.guildId, guildId))
      .limit(1);

    let seasonNote: string;
    if (existingSeasons.length > 0) {
      seasonNote = `Season ${existingSeasons[0]!.seasonNumber} already exists — no new season created.`;
    } else {
      await db.insert(seasonsTable).values({ guildId, seasonNumber: currentSeasonNumber, isActive: true, currentWeek: startingWeek });
      const weekLabel = startingWeek.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      seasonNote = `Season **${currentSeasonNumber}** of **${franchiseLength}** created — starting on **${weekLabel}**.`;
    }
    log.push(`🗓️ ${seasonNote}`);

    // ── Step 7: Server settings row + franchise length ─────────────────────────
    await getServerSettings(); // ensures the row exists
    await db.update(serverSettingsTable)
      .set({ maxSeasons: franchiseLength })
      .where(eq(serverSettingsTable.guildId, "global"));

    // ── Step 8: Seed 32 NFL team placeholder slots ─────────────────────────────
    // Only seed teams that don't already have a real (non-placeholder) user.
    const realTeamRows = await db
      .select({ team: usersTable.team, discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

    const realTeams = new Set(
      realTeamRows
        .filter(r => !r.discordId.startsWith("unlinked_"))
        .map(r => r.team!),
    );

    const teamsToSeed = (NFL_TEAMS as readonly string[]).filter(t => !realTeams.has(t));

    if (teamsToSeed.length > 0) {
      await db.insert(usersTable).values(
        teamsToSeed.map(team => ({
          discordId:            `unlinked_${team.toLowerCase()}`,
          guildId,
          discordUsername:      "Open Slot",
          team,
          balance:              0,
          totalLegendPurchases: 0,
        })),
      ).onConflictDoNothing();
      log.push(`🏈 Seeded ${teamsToSeed.length} open team slot(s) (${NFL_TEAMS.length - teamsToSeed.length} already claimed)`);
    }

    // ── Step 9: Post admin setup guide to #welcome ─────────────────────────────
    const welcomeId = channelIds["welcome"];
    if (welcomeId) {
      try {
        const welcomeCh = await interaction.client.channels.fetch(welcomeId).catch(() => null);
        if (welcomeCh?.isTextBased()) {
          const tc = welcomeCh as TextChannel;
          const setupGuideEmbed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle("⚙️ Commissioner Setup Checklist")
            .setDescription(
              `<@${interaction.user.id}> — Work through these steps to finish setting up the league bot. ` +
              "Once everything is configured, use the **📋 Post Help Guide** button in your setup reply to publish the member command guide to <#" +
              (channelIds["help-and-faqs"] ?? "help-and-faqs") + ">.\n\u200b",
            )
            .addFields(
              {
                name: "1️⃣  Configure Feature Settings",
                value: "Toggle the coin economy, legends, custom players, wagers, and other features on or off.\n" +
                       "```/adminserver server_bot_settings```",
              },
              {
                name: "2️⃣  Update League Info Rules",
                value: "Add your **in-game Madden league name and password** so members can find and join.\n" +
                       "```/adminrules set league_info 1 \"League Name: [name] | Password: [password]\"```",
              },
              {
                name: "3️⃣  Review & Edit All Rule Sections",
                value: "Browse every rule section and customize for your league.\n" +
                       "```/rules [section]``` to view  ·  ```/adminrules set [section] [#] [text]``` to edit",
              },
              {
                name: "4️⃣  Configure Weekly Payout Amounts",
                value: "Set how many coins are awarded for H2H wins, losses, and CPU wins.\n" +
                       "```/admin-setpayouts```",
              },
              {
                name: "5️⃣  Configure End-of-Season Payouts",
                value: "Set coin prizes for champion, runner-up, playoff teams, and stat milestones.\n" +
                       "```/admin-setpayouts```  ·  ```/admin-set-stat-tiers```",
              },
              {
                name: "6️⃣  Link Managers to Their NFL Teams",
                value: "Assign each Discord member to their franchise. Repeat for every manager.\n" +
                       "```/admin-linkteam set  user:@Member  team:Dallas Cowboys```",
              },
              {
                name: "7️⃣  Connect EA / Import Rosters",
                value: "Pull franchise data so stats, schedules, and rosters are live.\n" +
                       "```/admin_ea_connect start``` — EA Direct  ·  ```/webhookurl``` — MCA Webhook",
              },
              {
                name: "8️⃣  Post Opening Schedule",
                value: "```/admin-postfullseasonschedule```",
              },
              {
                name: "✅  Post Help Guide to #help-and-faqs",
                value: "When all steps above are complete, click the **📋 Post Help Guide** button in your initialization reply to publish the member command guide.",
              },
            )
            .setFooter({ text: `Server initialized by ${interaction.user.tag}` })
            .setTimestamp();
          const guideMsg = await tc.send({ embeds: [setupGuideEmbed] });
          await guideMsg.pin().catch(() => null);
          log.push(`📌 Posted admin setup guide in <#${welcomeId}>`);
        }
      } catch (guideErr) {
        log.push(`⚠️ Could not post setup guide to #welcome: ${(guideErr as Error).message}`);
      }
    }

    // ── Step 10: Post all rule sections to #league-announcements ───────────────
    const announceId = channelIds["league-announcements"];
    if (announceId) {
      try {
        const announceCh = await interaction.client.channels.fetch(announceId).catch(() => null);
        if (announceCh?.isTextBased()) {
          const tc = announceCh as TextChannel;
          for (const sectionKey of Object.keys(DEFAULT_RULES)) {
            const meta  = SECTION_META[sectionKey];
            const rules = DEFAULT_RULES[sectionKey];
            if (!meta || !rules?.length) continue;
            const desc = rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n\n");
            const chunks: string[] = [];
            let current = "";
            for (const line of desc.split("\n")) {
              if ((current + "\n" + line).length > 3900) {
                chunks.push(current);
                current = line;
              } else {
                current += (current ? "\n" : "") + line;
              }
            }
            if (current) chunks.push(current);
            for (let ci = 0; ci < chunks.length; ci++) {
              const isFirst = ci === 0;
              const rulesEmbed = new EmbedBuilder()
                .setColor(meta.color)
                .setTitle(isFirst ? meta.title : `${meta.title} (cont.)`)
                .setDescription(chunks[ci]!)
                .setTimestamp();
              await tc.send({ content: isFirst ? "@everyone" : undefined, embeds: [rulesEmbed] });
              await new Promise(res => setTimeout(res, 600));
            }
          }
          log.push(`📋 Posted all rule sections to <#${announceId}> with @everyone`);
        }
      } catch (ruleErr) {
        log.push(`⚠️ Could not post rules to #league-announcements: ${(ruleErr as Error).message}`);
      }
    }

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
    `💬 ${channelMentions["general-discussion"]       ?? "#general-discussion"}     — General`,
    `📅 ${channelMentions["season-schedule"]           ?? "#season-schedule"}         — Schedule`,
    `🏟️ ${channelMentions["weekly-matchups"]           ?? "#weekly-matchups"}         — Matchups`,
    `🗳️ ${channelMentions["weekly-gotw-spotlight"]     ?? "#weekly-gotw-spotlight"}   — GOTW Spotlight`,
    `🐦 ${channelMentions["league-twitter"]            ?? "#league-twitter"}          — League Twitter`,
    `📰 ${channelMentions["league-headlines"]          ?? "#league-headlines"}        — Headlines`,
    `🆚 ${channelMentions["h2h-goty-candidates"]       ?? "#h2h-goty-candidates"}     — GOTY`,
    `📋 ${channelMentions["position-change-requests"]  ?? "#position-change-requests"} — Position Changes`,
    `🔒 ${channelMentions["commissioners-office"]      ?? "#commissioners-office"}    — Commissioner (private)`,
    `⚠️ ${channelMentions["violation-log"]             ?? "#violation-log"}           — Violations (private)`,
    `💱 ${channelMentions["transactions-log"]          ?? "#transactions-log"}        — Transactions (private)`,
    `🎊 ${channelMentions["end-of-season-payouts"]     ?? "#end-of-season-payouts"}   — EOS Payouts`,
  ].join("\n");

  embed.addFields(
    { name: "📌 Key Channels", value: channelCard, inline: false },
    {
      name: "🎭 Roles Created",
      value: [
        "**Commissioner** — Full access, manages all channels",
        "**Co-Commissioner** — Same access as Commissioner (no ManageMessages)",
        "**Approved Member** — Access to all non-private member channels",
        "\n*Assign **Approved Member** to each new member so they can see the server.*",
      ].join("\n"),
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

  // ── Self-admin: automatically set the initializing user as a bot admin ──────
  try {
    const adminId  = interaction.user.id;
    const guildId2 = interaction.guildId!;
    const existing = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.discordId, adminId), eq(usersTable.guildId, guildId2)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(usersTable)
        .set({ isAdmin: true })
        .where(and(eq(usersTable.discordId, adminId), eq(usersTable.guildId, guildId2)));
    } else {
      await db
        .insert(usersTable)
        .values({ discordId: adminId, guildId: guildId2, discordUsername: interaction.user.username, isAdmin: true })
        .onConflictDoNothing();
    }
    console.log(`[initialize-server] Set ${interaction.user.tag} as bot admin`);
  } catch (err) {
    console.error("[initialize-server] Failed to set self as admin:", err);
  }

  embed.addFields({
    name: "📋 League Info Rules Section",
    value: [
      "A **League Info** rules section has been added automatically.",
      "Use it to store your **in-game Madden league name and password** so members can find and join the league.",
      "",
      "> **Update it now:**",
      "> `/adminrules set league_info 1 \"League Name: [name] | Password: [password]\"`",
    ].join("\n"),
    inline: false,
  });

  embed.addFields({
    name: "🔐 Bot Admin Access",
    value: [
      `You (<@${interaction.user.id}>) have been set as a **bot admin** automatically.`,
      "This grants you access to all admin commands regardless of Discord role.",
      "You can grant admin access to others via `/admin set_admin_role`.",
    ].join("\n"),
    inline: false,
  });

  embed.setFooter({ text: `Initialized by ${interaction.user.tag} • Guild ${interaction.guildId}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("init_settings")  .setLabel("⚙️ Configure Features").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("init_teamguide") .setLabel("👥 Team Linking Guide") .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("init_ea")        .setLabel("🔗 Connect EA")         .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("init_payouts")   .setLabel("💰 Payout Guide")       .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("init_post_help") .setLabel("📋 Post Help Guide")    .setStyle(ButtonStyle.Success),
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [row] });

  // Deploy slash commands for this guild now that setup is complete
  try {
    await registerCommandsForGuild(interaction.guildId!);
    console.log(`[initialize-server] Commands deployed for guild ${interaction.guildId}`);
  } catch (err) {
    console.error("[initialize-server] Command deployment failed:", err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function ensureRole(guild: Guild, name: string, color: number): Promise<Role> {
  const existing = guild.roles.cache.find(r => r.name === name);
  if (existing) {
    if (existing.color !== color) {
      await existing.edit({ color }).catch(() => null);
    }
    return existing;
  }
  return guild.roles.create({ name, color, reason: "REC League bot initialization" });
}

function buildPerms(
  guild:        Guild,
  commRole:     Role,
  coCommRole:   Role,
  approvedRole: Role,
  chDef:        ChannelDef,
  catPrivate:   boolean,
): OverwriteResolvable[] {
  const isPrivate = (chDef.private === true) || (catPrivate && !chDef.memberReadOnly);

  // memberReadOnly channels — Approved Members can view/read but NOT write (overrides category privacy)
  if (chDef.memberReadOnly) {
    return [
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ];
  }

  // Commissioner-write channels — members/co-comm can read, only Commissioner can send
  if (chDef.commissionerWrite) {
    return [
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
  }

  // #welcome — the only public channel (@everyone can view, no one can send)
  if (chDef.name === "welcome") {
    return [
      { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
      { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ];
  }

  // Private channels — Approved Members cannot see
  if (isPrivate) {
    return [
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: approvedRole,         deny:  [PermissionFlagsBits.ViewChannel] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ];
  }

  // Read-only member channels
  if (chDef.readOnly) {
    return [
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
      { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ];
  }

  // Standard member channel (read + write)
  return [
    { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
    { id: approvedRole,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: coCommRole,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: commRole,             allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
  ];
}
