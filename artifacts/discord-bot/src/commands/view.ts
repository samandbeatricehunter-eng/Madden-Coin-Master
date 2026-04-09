import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseMcaTeamsTable, franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import * as userStats          from "./userstats.js";
import * as viewstore          from "./viewstore.js";
import * as viewCustomArchetypes from "./viewcustomarchetypes.js";
import * as viewroster         from "./viewroster.js";
import * as viewtradeblock     from "./viewtradeblock.js";
import * as viewplayerdetails  from "./viewplayerdetails.js";
import * as statLeaders        from "./statleaders.js";
import * as viewplayerstats    from "./viewplayerstats.js";
import * as rulesCmd           from "./rules.js";
import { STAT_CATEGORY_CHOICES } from "../lib/stat-categories.js";

export const data = new SlashCommandBuilder()
  .setName("view")
  .setDescription("View stats, store, rosters, and league information")

  // ── userStats ──────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("user_stats")
    .setDescription("View stats, coins, and inventory for any league member")
    .addUserOption(o => o.setName("user").setDescription("League member to look up — leave blank for yourself").setRequired(false))
  )

  // ── playerStats ────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("player_stats")
    .setDescription("Browse player season stats by team or view top 10 stat leaders")
    .addStringOption(o => o.setName("mode").setDescription("Browse by team or view top 10 leaderboard").setRequired(true)
      .addChoices(
        { name: "🏈 By Team — pick a player from any team's roster", value: "team" },
        { name: "📊 Top 10 Stat Leaders — all categories",           value: "top10" },
      )
    )
    .addStringOption(o => o.setName("category").setDescription("(Top 10 mode only) Stat category to highlight").setRequired(false)
      .addChoices(...STAT_CATEGORY_CHOICES)
    )
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel (admin only)").setRequired(false))
  )

  // ── teamStats ──────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("team_stats")
    .setDescription("View team standings or a specific team's season performance")
    .addStringOption(o => o.setName("mode").setDescription("Teams to watch or look up a specific team").setRequired(true)
      .addChoices(
        { name: "📋 Teams to Watch — division leaders & playoff picture", value: "watch" },
        { name: "👤 User's Team — detailed season stats for one team",    value: "user"  },
      )
    )
    .addUserOption(o => o.setName("user").setDescription("(User Team mode) Look up by Discord user").setRequired(false))
    .addStringOption(o => o.setName("team").setDescription("(User Team mode) Look up by team name").setRequired(false).setAutocomplete(true))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel (admin only)").setRequired(false))
  )

  // ── store ──────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("store")
    .setDescription("View the league store (legends, prices, and upgrade costs)")
  )

  // ── customPlayerArchetypes ─────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("custom_player_archetypes")
    .setDescription("Browse available custom player archetypes by position")
  )

  // ── roster ─────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("roster")
    .setDescription("View the full roster of any team in the league")
    .addStringOption(o => o.setName("team").setDescription("Team name (start typing to search)").setRequired(false).setAutocomplete(true))
    .addUserOption(o => o.setName("user").setDescription("Look up a team by its Discord manager instead").setRequired(false))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel?").setRequired(false))
  )

  // ── tradeBlock ────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("trade_block")
    .setDescription("Browse active trade block listings and send offers")
    .addBooleanOption(o => o.setName("public").setDescription("Show to everyone in this channel?").setRequired(false))
    .addBooleanOption(o => o.setName("admin").setDescription("Admin mode: show Remove buttons on every listing").setRequired(false))
  )

  // ── playerDetails ─────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("player_details")
    .setDescription("View full attribute breakdown for any player in the league or free agent pool")
    .addStringOption(o => o.setName("team").setDescription("Select a team or Free Agents").setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName("player").setDescription("Select a player from that team (start typing a name to search)").setRequired(false).setAutocomplete(true))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel?").setRequired(false))
  )

  // ── rules ─────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("rules")
    .setDescription("Display a section of the league rules, or quote a specific rule")
    .addStringOption(o => o.setName("section").setDescription("Which rules section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Quote only this rule number from the section (optional)").setRequired(false).setMinValue(1))
    .addStringOption(o => o.setName("mention").setDescription("Broadcast to @everyone or @here (overrides the user option)").setRequired(false)
      .addChoices(
        { name: "@everyone — ping the entire server", value: "everyone" },
        { name: "@here — ping online members only",   value: "here"     },
      )
    )
    .addUserOption(o => o.setName("user").setDescription("Tag a specific member to share this rule with them (makes it visible to everyone)").setRequired(false))
  );

// ── Execute router ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand();

  if (sub === "user_stats")               return userStats.execute(interaction);
  if (sub === "store")                    return viewstore.execute(interaction);
  if (sub === "custom_player_archetypes") return viewCustomArchetypes.execute(interaction);
  if (sub === "roster")                   return viewroster.execute(interaction);
  if (sub === "trade_block")              return viewtradeblock.execute(interaction);
  if (sub === "player_details")           return viewplayerdetails.execute(interaction);
  if (sub === "rules")                    return rulesCmd.execute(interaction);

  if (sub === "player_stats") {
    const mode = interaction.options.getString("mode", true);
    if (mode === "top10") {
      return statLeaders.execute(interaction);
    }
    return viewplayerstats.execute(interaction);
  }

  if (sub === "team_stats") {
    const mode = interaction.options.getString("mode", true);
    return handleTeamStatsView(interaction, mode);
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}

// ── Team Stats handler ─────────────────────────────────────────────────────────
async function handleTeamStatsView(
  interaction: ChatInputCommandInteraction,
  mode: string
): Promise<void> {
  if (mode === "watch") {
    return statLeaders.execute(interaction);
  }

  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const teamName   = interaction.options.getString("team");

  if (!targetUser && !teamName) {
    await interaction.editReply({ content: "❌ Please provide either a **@user** or **team** name for User Team mode." });
    return;
  }

  const season = await getOrCreateActiveSeason();

  let teamRosterQuery: any;
  if (targetUser) {
    teamRosterQuery = await db
      .select()
      .from(franchiseRostersTable)
      .where(
        and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.discordId, targetUser.id),
        )
      )
      .limit(5);
  } else {
    teamRosterQuery = await db
      .select()
      .from(franchiseRostersTable)
      .where(
        and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.teamName, teamName!),
        )
      )
      .limit(5);
  }

  if (teamRosterQuery.length === 0) {
    await interaction.editReply({ content: "❌ No roster data found for that team. Make sure MCA data has been imported." });
    return;
  }

  const firstEntry = teamRosterQuery[0];
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`${firstEntry.teamName} — Team Overview`)
    .setDescription(`Use \`/view player_stats\` to browse individual player stats for this team.`)
    .addFields({ name: "Season", value: `Season ${season.seasonNumber}`, inline: true });

  await interaction.editReply({ embeds: [embed] });
}

// ── Autocomplete router ────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand();

    if (sub === "roster")        return viewroster.autocomplete(interaction);
    if (sub === "player_details") return viewplayerdetails.autocomplete(interaction);
    if (sub === "rules")          return rulesCmd.autocomplete(interaction);

    if (sub === "team_stats") {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "team") {
        const season = await getOrCreateActiveSeason();
        const teams = await db
          .select({ name: franchiseMcaTeamsTable.nickName })
          .from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
        const q = focused.value.toLowerCase();
        const choices = teams
          .filter(t => t.name.toLowerCase().includes(q))
          .slice(0, 25)
          .map(t => ({ name: t.name, value: t.name }));
        await interaction.respond(choices);
        return;
      }
    }

    await interaction.respond([]).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
