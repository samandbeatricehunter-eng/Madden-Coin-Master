import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminSeason            from "./admin-season.js";
import * as setweek                from "./setweek.js";
import * as advanceweek            from "./advanceweek.js";
import * as adminResetWeek         from "./admin-resetweek.js";
import * as endofseasonpayout      from "./endofseasonpayout.js";
import * as postFullSeasonSchedule from "./admin-postfullseasonschedule.js";

const WEEK_CHOICES = [
  { name: "Week 1",       value: "1"  },  { name: "Week 2",       value: "2"  },
  { name: "Week 3",       value: "3"  },  { name: "Week 4",       value: "4"  },
  { name: "Week 5",       value: "5"  },  { name: "Week 6",       value: "6"  },
  { name: "Week 7",       value: "7"  },  { name: "Week 8",       value: "8"  },
  { name: "Week 9",       value: "9"  },  { name: "Week 10",      value: "10" },
  { name: "Week 11",      value: "11" },  { name: "Week 12",      value: "12" },
  { name: "Week 13",      value: "13" },  { name: "Week 14",      value: "14" },
  { name: "Week 15",      value: "15" },  { name: "Week 16",      value: "16" },
  { name: "Week 17",      value: "17" },  { name: "Week 18",      value: "18" },
  { name: "Wildcard",     value: "wildcard"   },
  { name: "Divisional",   value: "divisional" },
  { name: "Conference",   value: "conference" },
  { name: "Super Bowl",   value: "superbowl"  },
  { name: "Offseason",    value: "offseason"  },
];

export const data = new SlashCommandBuilder()
  .setName("admin_season")
  .setDescription("Season & schedule management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("advance")
    .setDescription("Advance to the next season (subject to franchise season limit)")
  )
  .addSubcommand(s => s
    .setName("set")
    .setDescription("Jump directly to a specific season number (1–50)")
    .addIntegerOption(o => o.setName("number").setDescription("Season number to activate").setRequired(true).setMinValue(1).setMaxValue(50))
  )
  .addSubcommand(s => s
    .setName("status")
    .setDescription("View current season info")
  )
  .addSubcommand(s => s
    .setName("set_week")
    .setDescription("Manually set the current league week without server changes")
    .addStringOption(o => o.setName("week").setDescription("The week to set").setRequired(true).addChoices(...WEEK_CHOICES))
  )
  .addSubcommand(s => s
    .setName("advance_week")
    .setDescription("Advance or set the current league week")
    .addStringOption(o => o.setName("week").setDescription("The week to set (leave blank to auto-advance)").setRequired(false).addChoices(...WEEK_CHOICES))
  )
  .addSubcommand(s => s
    .setName("reset_week")
    .setDescription("Clear franchise game records and interviews for a week so members can re-qualify")
    .addStringOption(o => o.setName("week").setDescription("Which week to reset?").setRequired(true).addChoices(...WEEK_CHOICES))
    .addBooleanOption(o => o.setName("confirm").setDescription("Set to True to confirm deletion — cannot be undone").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("eos_payouts")
    .setDescription("Calculate EOS tier payouts and post to commissioner log (auto-runs at Week 18 → Wildcard)")
    .addUserOption(o => o.setName("user").setDescription("The Discord user (team owner) to pay out").setRequired(true))
    .addNumberOption(o => o.setName("off_pass_yds").setDescription("Passing Yards (season total)").setRequired(false))
    .addNumberOption(o => o.setName("off_rush_yds").setDescription("Rushing Yards (season total)").setRequired(false))
    .addNumberOption(o => o.setName("off_pts_per_game").setDescription("Points Per Game (PPG, e.g. 31.5)").setRequired(false))
    .addNumberOption(o => o.setName("off_redzone_pct").setDescription("Offensive Red Zone % (e.g. 72.4)").setRequired(false))
    .addNumberOption(o => o.setName("def_pass_yds").setDescription("Passing Yards Allowed (season total)").setRequired(false))
    .addNumberOption(o => o.setName("def_rush_yds").setDescription("Rushing Yards Allowed (season total)").setRequired(false))
    .addNumberOption(o => o.setName("def_pts_allowed").setDescription("Total Points Allowed").setRequired(false))
    .addNumberOption(o => o.setName("def_sacks").setDescription("Defensive Sacks (season total)").setRequired(false))
    .addNumberOption(o => o.setName("def_ints").setDescription("Defensive Interceptions (season total)").setRequired(false))
    .addNumberOption(o => o.setName("def_redzone_pct").setDescription("Defensive Red Zone % Allowed (e.g. 48.2)").setRequired(false))
    .addBooleanOption(o => o.setName("rb_ypc_bonus").setDescription("RB qualified: 7.0+ YPC with 100+ carries?").setRequired(false))
    .addBooleanOption(o => o.setName("qb_ypa_bonus").setDescription("QB qualified: 8.5+ YPA with 150+ attempts?").setRequired(false))
    .addBooleanOption(o => o.setName("db_int_bonus").setDescription("DB qualified: individual player with 8+ INTs?").setRequired(false))
    .addIntegerOption(o => o.setName("award_count").setDescription("Number of in-game award winners on this team").setRequired(false).setMinValue(0).setMaxValue(20))
    .addBooleanOption(o => o.setName("missed_playoffs").setDescription("Did this user-controlled team miss the playoffs?").setRequired(false))
    .addBooleanOption(o => o.setName("dry_run").setDescription("Preview without posting to commissioner (default: false)").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("post_full_schedule")
    .setDescription("Post the full 18-week season schedule to the schedule channel")
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand();
  if (sub === "advance" || sub === "set" || sub === "status") return adminSeason.execute(interaction);
  if (sub === "set_week")          return setweek.execute(interaction);
  if (sub === "advance_week")      return advanceweek.execute(interaction);
  if (sub === "reset_week")        return adminResetWeek.execute(interaction);
  if (sub === "eos_payouts")       return endofseasonpayout.execute(interaction);
  if (sub === "post_full_schedule") return postFullSeasonSchedule.execute(interaction);
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  return adminSeason.autocomplete(interaction);
}
