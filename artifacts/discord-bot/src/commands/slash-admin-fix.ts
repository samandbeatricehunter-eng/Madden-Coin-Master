import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminFullSync       from "./admin-fullsync.js";
import * as adminManualScore    from "./admin-manualscore.js";
import * as adminCorrectPayout  from "./admin-correctpayout.js";
import * as adminResendArticle  from "./admin-resendarticle.js";
import * as adminResendPayouts  from "./admin-resend-payouts.js";
import * as adminRollback       from "./admin-rollback-franchise.js";

export const data = new SlashCommandBuilder()
  .setName("admin_fix")
  .setDescription("Data fixes, manual overrides, and diagnostic tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("full_data_sync")
    .setDescription("Full sync: auto-link teams, process stored games, award missed payouts & milestones")
  )
  .addSubcommand(s => s
    .setName("resend_payouts")
    .setDescription("Scan stream/highlight channels for missed payouts and issue them")
    .addStringOption(o => o.setName("type").setDescription("Which payout type to recover (default: both)").setRequired(false)
      .addChoices(
        { name: "Streams only",    value: "stream"    },
        { name: "Highlights only", value: "highlight" },
        { name: "Both",            value: "both"      },
      )
    )
  )
  .addSubcommand(s => s
    .setName("input_game_score")
    .setDescription("Manually record a game result when MCA is unavailable")
    .addUserOption(o => o.setName("homeuser").setDescription("Discord user who played the HOME team").setRequired(true))
    .addIntegerOption(o => o.setName("homescore").setDescription("Home team final score").setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName("awayscore").setDescription("Away team final score").setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName("week").setDescription("Week number (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
    .addUserOption(o => o.setName("awayuser").setDescription("Discord user who played the AWAY team (omit if CPU game)").setRequired(false))
    .addStringOption(o => o.setName("gametype").setDescription("Game type (default: regular_season)").setRequired(false)
      .addChoices(
        { name: "Regular Season", value: "regular_season" },
        { name: "Playoff",        value: "playoff"        },
        { name: "Super Bowl",     value: "superbowl"      },
      )
    )
    .addStringOption(o => o.setName("notes").setDescription("Reason for manual entry (e.g. 'MCA was down Week 8')").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("correct_game_payout")
    .setDescription("Retroactively fix a game's payout type and correct coins/records")
    .addIntegerOption(o => o.setName("week").setDescription("Week number (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
    .addUserOption(o => o.setName("homeuser").setDescription("The player who controlled the HOME team").setRequired(true))
    .addUserOption(o => o.setName("awayuser").setDescription("The player who controlled the AWAY team").setRequired(true))
    .addStringOption(o => o.setName("type").setDescription("The CORRECT payout type for this game").setRequired(true)
      .addChoices(
        { name: "h2h — true head-to-head (both users played)",    value: "h2h"  },
        { name: "cpu — force win or CPU autopilot (winner only)", value: "cpu"  },
        { name: "none — void game, no payouts",                   value: "none" },
      )
    )
    .addStringOption(o => o.setName("winner").setDescription("Who won — required when type is h2h or cpu").setRequired(false)
      .addChoices(
        { name: "Home team",  value: "home" },
        { name: "Away team",  value: "away" },
      )
    )
    .addIntegerOption(o => o.setName("pointdiff").setDescription("Point differential (winning score − losing score) — required for h2h").setRequired(false).setMinValue(1))
    .addStringOption(o => o.setName("gameid").setDescription("Override: paste the exact game ID if auto-lookup fails").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("regenerate_weekly_article")
    .setDescription("Regenerate and repost a weekly article for any week")
    .addIntegerOption(o => o.setName("week").setDescription("Which week to write about (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
    .addStringOption(o => o.setName("mode").setDescription("recap = post-game article | preview = pre-game hype").setRequired(false)
      .addChoices(
        { name: "recap  — recaps scores & stats after the week is complete", value: "recap"   },
        { name: "preview — previews matchups before the week is played",      value: "preview" },
      )
    )
    .addStringOption(o => o.setName("upcoming").setDescription("(Recap only) Label for the next week, e.g. 'Week 11' or 'Wildcard'").setRequired(false))
    .addBooleanOption(o => o.setName("ping_everyone").setDescription("Ping @everyone when posting? (default: true)").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("rollback")
    .setDescription("Reverse all data written by franchise imports within a recent time window")
    .addStringOption(o => o.setName("time_period").setDescription("How far back to roll back from right now").setRequired(true)
      .addChoices(
        { name: "2 hours",  value: "2h"  },
        { name: "4 hours",  value: "4h"  },
        { name: "8 hours",  value: "8h"  },
        { name: "12 hours", value: "12h" },
        { name: "24 hours", value: "24h" },
      )
    )
    .addBooleanOption(o => o.setName("dry_run").setDescription("Preview without making changes — default: TRUE").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand();
  if (sub === "full_data_sync")          return adminFullSync.execute(interaction);
  if (sub === "resend_payouts")          return adminResendPayouts.execute(interaction);
  if (sub === "input_game_score")        return adminManualScore.execute(interaction);
  if (sub === "correct_game_payout")     return adminCorrectPayout.execute(interaction);
  if (sub === "regenerate_weekly_article") return adminResendArticle.execute(interaction);
  if (sub === "rollback")                return adminRollback.execute(interaction);
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}
