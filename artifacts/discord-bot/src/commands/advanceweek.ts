import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const WEEK_SEQUENCE = [
  "1","2","3","4","5","6","7","8","9","10",
  "11","12","13","14","15","16","17","18",
  "wildcard","divisional","conference","superbowl","offseason",
];

export function weekLabel(week: string): string {
  if (/^\d+$/.test(week)) return `Week ${week}`;
  return week.charAt(0).toUpperCase() + week.slice(1);
}

export const data = new SlashCommandBuilder()
  .setName("advanceweek")
  .setDescription("Advance or set the current league week (admin only)")
  .addStringOption(opt =>
    opt.setName("week")
      .setDescription("The week to set")
      .setRequired(false)
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

  const member        = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const season = await getOrCreateActiveSeason();
  const chosenWeek = interaction.options.getString("week");

  let newWeek: string;

  if (chosenWeek) {
    // Admin explicitly picked a week
    newWeek = chosenWeek;
  } else {
    // Auto-advance to the next in sequence
    const currentIdx = WEEK_SEQUENCE.indexOf(season.currentWeek ?? "1");
    const nextIdx    = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1);
    newWeek = WEEK_SEQUENCE[nextIdx]!;
  }

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📅 League Week Updated")
    .addFields(
      { name: "Previous Week", value: oldLabel, inline: true },
      { name: "Current Week",  value: `**${newLabel}**`, inline: true },
    )
    .setTimestamp();

  // Wildcard week reminder: admin must seed both conferences and award division bonuses
  if (newWeek === "wildcard") {
    embed.addFields({
      name: "⚠️ Wildcard Week — Action Required",
      value: [
        "Before games begin, complete these steps:",
        "**1.** `/admin-playoffs setnfcseeds` — Register NFC seeds 1–7",
        "**2.** `/admin-playoffs setafcseeds` — Register AFC seeds 1–7",
        "**3.** `/admin-playoffs divisionbonus` — Award +25 coins to all 8 division winners",
        "",
        "Seeds 1–4 in each conference earn **+75 coins/playoff win**.",
        "Seeds 5–7 (wildcard entrants) earn **+100 coins/playoff win**.",
        "All playoff losers receive **+50 coins** upon elimination.",
      ].join("\n"),
    });
    embed.setColor(Colors.Yellow);
  }

  await interaction.editReply({ embeds: [embed] });
}
