import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits, EmbedBuilder, Colors,
} from "discord.js";
import { isAdminUser, setGuildChannel, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";

export { getServerSettings, buildSettingsEmbed, buildSettingsRows } from "../lib/server-settings.js";

// Human-readable label → DB key for /adminserver link_channel
const LINKABLE_KEYS: Record<string, string> = {
  general:          CHANNEL_KEYS.GENERAL,
  announcements:    CHANNEL_KEYS.ANNOUNCEMENTS,
  welcome:          CHANNEL_KEYS.WELCOME,
  schedule:         CHANNEL_KEYS.SCHEDULE,
  matchups:         CHANNEL_KEYS.MATCHUPS,
  gotw:             CHANNEL_KEYS.GOTW,
  league_twitter:   CHANNEL_KEYS.LEAGUE_TWITTER,
  headlines:        CHANNEL_KEYS.HEADLINES,
  goty:             CHANNEL_KEYS.GOTY,
  draft_tracker:    CHANNEL_KEYS.DRAFT_TRACKER,
  commissioner:     CHANNEL_KEYS.COMMISSIONER,
  commissioner_log: CHANNEL_KEYS.COMMISSIONER_LOG,
  violation_log:    CHANNEL_KEYS.VIOLATION_LOG,
  transactions:     CHANNEL_KEYS.TRANSACTIONS,
  payouts:          CHANNEL_KEYS.PAYOUTS,
  stream:           CHANNEL_KEYS.STREAM,
  highlights:       CHANNEL_KEYS.HIGHLIGHTS,
};

export const data = new SlashCommandBuilder()
  .setName("adminserver")
  .setDescription("Server administration commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("link_channel")
      .setDescription("Register an existing Discord channel for a bot function (stream, highlights, gotw, etc.)")
      .addStringOption(o =>
        o.setName("key")
          .setDescription("Which bot function to link")
          .setRequired(true)
          .addChoices(
            { name: "stream",           value: "stream"           },
            { name: "highlights",       value: "highlights"       },
            { name: "gotw",             value: "gotw"             },
            { name: "league_twitter",   value: "league_twitter"   },
            { name: "matchups",         value: "matchups"         },
            { name: "schedule",         value: "schedule"         },
            { name: "headlines",        value: "headlines"        },
            { name: "goty",             value: "goty"             },
            { name: "draft_tracker",    value: "draft_tracker"    },
            { name: "commissioner",     value: "commissioner"     },
            { name: "commissioner_log", value: "commissioner_log" },
            { name: "violation_log",    value: "violation_log"    },
            { name: "transactions",     value: "transactions"     },
            { name: "payouts",          value: "payouts"          },
            { name: "announcements",    value: "announcements"    },
            { name: "welcome",          value: "welcome"          },
            { name: "general",          value: "general"          },
          )
      )
      .addChannelOption(o =>
        o.setName("channel")
          .setDescription("The Discord channel to register")
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("list_channels")
      .setDescription("List all bot-registered channels for this server")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  const member        = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });
    return;
  }

  if (sub === "link_channel") {
    const key     = interaction.options.getString("key", true);
    const channel = interaction.options.getChannel("channel", true);
    const dbKey   = LINKABLE_KEYS[key];
    if (!dbKey) {
      await interaction.reply({ content: `❌ Unknown channel key: \`${key}\``, ephemeral: true });
      return;
    }

    await setGuildChannel(interaction.guildId!, dbKey, channel.id);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Channel Registered")
          .setDescription(`**${key}** → <#${channel.id}> (ID: \`${channel.id}\`) has been saved for this server.`)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === "list_channels") {
    const keys = Object.keys(LINKABLE_KEYS);
    const resolved = await Promise.all(
      keys.map(async k => {
        const id = await getGuildChannel(interaction.guildId!, LINKABLE_KEYS[k]!);
        return { key: k, id };
      }),
    );

    const lines = resolved.map(r => r.id ? `\`${r.key}\` → <#${r.id}>` : `\`${r.key}\` → _not set_`);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle("📋 Registered Bot Channels")
          .setDescription(lines.join("\n"))
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }
}
