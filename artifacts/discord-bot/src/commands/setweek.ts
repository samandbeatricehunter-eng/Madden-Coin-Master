import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const data = new SlashCommandBuilder()
  .setName("setweek")
  .setDescription("Manually set the current league week without any server changes (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("week")
      .setDescription("The week to set")
      .setRequired(true)
      .addChoices(
        { name: "Week 1",        value: "1"  },
        { name: "Week 2",        value: "2"  },
        { name: "Week 3",        value: "3"  },
        { name: "Week 4",        value: "4"  },
        { name: "Week 5",        value: "5"  },
        { name: "Week 6",        value: "6"  },
        { name: "Week 7",        value: "7"  },
        { name: "Week 8",        value: "8"  },
        { name: "Week 9",        value: "9"  },
        { name: "Week 10",       value: "10" },
        { name: "Week 11",       value: "11" },
        { name: "Week 12",       value: "12" },
        { name: "Week 13",       value: "13" },
        { name: "Week 14",       value: "14" },
        { name: "Week 15",       value: "15" },
        { name: "Week 16",       value: "16" },
        { name: "Week 17",       value: "17" },
        { name: "Week 18",       value: "18" },
        { name: "Wildcard",      value: "wildcard"    },
        { name: "Divisional",    value: "divisional"  },
        { name: "Conference",    value: "conference"  },
        { name: "Super Bowl",    value: "superbowl"   },
        { name: "Offseason",     value: "offseason"   },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member         = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const newWeek = interaction.options.getString("week", true);
  const season  = await getOrCreateActiveSeason();

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  await interaction.editReply({
    content: `✅ Week set to **${weekLabel(newWeek)}** (season ${season.seasonNumber ?? season.id}). No channels, payouts, or server changes were made.`,
  });
}
