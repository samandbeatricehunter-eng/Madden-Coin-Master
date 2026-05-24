/**
 * admin-rules-handlers.ts
 * Rules Hub display + Rules Modal Handlers (add/edit/delete/paginate).
 * Also exports buildRulesPages, previously on admin-operations-handlers.ts.
 * Extracted from lib/admin-operations-handlers.ts.
 */
/**
 * /admin-operations hub — admin-facing interactions with prefix ao_
 * Session TTL: 15 minutes (keyed by `${guildId}:${userId}`)
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, TextChannel, ChannelType, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, ComponentType,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonsTable, franchiseScheduleTable, usersTable, gameChannelsTable,
  gotwHistoryTable, franchiseMcaTeamsTable, leagueTwitterTable,
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  gameLogTable, userRecordsTable, statPaddingViolationsTable,
  defaultTeamLogosTable, waitlistTable,
  serverSettingsTable, franchiseRostersTable, inventoryTable, legendsTable, customPlayersTable,
  guildChannelsTable,
} from "@workspace/db";
import { eq, and, sql, ne, desc } from "drizzle-orm";
import {
  getOrCreateActiveSeason, addBalance, logTransaction,
  getGuildChannel, CHANNEL_KEYS,
  getOrSeedRules, setRules, getAllSections,
  getScheduleSeasonId,
} from "./db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "./week-helpers.js";
import { lookupNflDivision } from "./constants.js";
import { generateFranchiseArticle, generateWeekPreview } from "./franchise-article.js";
import { runWildcardAutomation, runOffseasonHistoricalPost } from "./wildcard-automation.js";
import { runEosAutoPost } from "./eos-auto-post.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";
import { sendArticleChunked } from "./send-article.js";
import { runWeeklyMatchupsFlow } from "./weekly-matchups-runner.js";
import { createPrivateGameChannelsForWeek } from "./game-channel-manager.js";
import { PLAYOFF_WEEK_META, runPlayoffMatchupsFlow, payoutPlayoffRoundResults, autoDivisionBonus } from "./playoff-matchups-runner.js";
import axios from "axios";
import { autoPayoutPlayoffGotw, purgeChannel } from "./gotw-helpers.js";
import { checkAndNotifyWaitlist } from "../commands/waitlist.js";
import { buildMatchupBanner, resolveLogoBuf } from "./matchup-image.js";
import { generateMatchupBreakdown } from "./matchup-ai-breakdown.js";
import { globalLogoPath } from "./gcs-reader.js";
import { buildAdminOpsEmbed, buildAdminOpsRows, buildAdminImportAdvanceEmbed, buildAdminImportAdvanceRows, buildAdminEconomyEmbed, buildAdminEconomyRows, buildAdminServerEmbed, buildAdminServerRows } from "../commands/admin-operations.js";
import { buildPayoutHubEmbed, buildPayoutHubRows } from "./admin-payout-handlers.js";
import { buildUserDataHubEmbed, buildUserDataHubRows } from "./admin-user-handlers.js";
import {
  buildTroubleshootEmbed, buildTroubleshootRows,
  handleTsMilestoneAudit,
} from "./admin-troubleshoot-handlers.js";
import { runNewServerInit, runExistingServerInit } from "../commands/admin-initialize.js";
import { registerCommandsForGuild } from "./register-commands.js";
import { buildLeagueDataMainMenu } from "./league-data-handlers.js";
import { getServerSettings, buildSettingsEmbed, buildSettingsRows } from "./server-settings.js";
import { setGuildChannel } from "./db-helpers.js";
import { rebuildHistoricalChannel } from "./wildcard-automation.js";
import OpenAI from "./openai-fallback.js";



function buildAdminBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ao_admin_root")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildAdminRootMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ao_admin_department_select")
        .setPlaceholder("Select admin department")
        .addOptions(
          { label: "Import/Advance", value: "import_advance", description: "Import, advance, set week/season, weekly matchups", emoji: "📥" },
          { label: "Manage Economy", value: "manage_economy", description: "Payouts and economy workflows", emoji: "💰" },
          { label: "Manage Server", value: "manage_server", description: "Users, settings, troubleshooting, bug reports", emoji: "🛠️" },
        ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_close").setLabel("Close").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildImportAdvanceMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ao_import_advance_select")
        .setPlaceholder("Select Import/Advance workflow")
        .addOptions(
          { label: "Import", value: "league_data", description: "Formerly League Data", emoji: "📥" },
          { label: "Advance Week", value: "advance_week", description: "Advance to the next league week", emoji: "⏭️" },
          { label: "Run Weekly Matchups", value: "run_weekly_matchups", description: "Post game channels, matchups, and GOTW flow", emoji: "🏈" },
          { label: "Set Week", value: "set_week", description: "Manually set current week", emoji: "📅" },
          { label: "Set Season", value: "set_season", description: "Manually set current season", emoji: "🏆" },
        ),
    ),
    buildAdminBackRow(),
  ];
}

function buildManageEconomyMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ao_manage_economy_select")
        .setPlaceholder("Select Economy workflow")
        .addOptions(
          { label: "Payouts", value: "payouts", description: "Open payout management", emoji: "💰" },
        ),
    ),
    buildAdminBackRow(),
  ];
}

function buildManageServerMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ao_manage_server_select")
        .setPlaceholder("Select Server workflow")
        .addOptions(
          { label: "User Data", value: "user_data", description: "Manage user/team data", emoji: "👥" },
          { label: "Store Settings", value: "store_settings", description: "Manage store options", emoji: "🏪" },
          { label: "Server Settings", value: "server_settings", description: "Manage server settings", emoji: "⚙️" },
          { label: "Troubleshoot", value: "troubleshoot", description: "Repair/check bot data", emoji: "🧰" },
          { label: "Report Bug", value: "report_bug", description: "Report a bot issue", emoji: "🐞" },
        ),
    ),
    buildAdminBackRow(),
  ];
}

async function showAdminRootMenu(interaction: any) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0xB68B2D).setTitle("Commissioner's Office").setDescription("Select an admin department below.")],
    components: buildAdminRootMenuRows(),
  });
}

async function showAdminDepartmentMenu(interaction: any, title: string, description: string, components: any[]) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0xB68B2D).setTitle(title).setDescription(description)],
    components,
  });
}
    return;
  }

  if (selected === "manage_economy") {
    await interaction.update({
      embeds: [buildAdminEconomyEmbed(season?.seasonNumber ?? undefined, wkStr)],
      components: buildAdminEconomyRows(),
    });
    return;
  }

  if (selected === "manage_server") {
    await interaction.update({
      embeds: [buildAdminServerEmbed(season?.seasonNumber ?? undefined, wkStr)],
      components: buildAdminServerRows(),
    });
    return;
  }

  await interaction.reply({ content: "Unknown admin department.", ephemeral: true });
}

async function handleAdminImportAdvanceSelect(interaction: StringSelectMenuInteraction) {
  const selected = interaction.values[0];

  if (selected === "import") return handleLeagueDataHub(interaction as any);
  if (selected === "advance_week") return handleAdvanceWeek(interaction as any);
  if (selected === "set_week") return handleSetWeek(interaction as any);
  if (selected === "set_season") return handleSetSeasonNum(interaction as any);
  if (selected === "run_weekly_matchups") return handleRunWeeklyMatchups(interaction);

  await interaction.reply({ content: "Unknown Import/Advance action.", ephemeral: true });
}

async function handleAdminEconomySelect(interaction: StringSelectMenuInteraction) {
  const selected = interaction.values[0];
  if (selected === "payouts") return handlePayoutsHub(interaction as any);
  await interaction.reply({ content: "Unknown economy action.", ephemeral: true });
}

async function handleAdminServerSelect(interaction: StringSelectMenuInteraction) {
  const selected = interaction.values[0];
  if (selected === "user_data") return handleUserDataHub(interaction as any);
  if (selected === "store_settings") return handleStoreSettingsHub(interaction as any);
  if (selected === "server_settings") return handleServerSettingsHub(interaction as any);
  if (selected === "troubleshoot") return handleTroubleshootHub(interaction as any);
  if (selected === "report_bug") return handleReportBug(interaction as any);
  await interaction.reply({ content: "Unknown server action.", ephemeral: true });
}

async function handleRunWeeklyMatchups(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const currWeek = parseInt(season.currentWeek ?? "1", 10);
  const defaultW = isNaN(currWeek) ? "1" : String(currWeek);

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_run_weekly_matchups")
    .setTitle("Run Weekly Matchups");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("week_num")
        .setLabel("Week # to run")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setPlaceholder(defaultW)
        .setValue(defaultW),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRunWeeklyMatchupsModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ Could not access guild." });
    return;
  }

  const raw = interaction.fields.getTextInputValue("week_num").trim();
  const weekNum = parseInt(raw, 10);
  if (isNaN(weekNum) || weekNum < 1 || weekNum > 22) {
    await interaction.editReply({ content: "❌ Invalid week number. Use 1-22." });
    return;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const scheduleSeasonId = await getScheduleSeasonId(guildId);
  const displayLabel = weekLabel(String(weekNum));

  await interaction.editReply({ content: "Running weekly matchup workflow: creating game channels first, then posting matchups/GOTW..." });

  let channelSummary = "";
  try {
    const result = await createPrivateGameChannelsForWeek({
      guild,
      guildId,
      seasonId: Number(season.id),
      seasonNumber: Number(season.seasonNumber ?? 1),
      scheduleSeasonId,
      weekIndex: weekNum,
      displayLabel,
    });
    channelSummary = "Game channels: " + result.created + " created / " + result.h2hGames + " H2H games.";
  } catch (err) {
    console.error("[admin-operations] Run Weekly Matchups channel creation error:", err);
    channelSummary = "Game channel step failed: " + String(err);
  }

  try {
    await runWeeklyMatchupsFlow({
      client: interaction.client,
      guild,
      season,
      displayWeekNum: weekNum,
      payoutWeekIndex: null,
      guildId,
      replyFn: async ({ content, components }) => {
        await interaction.followUp({ content, components: components ?? [], ephemeral: true }).catch(() => {});
      },
    });

    await interaction.editReply({
      content: "✅ Run Weekly Matchups completed.\n" + channelSummary,
    });
  } catch (err) {
    console.error("[admin-operations] Run Weekly Matchups post error:", err);
    await interaction.editReply({
      content: "⚠️ Game channel step finished, but matchup/GOTW posting failed.\n" + channelSummary + "\nError: " + String(err),
    });
  }
}

// ── Payouts Hub ────────────────────────────────────────────────────────────────

async function handlePayoutsHub(interaction: ButtonInteraction) {
  await interaction.update({
    embeds: [buildPayoutHubEmbed()],
    components: buildPayoutHubRows() as ActionRowBuilder<any>[],
  });
}

// ── Post Matchups/GOTW ─────────────────────────────────────────────────────────

async function handlePostMatchups(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const week    = weekLabel(season.currentWeek ?? "1");

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("📋 Post Matchups/GOTW")
        .setDescription(
          `This will re-run the full weekly matchups flow for **${week}**.\n\n` +
          "• Posts matchup embeds to the matchups channel\n" +
          "• Posts a GOTW poll to the GOTW channel\n" +
          "• Creates game channels if not already created\n\n" +
          "⚠️ This does **not** award payouts or advance the week."
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_post_matchups_confirm").setLabel("✅ Confirm & Post").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handlePostMatchupsConfirm(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("📋 Posting Matchups...")
        .setDescription("Running the matchups flow — please wait."),
    ],
    components: [],
  });

  try {
    const season      = await getOrCreateActiveSeason(guildId);
    const currentWeek = season.currentWeek ?? "1";
    const backRow     = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ];

    if (PLAYOFF_WEEK_META[currentWeek]) {
      // ── Playoff week — use the playoff matchups / GOTW flow ──────────────────
      const summary = await runPlayoffMatchupsFlow(
        interaction.client,
        season,
        currentWeek as keyof typeof PLAYOFF_WEEK_META,
        guildId,
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("✅ Playoff Matchups Posted")
            .setDescription(summary || `Playoff matchup flow completed for **${weekLabel(currentWeek)}**.`),
        ],
        components: backRow,
      });
    } else {
      // ── Regular season week ───────────────────────────────────────────────────
      const weekNum        = parseInt(currentWeek, 10);
      const displayWeekNum = isNaN(weekNum) ? 1 : weekNum;

      await runWeeklyMatchupsFlow({
        client:          interaction.client,
        guild:           interaction.guild,
        season,
        displayWeekNum,
        payoutWeekIndex: null,
        guildId,
        replyFn: async ({ content, components }) => {
          await interaction.followUp({ content, components: components ?? [], ephemeral: true }).catch(() => {});
        },
      });

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("✅ Matchups Posted")
            .setDescription(`Matchup flow completed for **${weekLabel(currentWeek)}**.`),
        ],
        components: backRow,
      });
    }
  } catch (err) {
    console.error("[admin-operations] Post Matchups error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Matchups Post Failed")
          .setDescription(`Error: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ── Post Game Channels ─────────────────────────────────────────────────────────

async function handlePostGameChannels(interaction: ButtonInteraction) {
  const guildId  = interaction.guildId!;
  const season   = await getOrCreateActiveSeason(guildId);
  const currWeek = parseInt(season.currentWeek ?? "1", 10);
  const defaultW = isNaN(currWeek) ? "1" : String(currWeek);

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_post_game_channels")
    .setTitle("Post Game Channels");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("week_num")
        .setLabel("Week # (1-18, 19=Wild Card, 20-22=playoffs)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setPlaceholder(defaultW)
        .setValue(defaultW),
    ),
  );
  await interaction.showModal(modal);
}

async function handlePostGameChannelsModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const guild = interaction.guild;

  if (!guild) {
    await interaction.editReply({ content: "❌ Could not access guild." });
    return;
  }

  const raw = interaction.fields.getTextInputValue("week_num").trim();
  const weekNum = parseInt(raw, 10);

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 22) {
    await interaction.editReply({
      content: "❌ Invalid week number. Enter 1–18 for regular season, 19–22 for playoffs.",
    });
    return;
  }

  const playoffIndexMap: Record<number, number> = {
    19: 1018,
    20: 1019,
    21: 1020,
    22: 1022,
  };

  const weekIndex = weekNum <= 18 ? weekNum - 1 : (playoffIndexMap[weekNum] ?? -1);

  if (weekIndex === -1) {
    await interaction.editReply({ content: "❌ Could not resolve week index." });
    return;
  }

  const isPlayoff = weekNum > 18;
  const playoffLabels: Record<number, string> = {
    19: "Wild Card",
    20: "Divisional Round",
    21: "Conference Championship",
    22: "Super Bowl",
  };

  const displayLabel = isPlayoff
    ? `Season ${season.seasonNumber} — ${playoffLabels[weekNum] ?? `Playoff Wk ${weekNum}`}`
    : `Season ${season.seasonNumber} — Week ${weekNum}`;

  const schedSeasonId = await getScheduleSeasonId(guildId);

  try {
    const summary = await createPrivateGameChannelsForWeek({
      guild,
      guildId,
      seasonId: season.id,
      seasonNumber: season.seasonNumber,
      scheduleSeasonId: schedSeasonId,
      weekIndex,
      displayLabel,
    });

    if (summary.totalGames === 0) {
      await interaction.editReply({
        content: `❌ No schedule data found for **${displayLabel}**. Import the schedule first using Admin Tools under /menu.`,
      });
      return;
    }

    if (summary.h2hGames === 0) {
      await interaction.editReply({
        content: `ℹ️ No H2H matchups found for **${displayLabel}** — all ${summary.totalGames} game${summary.totalGames !== 1 ? "s" : ""} are CPU matchups. No channels created.`,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(summary.created > 0 ? Colors.Green : Colors.Blurple)
      .setTitle(`Post Game Channels — ${displayLabel}`)
      .setDescription(summary.results.length > 0 ? summary.results.join("\n") : "No H2H games processed.")
      .addFields(
        { name: "Private Channels Created", value: String(summary.created), inline: true },
        { name: "H2H Games", value: String(summary.h2hGames), inline: true },
        { name: "Total Schedule", value: String(summary.totalGames), inline: true },
      )
      .setFooter({ text: "Channels are private to matchup users and the Commissioner role." })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("[admin-operations] Post Game Channels error:", err);
    await interaction.editReply({ content: `❌ Failed to post game channels: ${err}` });
  }
}

// ──  ────────────────────────────────────────────────────────

async function handlePostCustomArticle(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_custom_article")
    .setTitle("Post Custom AI Article");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("article_prompt")
        .setLabel("Article Topic / Prompt")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("e.g. Write a feature piece on the MVP race heading into playoffs...")
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalCustomArticle(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId!;
  const prompt  = interaction.fields.getTextInputValue("article_prompt").trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    const headlinesChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.HEADLINES);
    if (!headlinesChannelId) {
      await interaction.editReply({ content: "❌ No headlines channel configured. Set it via `/adminserver link_channel`." });
      return;
    }

    const channel = (interaction.client.channels.cache.get(headlinesChannelId)
      ?? await interaction.client.channels.fetch(headlinesChannelId).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      await interaction.editReply({ content: "❌ Headlines channel not found or inaccessible." });
      return;
    }

    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "You are an award-winning sports journalist covering The R.E.C. League — a competitive Madden NFL franchise simulation league.",
            "Write in a bold, energetic, ESPN-style voice.",
            "Use vivid prose paragraphs. Do NOT use markdown headers (##, ###) or bullet points — just flowing, punchy paragraphs.",
            "Keep the article between 400–600 words unless the prompt implies a shorter piece.",
            "IMPORTANT: Always start your response with a single line in exactly this format:",
            "HEADLINE: <your headline here>",
            "Then leave one blank line, then write the article body.",
          ].join("\n"),
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.85,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const lines = raw.split("\n");
    const headlineLine = lines.find(l => l.startsWith("HEADLINE:"));
    const headline = headlineLine ? headlineLine.replace("HEADLINE:", "").trim() : "Breaking News";
    const bodyStart = headlineLine ? lines.indexOf(headlineLine) + 2 : 0;
    const article   = lines.slice(bodyStart).join("\n").trim();

    const header = `📰 **${headline}**\n\n`;
    // article posting removed — sendArticleChunked archived

    await interaction.editReply({ content: `✅ Custom article posted to <#${headlinesChannelId}>.` });
  } catch (err) {
    console.error("[admin-operations] Custom article error:", err);
    await interaction.editReply({ content: `❌ Failed to generate or post article: ${err}` });
  }
}

// ──  ──────────────────────────────────────────────────────────

async function handleRerunMedia(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("🐦 Rerunning Media Cycle...")
        .setDescription("Triggering league Twitter burst for the current week..."),
    ],
    components: [],
  });

  try {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Media Cycle Triggered")
          .setDescription("League Twitter burst has been triggered for this week. Posts will appear shortly."),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
        ) as ActionRowBuilder<any>,
      ],
    });
  } catch (err) {
    console.error("[admin-operations] Rerun media error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Media Cycle Failed")
          .setDescription(`Error: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ──  ────────────────────────────────────────────────────

async function handleRerunHist(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("📜 Rebuilding Historical Records Channel...")
        .setDescription("This may take a moment — please wait."),
    ],
    components: [],
  });

  try {
    const season = await getOrCreateActiveSeason(guildId);
    const guild  = interaction.guild;
    if (!guild) throw new Error("Guild not available.");

    await rebuildHistoricalChannel(interaction.client, season.id, season.seasonNumber ?? season.id, guild);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Historical Channel Rebuilt")
          .setDescription(`Season ${season.seasonNumber ?? season.id} historical records channel has been rebuilt.`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
        ) as ActionRowBuilder<any>,
      ],
    });
  } catch (err) {
    console.error("[admin-operations] Rerun historical error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Historical Rebuild Failed")
          .setDescription(`Error: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ── Waitlist Hub ───────────────────────────────────────────────────────────────

async function handleWaitlistHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const entries = await db.select()
    .from(waitlistTable)
    .where(and(
      eq(waitlistTable.guildId, guildId),
      eq(waitlistTable.status, "waiting"),
    ))
    .orderBy(waitlistTable.addedAt);

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  if (entries.length === 0) {
    await (interaction as any).update({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("📋 Waitlist")
          .setDescription("✅ No users are currently on the waitlist."),
      ],
      components: [backRow],
    });
    return;
  }

  const lines = entries.map((e, i) =>
    `**${i + 1}.** <@${e.discordId}>${e.team ? ` — waiting for: **${e.team}**` : " — any open team"} ` +
    `(added <t:${Math.floor(e.addedAt.getTime() / 1000)}:R>)`
  );

  const btnRows: ActionRowBuilder<ButtonBuilder>[] = [];
  const PAGE_SIZE = 3;
  for (let i = 0; i < Math.min(entries.length, PAGE_SIZE * 5); i += PAGE_SIZE) {
    const slice = entries.slice(i, i + PAGE_SIZE);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...slice.map((e, j) => {
        const idx = i + j;
        return new ButtonBuilder()
          .setCustomId(`ao_waitlist_edit:${e.id}`)
          .setLabel(`✏️ #${idx + 1} Edit`)
          .setStyle(ButtonStyle.Primary);
      }),
      ...slice.map((e, j) => {
        const idx = i + j;
        return new ButtonBuilder()
          .setCustomId(`ao_waitlist_delete:${e.id}`)
          .setLabel(`🗑️ #${idx + 1} Delete`)
          .setStyle(ButtonStyle.Danger);
      }),
    );
    btnRows.push(row);
  }
  btnRows.push(backRow);

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 Waitlist")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `${entries.length} user${entries.length !== 1 ? "s" : ""} waiting` }),
    ],
    components: btnRows as ActionRowBuilder<any>[],
  });
}

async function handleWaitlistEdit(interaction: ButtonInteraction, _sess: AoSession) {
  const entryId = parseInt(interaction.customId.split(":")[1]!, 10);
  const guildId = interaction.guildId!;

  const [entry] = await db.select().from(waitlistTable)
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .limit(1);

  if (!entry) {
    await interaction.reply({ content: "❌ Waitlist entry not found.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_waitlist_edit")
    .setTitle("Edit Waitlist Entry");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("entry_id")
        .setLabel("Entry ID (do not change)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(entry.id))
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("team")
        .setLabel("Team they're waiting for (blank = any)")
        .setStyle(TextInputStyle.Short)
        .setValue(entry.team ?? "")
        .setRequired(false)
        .setMaxLength(50),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalWaitlistEdit(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId!;
  const entryId = parseInt(interaction.fields.getTextInputValue("entry_id"), 10);
  const team    = interaction.fields.getTextInputValue("team").trim() || null;

  if (isNaN(entryId)) {
    await interaction.reply({ content: "❌ Invalid entry ID.", ephemeral: true });
    return;
  }

  const [updated] = await db.update(waitlistTable)
    .set({ team })
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .returning();

  if (!updated) {
    await interaction.reply({ content: "❌ Entry not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ Updated waitlist entry for <@${updated.discordId}>${team ? ` — now waiting for **${team}**` : " — now waiting for any open team"}.`,
    ephemeral: true,
  });
}

async function handleWaitlistDelete(interaction: ButtonInteraction) {
  const entryId = parseInt(interaction.customId.split(":")[1]!, 10);
  const guildId = interaction.guildId!;

  const [deleted] = await db.delete(waitlistTable)
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .returning();

  if (!deleted) {
    await interaction.reply({ content: "❌ Entry not found or already deleted.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `🗑️ Removed <@${deleted.discordId}> from the waitlist.`,
    ephemeral: true,
  });
}

// ── Admins Hub ─────────────────────────────────────────────────────────────────

const ADMIN_CAP = 4;

async function handleAdminsHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const admins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  const lines = admins.length > 0
    ? admins.map((a, i) =>
        `**${i + 1}.** <@${a.discordId}> (${a.discordUsername})${a.team ? ` — ${a.team}` : ""}`
      )
    : ["_No bot admins set._"];

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_admins_add").setLabel("➕ Add Admin").setStyle(ButtonStyle.Success)
      .setDisabled(admins.length >= ADMIN_CAP),
    new ButtonBuilder().setCustomId("ao_admins_delete").setLabel("🗑️ Remove Admin").setStyle(ButtonStyle.Danger)
      .setDisabled(admins.length === 0),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🛡️ View/Edit Admins")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${admins.length}/${ADMIN_CAP} admin slots used` }),
    ],
    components: [backRow as ActionRowBuilder<any>],
  });
}

async function handleAdminsAdd(interaction: ButtonInteraction, _sess: AoSession) {
  const guildId = interaction.guildId!;

  const currentAdmins = await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  if (currentAdmins.length >= ADMIN_CAP) {
    await interaction.reply({ content: `❌ Admin cap (${ADMIN_CAP}) reached. Remove an admin first.`, ephemeral: true });
    return;
  }

  const adminIds = new Set(currentAdmins.map(a => a.discordId));
  const nonAdmins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, false)))
    .orderBy(usersTable.discordUsername)
    .limit(25);

  const eligible = nonAdmins.filter(u => !adminIds.has(u.discordId));

  if (eligible.length === 0) {
    await interaction.reply({ content: "❌ No eligible users found to promote.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_admins_add_sel")
    .setPlaceholder("Select a user to grant admin...")
    .addOptions(
      eligible.map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.discordUsername}${u.team ? ` (${u.team})` : ""}`)
          .setValue(u.discordId)
          .setDescription(u.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("➕ Add Admin")
        .setDescription(`Select a user to grant bot-admin status. (${ADMIN_CAP - currentAdmins.length} slot${ADMIN_CAP - currentAdmins.length !== 1 ? "s" : ""} remaining)`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_admins").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleAdminsAddSel(interaction: StringSelectMenuInteraction) {
  const guildId      = interaction.guildId!;
  const targetId     = interaction.values[0]!;

  const currentCount = (await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)))).length;

  if (currentCount >= ADMIN_CAP) {
    await interaction.reply({ content: `❌ Admin cap (${ADMIN_CAP}) reached.`, ephemeral: true });
    return;
  }

  const [result] = await db.update(usersTable)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .returning({ discordUsername: usersTable.discordUsername });

  if (!result) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ <@${targetId}> (${result.discordUsername}) has been granted bot-admin status.`,
    ephemeral: true,
  });
}

async function handleAdminsDelete(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const admins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  if (admins.length === 0) {
    await interaction.reply({ content: "❌ No admins to remove.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_admins_delete_sel")
    .setPlaceholder("Select admin to remove...")
    .addOptions(
      admins.map(a =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${a.discordUsername}${a.team ? ` (${a.team})` : ""}`)
          .setValue(a.discordId)
          .setDescription(a.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Remove Admin")
        .setDescription("Select the admin to remove. This will revoke their bot-admin access immediately."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_admins").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleAdminsDeleteSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const targetId = interaction.values[0]!;

  const [result] = await db.update(usersTable)
    .set({ isAdmin: false, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .returning({ discordUsername: usersTable.discordUsername });

  if (!result) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ Bot-admin status revoked for <@${targetId}> (${result.discordUsername}).`,
    ephemeral: true,
  });
}

// ── Commissioner Management Hub ────────────────────────────────────────────────

const COMMISSIONER_CAP = 5;

async function handleCommissionerHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const nonOwnerCommissioners = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId)))
    .orderBy(usersTable.discordUsername);

  const [ownerEntry] = await db
    .select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, ownerId), eq(usersTable.guildId, guildId)))
    .limit(1);

  const total = 1 + nonOwnerCommissioners.length;
  const lines: string[] = [];
  const ownerTeam = ownerEntry?.team ? ` — **${ownerEntry.team}**` : "";
  lines.push(`**1.** <@${ownerId}> 👑${ownerTeam}`);
  nonOwnerCommissioners.forEach((c, i) => {
    const teamInfo = c.team ? ` — **${c.team}**` : "";
    lines.push(`**${i + 2}.** <@${c.discordId}>${teamInfo}`);
  });

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle("👑 Commissioner Management")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${total}/${COMMISSIONER_CAP} slots used · 👑 = Server Owner (permanent primary)` }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_commish_add").setLabel("➕ Add").setStyle(ButtonStyle.Success)
          .setDisabled(total >= COMMISSIONER_CAP),
        new ButtonBuilder().setCustomId("ao_commish_remove").setLabel("🗑️ Remove").setStyle(ButtonStyle.Danger)
          .setDisabled(nonOwnerCommissioners.length === 0),
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleCommissionerAdd(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const nonOwnerCount = (await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId))))
    .length;

  if (1 + nonOwnerCount >= COMMISSIONER_CAP) {
    await interaction.reply({ content: `❌ Commissioner cap (${COMMISSIONER_CAP}) reached. Remove one first.`, ephemeral: true });
    return;
  }

  const adminIds = new Set(
    (await db.select({ discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId))))
      .map(u => u.discordId),
  );
  adminIds.add(ownerId);

  const allLinked = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, false)))
    .orderBy(usersTable.discordUsername);

  const eligible = allLinked.filter(u => u.team && !adminIds.has(u.discordId));

  if (eligible.length === 0) {
    await interaction.reply({ content: "❌ No eligible linked users to promote.", ephemeral: true });
    return;
  }

  const afcUsers: typeof eligible = [];
  const nfcUsers: typeof eligible = [];
  const otherUsers: typeof eligible = [];

  for (const u of eligible) {
    const conf = lookupNflDivision(u.team!)?.conference;
    if (conf === "AFC")       afcUsers.push(u);
    else if (conf === "NFC")  nfcUsers.push(u);
    else                      otherUsers.push(u);
  }

  const makeMenu = (customId: string, placeholder: string, users: typeof eligible) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          users.slice(0, 25).map(u =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${u.discordUsername}${u.team ? ` (${u.team})` : ""}`)
              .setValue(u.discordId)
              .setDescription(u.team ?? "No team"),
          ),
        ),
    ) as ActionRowBuilder<any>;

  const remaining = COMMISSIONER_CAP - 1 - nonOwnerCount;
  const components: ActionRowBuilder<any>[] = [];
  if (afcUsers.length)   components.push(makeMenu("ao_commish_add_afc",   "AFC — select a user…",   afcUsers));
  if (nfcUsers.length)   components.push(makeMenu("ao_commish_add_nfc",   "NFC — select a user…",   nfcUsers));
  if (otherUsers.length) components.push(makeMenu("ao_commish_add_other", "Other — select a user…", otherUsers));
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_commissioner").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    ) as ActionRowBuilder<any>,
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("➕ Add Commissioner")
        .setDescription(
          `Select a linked user to promote to Commissioner. **${remaining} slot${remaining !== 1 ? "s" : ""} remaining.**\n\n` +
          "Pick from the AFC, NFC, or Other dropdown below. Only one selection at a time.",
        ),
    ],
    components,
  });
}

async function handleCommissionerAddSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const guild    = interaction.guild!;
  const ownerId  = guild.ownerId;
  const targetId = interaction.values[0]!;

  const nonOwnerCount = (await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId))))
    .length;

  if (1 + nonOwnerCount >= COMMISSIONER_CAP) {
    await interaction.reply({ content: `❌ Commissioner cap (${COMMISSIONER_CAP}) reached.`, ephemeral: true });
    return;
  }

  const [user] = await db
    .select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!user) {
    await interaction.reply({ content: "❌ User not found in the database.", ephemeral: true });
    return;
  }

  await db.update(usersTable)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)));

  const member = await guild.members.fetch(targetId).catch(() => null);
  const notices: string[] = [];

  if (member) {
    await guild.roles.fetch().catch(() => null);
    const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
    if (commRole) {
      await member.roles.add(commRole, "Promoted to Commissioner via admin hub").catch(err => {
        console.error("[commissioner-add] Failed to add Commissioner role:", err);
        notices.push("⚠️ Could not assign Commissioner role — check bot permissions.");
      });
    } else {
      notices.push("⚠️ 'Commissioner' role not found — run `/admin-initialize` to create it.");
    }

    const baseNick = user.team ?? member.user.username;
    const newNick  = `${baseNick} (Commissioner)`.slice(0, 32);
    await member.setNickname(newNick, "Promoted to Commissioner").catch(err => {
      console.error("[commissioner-add] Failed to set nickname:", err);
      notices.push("⚠️ Could not update nickname — check bot rank vs member rank.");
    });
  } else {
    notices.push("⚠️ Could not fetch guild member — role and nickname not applied.");
  }

  const extra = notices.length > 0 ? `\n\n${notices.join("\n")}` : "";
  await interaction.reply({
    content: `✅ <@${targetId}> has been promoted to Commissioner.${extra}`,
    ephemeral: true,
  });
}

async function handleCommissionerRemove(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const commissioners = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId)))
    .orderBy(usersTable.discordUsername);

  if (commissioners.length === 0) {
    await interaction.reply({ content: "❌ No removable commissioners. The server owner (👑) is always the primary commissioner and cannot be removed here.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_commish_remove_sel")
    .setPlaceholder("Select a commissioner to remove…")
    .addOptions(
      commissioners.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${c.discordUsername}${c.team ? ` (${c.team})` : ""}`)
          .setValue(c.discordId)
          .setDescription(c.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Remove Commissioner")
        .setDescription(
          "Select a commissioner to demote. They will receive the **Approved Member** role and lose commissioner access.\n\n" +
          "The server owner 👑 is always the primary commissioner and cannot be removed.",
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_commissioner").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleCommissionerRemoveSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const guild    = interaction.guild!;
  const ownerId  = guild.ownerId;
  const targetId = interaction.values[0]!;

  if (targetId === ownerId) {
    await interaction.reply({ content: "❌ The server owner cannot be removed as commissioner.", ephemeral: true });
    return;
  }

  const [user] = await db
    .select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!user) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await db.update(usersTable)
    .set({ isAdmin: false, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)));

  const member = await guild.members.fetch(targetId).catch(() => null);
  const notices: string[] = [];

  if (member) {
    await guild.roles.fetch().catch(() => null);

    const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
    if (commRole && member.roles.cache.has(commRole.id)) {
      await member.roles.remove(commRole, "Demoted from Commissioner via admin hub").catch(err => {
        console.error("[commissioner-remove] Failed to remove Commissioner role:", err);
        notices.push("⚠️ Could not remove Commissioner role — check bot permissions.");
      });
    }

    const approvedRole = guild.roles.cache.find(r => r.name === "Approved Member");
    if (approvedRole && !member.roles.cache.has(approvedRole.id)) {
      await member.roles.add(approvedRole, "Demoted from Commissioner").catch(err => {
        console.error("[commissioner-remove] Failed to add Approved Member role:", err);
        notices.push("⚠️ Could not assign Approved Member role — check bot permissions.");
      });
    }

    const stripped = member.displayName.replace(/\s*\(Commissioner\)\s*$/i, "").trim();
    if (stripped !== member.displayName) {
      await member.setNickname(stripped, "Commissioner removed").catch(err => {
        console.error("[commissioner-remove] Failed to strip nickname:", err);
        notices.push("⚠️ Could not update nickname — check bot rank vs member rank.");
      });
    }
  } else {
    notices.push("⚠️ Could not fetch guild member — role and nickname not updated.");
  }

  const extra = notices.length > 0 ? `\n\n${notices.join("\n")}` : "";
  await interaction.reply({
    content: `✅ <@${targetId}> has been removed as Commissioner and reassigned to Approved Member.${extra}`,
    ephemeral: true,
  });
}

// ── League Data Hub ────────────────────────────────────────────────────────────

async function handleLeagueDataHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const menu    = await buildLeagueDataMainMenu(guildId);
  await (interaction as any).update(menu);
}

// ── User Data Hub ──────────────────────────────────────────────────────────────

async function handleUserDataHub(interaction: ButtonInteraction) {
  await (interaction as any).update({
    embeds: [buildUserDataHubEmbed()],
    components: buildUserDataHubRows() as ActionRowBuilder<any>[],
  });
}

// ── Store Settings Hub ─────────────────────────────────────────────────────────

async function handleStoreSettingsHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Store & Purchase Settings")
    .setDescription(
      "Use the buttons below to manage your league's store settings.\n\n" +
      "📋 **Archetypes** — Browse and edit custom player archetype attributes\n" +
      "⭐ **Legend Templates** — Set base attribute templates for each legend model\n" +
      "🎨 **Core Attributes** — Toggle which attributes are core (⭐) vs non-core"
    )
    .setFooter({ text: "Changes take effect immediately" });

  await (interaction as any).update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ss_arch").setLabel("📋 Archetypes").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ss_lt").setLabel("⭐ Legend Templates").setStyle(ButtonStyle.Primary),
      ) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── Server Settings Hub ────────────────────────────────────────────────────────

async function handleServerSettingsHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("⚙️ Server Settings")
    .setDescription(
      "**🎛️ Server Features**\n" +
      "Toggle coin economy, legends, custom players, wagers, MCA import, and other feature flags on or off.\n\n" +
      "**🔧 Server Setup**\n" +
      "Initialize the server, manage rules, waitlist, admins, commissioner, channel links, and franchise length.",
    )
    .setFooter({ text: "Select an option below" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_server_features").setLabel("🎛️ Server Features").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_server_setup").setLabel("🔧 Server Setup").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({ embeds: [embed], components: [row] });
}

async function handleServerFeaturesHub(interaction: ButtonInteraction) {
  const guildId  = interaction.guildId!;
  const settings = await getServerSettings(guildId);

  await (interaction as any).update({
    embeds: [buildSettingsEmbed(settings)],
    components: buildSettingsRows(settings),
  });
}

async function handleServerSetupHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔧 Server Setup")
    .setDescription(
      "**⚡ Init Existing Server** — Seeds DB settings, season, and team slots for a server that already has Discord channels.\n\n" +
      "**🏗️ Init NEW Server** — Full initialization: creates all channels, roles, categories, seeds DB, and posts setup guide. " +
      "⚠️ **Deletes ALL existing channels.**\n\n" +
      "**🔗 Manual Channel Link** — Map an existing Discord channel to a known bot channel key (commish log, matchups, etc.).\n\n" +
      "**📏 Set Franchise Length** — Change the number of seasons for this franchise.\n\n" +
      "**📜 Rules / 📋 Waitlist / 👥 Admins / 🏆 Commissioner** — Manage league governance data.",
    )
    .setFooter({ text: "Server Setup sub-menu" })
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_init_existing").setLabel("⚡ Init Existing Server").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_init_new").setLabel("🏗️ Init NEW Server").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_manual_channel_link").setLabel("🔗 Manual Channel Link").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_set_franchise_len").setLabel("📏 Set Franchise Length").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_waitlist").setLabel("📋 Waitlist").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_admins").setLabel("👥 Admins").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_commissioner").setLabel("🏆 Commissioner").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_server_settings").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({ embeds: [embed], components: [row1, row2, row3] });
}

// ── Init Existing Server ───────────────────────────────────────────────────────

async function handleInitExisting(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_init_existing")
    .setTitle("Init Existing Server");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("starting_week")
        .setLabel("Starting Week (e.g. training_camp, week_1)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("training_camp")
        .setValue("training_camp"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue("10"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("current_season")
        .setLabel("Current Season Number")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1")
        .setValue("1"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalInitExisting(interaction: ModalSubmitInteraction) {
  const guildId             = interaction.guildId!;
  const startingWeek        = interaction.fields.getTextInputValue("starting_week").trim() || "training_camp";
  const franchiseLength     = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("franchise_length").trim(), 10) || 10));
  const currentSeasonNumber = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("current_season").trim(), 10) || 1));

  await interaction.deferReply({ ephemeral: true });

  try {
    const { log } = await runExistingServerInit({
      guildId, userId: interaction.user.id, userTag: interaction.user.tag,
      startingWeek, franchiseLength, currentSeasonNumber,
    });

    await registerCommandsForGuild(guildId);
    log.push("⚡ Slash commands re-registered for this server.");

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Existing Server Initialized")
      .setDescription(log.join("\n"))
      .setFooter({ text: "No channels were modified — only DB data was updated" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("[handleModalInitExisting]", err);
    await interaction.editReply({ content: `❌ Initialization failed: ${(err as Error).message}` });
  }
}

// ── Init NEW Server ────────────────────────────────────────────────────────────

async function handleInitNew(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Init NEW Server — Destructive Warning")
    .setDescription(
      "**This will PERMANENTLY DELETE all existing Discord channels** and rebuild the server from scratch.\n\n" +
      "This includes ALL categories, text channels, and voice channels. This action **cannot be undone**.\n\n" +
      "Only proceed on a brand-new server or if you are completely rebuilding the league server structure.\n\n" +
      "Click **Proceed** to enter setup options, or **Cancel** to go back.",
    )
    .setFooter({ text: "ALL channels will be deleted — this is irreversible" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_init_new_proceed").setLabel("⚠️ Proceed — I understand channels will be deleted").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_server_setup").setLabel("← Cancel").setStyle(ButtonStyle.Secondary),
  );

  await (interaction as any).update({ embeds: [embed], components: [row] });
}

async function handleInitNewProceed(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_init_new")
    .setTitle("Initialize New Server");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("starting_week")
        .setLabel("Starting Week (e.g. training_camp, week_1)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("training_camp")
        .setValue("training_camp"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue("10"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("current_season")
        .setLabel("Current Season Number")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1")
        .setValue("1"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalInitNew(interaction: ModalSubmitInteraction) {
  const guildId             = interaction.guildId!;
  const guild               = interaction.guild;
  const startingWeek        = interaction.fields.getTextInputValue("starting_week").trim() || "training_camp";
  const franchiseLength     = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("franchise_length").trim(), 10) || 10));
  const currentSeasonNumber = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("current_season").trim(), 10) || 1));

  if (!guild) {
    await interaction.reply({ content: "❌ Must be run inside a Discord server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const { embed, log } = await runNewServerInit({
      guildId,
      userId:              interaction.user.id,
      userTag:             interaction.user.tag,
      guild,
      startingWeek,
      franchiseLength,
      currentSeasonNumber,
      editReply:    (content) => interaction.editReply({ content }),
      fetchChannel: (id)      => interaction.client.channels.fetch(id),
    });

    await registerCommandsForGuild(guildId);
    log.push("⚡ Slash commands registered for this server.");

    const logEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📋 Initialization Log")
      .setDescription(log.join("\n").slice(0, 4000))
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({ embeds: [embed, logEmbed], components: [row] });
  } catch (err) {
    console.error("[handleModalInitNew]", err);
    await interaction.editReply({ content: `❌ Initialization failed: ${(err as Error).message}` });
  }
}

// ── Set Franchise Length ───────────────────────────────────────────────────────

async function handleSetFranchiseLen(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const settings = await getServerSettings(guildId);

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_franchise_len")
    .setTitle("Set Franchise Length");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (number of seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue(String(settings.maxSeasons ?? 10)),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalFranchiseLen(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId!;
  const raw     = interaction.fields.getTextInputValue("franchise_length").trim();
  const limit   = parseInt(raw, 10);

  if (isNaN(limit) || limit < 1 || limit > 30) {
    await interaction.reply({ content: "❌ Please enter a whole number between 1 and 30.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await db.update(serverSettingsTable)
    .set({ maxSeasons: limit, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, guildId));

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📏 Franchise Length Updated")
    .setDescription(`Franchise length set to **${limit}** season(s).`)
    .setFooter({ text: "Use Server Setup to view all setup options" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── Manual Channel Link ────────────────────────────────────────────────────────

const MANUAL_LINKABLE: { label: string; value: string; description: string }[] = [
  { label: "Commissioner Log",    value: CHANNEL_KEYS.COMMISSIONER_LOG,    description: "General commissioner log"        },
  { label: "Transaction Log",     value: CHANNEL_KEYS.TRANSACTION_LOG,     description: "Coin movement transactions"      },
  { label: "Upgrades Log",        value: CHANNEL_KEYS.UPGRADES_LOG,        description: "Dev/age/attribute upgrades"      },
  { label: "Draft Purchases Log", value: CHANNEL_KEYS.DRAFT_PURCHASES_LOG, description: "Legend & custom player purchases" },
  { label: "Import Log",          value: CHANNEL_KEYS.IMPORT_LOG,          description: "Week import confirmations"       },
  { label: "Violation Log",       value: CHANNEL_KEYS.VIOLATION_LOG,       description: "Rule violation reports"         },
  { label: "Commissioner",        value: CHANNEL_KEYS.COMMISSIONER,        description: "Legacy fallback channel"        },
  { label: "Transactions",        value: CHANNEL_KEYS.TRANSACTIONS,        description: "Legacy transaction channel"     },
  { label: "Announcements",       value: CHANNEL_KEYS.ANNOUNCEMENTS,       description: "League announcements"           },
  { label: "Matchups",            value: CHANNEL_KEYS.MATCHUPS,            description: "Weekly matchups post"           },
  { label: "Schedule",            value: CHANNEL_KEYS.SCHEDULE,            description: "Season schedule"               },
  { label: "GOTW",                value: CHANNEL_KEYS.GOTW,                description: "Game of the Week poll"         },
  { label: "League Twitter",      value: CHANNEL_KEYS.LEAGUE_TWITTER,      description: "AI Twitter feed"               },
  { label: "Headlines",           value: CHANNEL_KEYS.HEADLINES,           description: "Media headlines"               },
  { label: "GOTY",                value: CHANNEL_KEYS.GOTY,                description: "Game of the Year"              },
  { label: "Draft Tracker",       value: CHANNEL_KEYS.DRAFT_TRACKER,       description: "Draft tracker"                 },
  { label: "Payouts",             value: CHANNEL_KEYS.PAYOUTS,             description: "Payout announcements"         },
  { label: "Welcome",             value: CHANNEL_KEYS.WELCOME,             description: "New member welcome"            },
  { label: "General",             value: CHANNEL_KEYS.GENERAL,             description: "General channel"              },
  { label: "Stream",              value: CHANNEL_KEYS.STREAM,              description: "Stream notifications"          },
  { label: "Highlights",          value: CHANNEL_KEYS.HIGHLIGHTS,          description: "Game highlights"              },
];

async function handleManualChannelLinkPicker(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  // Load all currently saved channel links for this guild in one query
  const savedLinks = await db.select()
    .from(guildChannelsTable)
    .where(eq(guildChannelsTable.guildId, guildId));
  const linkMap = new Map(savedLinks.map(r => [r.channelKey, r.channelId]));

  // Resolve channel names from the guild channel cache
  await interaction.guild?.channels.fetch().catch(() => null);
  const chCache = interaction.guild?.channels.cache;
  const chName  = (id: string | undefined) => {
    if (!id) return null;
    const ch = chCache?.get(id);
    return ch ? `#${ch.name}` : `#${id}`;
  };

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_manual_ch_select")
    .setPlaceholder("Select a channel function to link…")
    .addOptions(
      MANUAL_LINKABLE.map(item => {
        const linkedName = chName(linkMap.get(item.value));
        const desc = linkedName
          ? `Currently: ${linkedName}`.slice(0, 50)
          : item.description.slice(0, 50);
        return new StringSelectMenuOptionBuilder()
          .setLabel(item.label)
          .setValue(item.value)
          .setDescription(desc);
      }),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const linkedCount = MANUAL_LINKABLE.filter(i => linkMap.has(i.value)).length;
  const embed = new EmbedBuilder()
    .setTitle("🔗 Manual Channel Link")
    .setDescription(
      `**${linkedCount}/${MANUAL_LINKABLE.length}** channel functions are currently linked.\n\n` +
      "Select a function below to assign it to a channel — you'll see the server's channels listed in a dropdown. " +
      "Choose **🗑️ Clear link** to remove an existing link (the bot will fall back to the commissioner channel).",
    )
    .setColor(0x5865f2);

  await (interaction as any).update({
    embeds: [embed],
    components: [row as ActionRowBuilder<any>],
  });
}

async function handleManualChannelSelect(interaction: StringSelectMenuInteraction) {
  const key      = interaction.values[0]!;
  const keyLabel = MANUAL_LINKABLE.find(k => k.value === key)?.label ?? key;

  // Fetch guild text channels
  await interaction.guild?.channels.fetch().catch(() => null);
  const textChannels = (interaction.guild?.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(ch => ({ id: ch.id, name: ch.name })) ?? []) as { id: string; name: string }[];

  const CLEAR_OPTION = new StringSelectMenuOptionBuilder()
    .setLabel("🗑️ Clear link (use fallback)")
    .setValue("CLEAR")
    .setDescription("Remove this channel link; bot falls back to commissioner channel");

  const rows: ActionRowBuilder<any>[] = [];

  // First dropdown: first 24 text channels + clear option (max 25)
  const firstBatch = textChannels.slice(0, 24);
  const firstMenu  = new StringSelectMenuBuilder()
    .setCustomId(`ao_ch_assign:${key}`)
    .setPlaceholder(`Assign channel for: ${keyLabel}`)
    .addOptions([
      CLEAR_OPTION,
      ...firstBatch.map(ch =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`#${ch.name}`.slice(0, 100))
          .setValue(ch.id),
      ),
    ]);
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(firstMenu) as ActionRowBuilder<any>);

  // Second dropdown: channels 25–49 if they exist (max 25 per menu)
  const secondBatch = textChannels.slice(24, 49);
  if (secondBatch.length > 0) {
    const secondMenu = new StringSelectMenuBuilder()
      .setCustomId(`ao_ch_assign:${key}`)
      .setPlaceholder("…more channels")
      .addOptions(
        secondBatch.map(ch =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${ch.name}`.slice(0, 100))
            .setValue(ch.id),
        ),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(secondMenu) as ActionRowBuilder<any>);
  }

  // Back button row
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_manual_channel_link").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
    ) as ActionRowBuilder<any>,
  );

  const embed = new EmbedBuilder()
    .setTitle(`🔗 ${keyLabel}`)
    .setDescription(`Select a channel from the dropdown${secondBatch.length > 0 ? "s" : ""} below to link it, or choose **🗑️ Clear link** to remove the current assignment.`)
    .setColor(0x5865f2);

  await (interaction as any).update({ embeds: [embed], components: rows });
}

async function handleChannelAssign(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const key      = interaction.customId.split(":").slice(1).join(":"); // everything after first ":"
  const value    = interaction.values[0]!;
  const keyLabel = MANUAL_LINKABLE.find(k => k.value === key)?.label ?? key;

  if (value === "CLEAR") {
    await setGuildChannel(guildId, key, null);
    await interaction.reply({
      content: `✅ **${keyLabel}** link cleared — messages will fall back to the commissioner channel.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await setGuildChannel(guildId, key, value);
  await interaction.reply({
    content: `✅ **${keyLabel}** linked to <#${value}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Troubleshoot Hub ───────────────────────────────────────────────────────────

async function handleTroubleshootHub(interaction: ButtonInteraction) {
  await (interaction as any).update({
    embeds: [buildTroubleshootEmbed()],
    components: buildTroubleshootRows() as ActionRowBuilder<any>[],
  });
}

// ── Report Bug ─────────────────────────────────────────────────────────────────

async function handleReportBug(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_report_bug")
    .setTitle("Report a Bug");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("bug_title")
        .setLabel("Bug Title / Summary")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. GOTW bonus not awarded in Week 7")
        .setRequired(true)
        .setMaxLength(200),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("bug_description")
        .setLabel("Description / Steps to Reproduce")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Describe what happened, what you expected, and any relevant details...")
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalReportBug(interaction: ModalSubmitInteraction) {
  const guildId     = interaction.guildId!;
  const title       = interaction.fields.getTextInputValue("bug_title").trim();
  const description = interaction.fields.getTextInputValue("bug_description").trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    const commLogChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG);
    if (commLogChannelId) {
      const ch = (interaction.client.channels.cache.get(commLogChannelId)
        ?? await interaction.client.channels.fetch(commLogChannelId).catch(() => null)) as TextChannel | null;
      if (ch?.isTextBased()) {
        await (ch as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle(`🐛 Bug Report: ${title}`)
              .setDescription(description)
              .setFooter({ text: `Reported by ${interaction.user.username} (${interaction.user.id})` })
              .setTimestamp(),
          ],
        });
      }
    }

    await interaction.editReply({ content: `✅ Bug report submitted: **${title}**. It has been logged to the commissioner log.` });
  } catch (err) {
    console.error("[admin-operations] Bug report error:", err);
    await interaction.editReply({ content: `❌ Failed to submit bug report: ${err}` });
  }
}


import { handleSetWeek, handleSetWeekSelect, handleAdvanceWeek, handleAdvanceConfirm, postCommissionerNotice, toChannelName, performAdvanceWeek } from "./admin-week-handlers.js";
import { buildRulesPages, handleRulesHub, handleRulesSection, handleRulesAdd, handleRulesEdit, handleRulesEditSel, handleRulesDelete, handleRulesPage, handleModalRulesAdd, handleModalRulesEdit, handleModalRulesDelete } from "./admin-rules-handlers.js";

// ── Set Season Number ──────────────────────────────────────────────────────────

async function getMaxSeasons(guildId: string): Promise<number> {
  const [row] = await db.select({ maxSeasons: serverSettingsTable.maxSeasons })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  return row?.maxSeasons ?? 10;
}

async function handleSetSeasonNum(interaction: ButtonInteraction) {
  const guildId   = interaction.guildId!;
  const [season, maxSeasons] = await Promise.all([
    getOrCreateActiveSeason(guildId),
    getMaxSeasons(guildId),
  ]);
  const current = season.seasonNumber ?? 1;

  const options = Array.from({ length: maxSeasons }, (_, i) => i + 1).map(n =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`Season ${n}${n === current ? " (current)" : ""}`)
      .setValue(String(n))
      .setDefault(n === current),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_set_season_num_sel")
    .setPlaceholder(`Current: Season ${current} of ${maxSeasons}`)
    .addOptions(options);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🔢 Set Season Number")
        .setDescription(
          `Select the season number to activate.\n\n` +
          `Current season: **Season ${current} of ${maxSeasons}**\n\n` +
          `⚠️ This sets the active season record only — it does **not** roll over inventories or player data. ` +
          `Use **Advance Week** through Training Camp for a full season rollover.`
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumSel(interaction: StringSelectMenuInteraction) {
  const guildId   = interaction.guildId!;
  const target    = parseInt(interaction.values[0]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);
  const isLast    = target >= maxSeasons;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Blue)
        .setTitle("🔢 Confirm Season Change")
        .setDescription(
          `Set the active season to **Season ${target} of ${maxSeasons}**?\n\n` +
          (isLast ? "⚠️ This is the **final season** of the franchise.\n\n" : "") +
          `This will activate (or create) the Season ${target} record. ` +
          `Coin balances and inventories are unchanged.`
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ao_set_season_num_confirm:${target}`)
          .setLabel(`✅ Set to Season ${target}`)
          .setStyle(isLast ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumConfirm(interaction: ButtonInteraction) {
  const guildId    = interaction.guildId!;
  const target     = parseInt(interaction.customId.split(":")[1]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);

  // Check if this season already exists for THIS guild only.
  const [existing] = await db.select().from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
    .limit(1);

  // Deactivate all seasons for THIS guild only (not all guilds).
  await db.update(seasonsTable)
    .set({ isActive: false })
    .where(eq(seasonsTable.guildId, guildId));

  let activeSeason;
  if (existing) {
    // Activate the existing season record for this guild.
    const [updated] = await db.update(seasonsTable)
      .set({ isActive: true })
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
      .returning();
    activeSeason = updated;
  } else {
    // Season doesn't exist yet for this guild — create it.
    const [created] = await db.insert(seasonsTable)
      .values({ guildId, seasonNumber: target, isActive: true })
      .returning();
    activeSeason = created;
  }

  const isLast = target >= maxSeasons;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Green)
        .setTitle(`📅 Season Set to ${target} of ${maxSeasons}`)
        .setDescription(
          `The active season is now **Season ${target}**.\n\n` +
          `Season ID: \`${activeSeason?.id ?? "?"}\`` +
          (isLast ? "\n\n🏁 **This is the final season of the franchise.**" : "")
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}


import {} from "./admin-week-handlers.js"; // week handlers
import { buildRulesPages, handleRulesHub, handleRulesSection, handleRulesAdd, handleRulesEdit, handleRulesEditSel, handleRulesDelete, handleRulesPage, handleModalRulesAdd, handleModalRulesEdit, handleModalRulesDelete } from "./admin-rules-handlers.js";

// ── Set Season Number ──────────────────────────────────────────────────────────

async function getMaxSeasons(guildId: string): Promise<number> {
  const [row] = await db.select({ maxSeasons: serverSettingsTable.maxSeasons })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  return row?.maxSeasons ?? 10;
}

async function handleSetSeasonNum(interaction: ButtonInteraction) {
  const guildId   = interaction.guildId!;
  const [season, maxSeasons] = await Promise.all([
    getOrCreateActiveSeason(guildId),
    getMaxSeasons(guildId),
  ]);
  const current = season.seasonNumber ?? 1;

  const options = Array.from({ length: maxSeasons }, (_, i) => i + 1).map(n =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`Season ${n}${n === current ? " (current)" : ""}`)
      .setValue(String(n))
      .setDefault(n === current),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_set_season_num_sel")
    .setPlaceholder(`Current: Season ${current} of ${maxSeasons}`)
    .addOptions(options);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🔢 Set Season Number")
        .setDescription(
          `Select the season number to activate.\n\n` +
          `Current season: **Season ${current} of ${maxSeasons}**\n\n` +
          `⚠️ This sets the active season record only — it does **not** roll over inventories or player data. ` +
          `Use **Advance Week** through Training Camp for a full season rollover.`
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumSel(interaction: StringSelectMenuInteraction) {
  const guildId   = interaction.guildId!;
  const target    = parseInt(interaction.values[0]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);
  const isLast    = target >= maxSeasons;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Blue)
        .setTitle("🔢 Confirm Season Change")
        .setDescription(
          `Set the active season to **Season ${target} of ${maxSeasons}**?\n\n` +
          (isLast ? "⚠️ This is the **final season** of the franchise.\n\n" : "") +
          `This will activate (or create) the Season ${target} record. ` +
          `Coin balances and inventories are unchanged.`
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ao_set_season_num_confirm:${target}`)
          .setLabel(`✅ Set to Season ${target}`)
          .setStyle(isLast ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumConfirm(interaction: ButtonInteraction) {
  const guildId    = interaction.guildId!;
  const target     = parseInt(interaction.customId.split(":")[1]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);

  // Check if this season already exists for THIS guild only.
  const [existing] = await db.select().from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
    .limit(1);

  // Deactivate all seasons for THIS guild only (not all guilds).
  await db.update(seasonsTable)
    .set({ isActive: false })
    .where(eq(seasonsTable.guildId, guildId));

  let activeSeason;
  if (existing) {
    // Activate the existing season record for this guild.
    const [updated] = await db.update(seasonsTable)
      .set({ isActive: true })
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
      .returning();
    activeSeason = updated;
  } else {
    // Season doesn't exist yet for this guild — create it.
    const [created] = await db.insert(seasonsTable)
      .values({ guildId, seasonNumber: target, isActive: true })
      .returning();
    activeSeason = created;
  }

  const isLast = target >= maxSeasons;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Green)
        .setTitle(`📅 Season Set to ${target} of ${maxSeasons}`)
        .setDescription(
          `The active season is now **Season ${target}**.\n\n` +
          `Season ID: \`${activeSeason?.id ?? "?"}\`` +
          (isLast ? "\n\n🏁 **This is the final season of the franchise.**" : "")
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}




// ── Shared types ──────────────────────────────────────────────────────────────


export 


