import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import {
  getAllPayoutKeys, getAllPayoutConfig, setPayoutValue, PAYOUT_KEYS,
  type PayoutKey,
} from "../lib/payout-config.js";
import { getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";
import { COSTS, LIMITS } from "../lib/constants.js";
import { getSettings as getCustomPlayerSettings, packageCost, packagePoints } from "../lib/custom-player-helpers.js";

// ── Win milestone bonuses (hardcoded by design — balancing milestone tiers) ───
const MILESTONES = [
  { wins:  5, bonus:  100 },
  { wins: 12, bonus:  250 },
  { wins: 25, bonus:  500 },
  { wins: 50, bonus: 1000 },
];

export const data = new SlashCommandBuilder()
  .setName("admin-setpayouts")
  .setDescription("Admin: view or update all configurable economy amounts")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("view")
    .setDescription("Show ALL current economy values (payouts, bonuses, store prices)"))
  .addSubcommand(sub => sub
    .setName("set")
    .setDescription("Update a specific payout or bonus amount")
    .addStringOption(o => o
      .setName("reward")
      .setDescription("Which value to update")
      .setRequired(true)
      .addChoices(
        // ── Game payouts ──────────────────────────────────────────────────────
        { name: "🎮 Game — H2H win (both players played)",               value: PAYOUT_KEYS.H2H_WIN         },
        { name: "🎮 Game — H2H loss (both players played)",              value: PAYOUT_KEYS.H2H_LOSS        },
        { name: "🤖 Game — CPU/force win (one-sided or simmed game)",    value: PAYOUT_KEYS.CPU_WIN         },
        // ── Season bonuses ────────────────────────────────────────────────────
        { name: "🏅 Season bonus — in-game award winner (per team)",     value: PAYOUT_KEYS.AWARD_WIN_BONUS },
        { name: "📊 Season PR bonus — #1 ranked player",                 value: PAYOUT_KEYS.SEASON_PR_1     },
        { name: "📊 Season PR bonus — #2 ranked player",                 value: PAYOUT_KEYS.SEASON_PR_2     },
        { name: "📊 Season PR bonus — #3–6 ranked players",              value: PAYOUT_KEYS.SEASON_PR_3_6   },
        { name: "📊 Season PR bonus — #7–8 ranked players",              value: PAYOUT_KEYS.SEASON_PR_7_8   },
        { name: "📊 Season PR bonus — #9–10 ranked players",             value: PAYOUT_KEYS.SEASON_PR_9_10  },
        { name: "🎮 GOTY award — coins per winner",                      value: PAYOUT_KEYS.GOTY_WINNER     },
        // ── Individual player bonuses ──────────────────────────────────────────
        { name: "🏃 EOS bonus — top RB qualifying YPC (coins)",           value: PAYOUT_KEYS.EOS_RB_YPC_BONUS    },
        { name: "🏈 EOS bonus — top QB qualifying YPA (coins)",           value: PAYOUT_KEYS.EOS_QB_YPA_BONUS    },
        { name: "🛡️ EOS bonus — DB individual player 8+ INTs",           value: PAYOUT_KEYS.EOS_DB_INT_BONUS    },
        { name: "😔 EOS consolation — missed playoffs (user team)",       value: PAYOUT_KEYS.EOS_MISSED_PLAYOFFS },
        // ── Stat minimum attempt thresholds ────────────────────────────────────
        { name: "🏈 EOS QB YPA — minimum pass attempts to qualify",       value: PAYOUT_KEYS.EOS_QB_MIN_ATT           },
        { name: "🏃 EOS RB YPC — minimum rush attempts to qualify",       value: PAYOUT_KEYS.EOS_RB_MIN_ATT           },
        // ── GOTW voter bonuses ───────────────────────────────────────────────────
        { name: "🏈 GOTW — correct guess bonus (regular season)",          value: PAYOUT_KEYS.GOTW_REGULAR_BONUS       },
        { name: "🏆 GOTW — correct guess bonus (playoffs)",                value: PAYOUT_KEYS.GOTW_PLAYOFF_BONUS       },
        // ── Channel activity payouts ─────────────────────────────────────────────
        { name: "📺 Activity — Twitch stream payout (each side)",          value: PAYOUT_KEYS.STREAM_PAYOUT            },
        { name: "🎬 Activity — Highlight video payout (regular season)",   value: PAYOUT_KEYS.HIGHLIGHT_PAYOUT         },
        { name: "🎬 Activity — Highlight video payout (postseason)",       value: PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT },
        { name: "🎬 Activity — Max highlight videos paid per week",        value: PAYOUT_KEYS.HIGHLIGHT_LIMIT          },
      ))
    .addIntegerOption(o => o
      .setName("amount")
      .setDescription("New coin amount (0 or more)")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(10000)));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── VIEW ───────────────────────────────────────────────────────────────────
  if (sub === "view_payout_settings") {
    const config = await getAllPayoutConfig();
    const keys   = getAllPayoutKeys();
    const season     = await getOrCreateActiveSeason(interaction.guildId!);
    const rules      = await getSeasonRules(season);
    const cpSettings = await getCustomPlayerSettings();

    // ── Section 1: Game Payouts ──────────────────────────────────────────────
    const gameKeys    = keys.filter(k => k.category === "Game Payouts");
    const gameLines   = gameKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} 🪙** — ${description} ${tag}`;
    });

    // ── Section 1b: GOTW Voter Bonuses ──────────────────────────────────────
    const gotwKeys   = keys.filter(k => k.category === "GOTW Bonuses");
    const gotwLines  = gotwKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} 🪙** — ${description} ${tag}`;
    });

    // ── Section 1c: Channel Activity Payouts ────────────────────────────────
    const activityKeys  = keys.filter(k => k.category === "Activity Payouts");
    const activityLines = activityKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      const unit    = key === "highlight_limit" ? "" : " 🪙";
      return `**${current}${unit}** — ${description} ${tag}`;
    });

    // ── Section 2: End-of-Season Bonuses ────────────────────────────────────
    const bonusKeys   = keys.filter(k => k.category === "Season Bonuses");
    const bonusLines  = bonusKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} 🪙** — ${description} ${tag}`;
    });

    // ── Section 2b: Individual Player Bonuses ───────────────────────────────
    const indivKeys  = keys.filter(k => k.category === "Individual Bonuses");
    const indivLines = indivKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} 🪙** — ${description} ${tag}`;
    });

    // ── Section 2c: Stat Minimums (attempt thresholds — not coin values) ────
    const minKeys  = keys.filter(k => k.category === "Stat Minimums");
    const minLines = minKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} attempts/carries** — ${description} ${tag}`;
    });

    // ── Section 2d: Stat Thresholds (qualifying thresholds for flat bonuses) ──
    const threshKeys  = keys.filter(k => k.category === "Stat Thresholds");
    const threshLines = threshKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      // YPA and YPC are stored ×10 — display as decimal for readability
      const isDecimal = key === "eos_qb_min_ypa" || key === "eos_rb_min_ypc";
      const display   = isDecimal ? `${(current / 10).toFixed(1)}` : `${current}`;
      const unit      = isDecimal ? "" : " INTs";
      return `**${display}${unit}** — ${description} ${tag}`;
    });

    // ── Section 3: Store Prices (from season rules) ──────────────────────────
    const storeLines = [
      `**${rules.legendCost.toLocaleString()} 🪙** — Legend card${rules.legendCost !== COSTS.legend ? " *(custom)*" : " *(default)*"}`,
      `**${rules.coreAttrCost} 🪙/pt** — Core attribute upgrade (cap: ${rules.coreAttrCap}/season)${rules.coreAttrCost !== COSTS.core_attribute ? " *(custom)*" : " *(default)*"}`,
      `**${rules.nonCoreAttrCost} 🪙/pt** — Non-core attribute upgrade (cap: ${rules.nonCoreAttrCap}/season)${rules.nonCoreAttrCost !== COSTS.non_core_attribute ? " *(custom)*" : " *(default)*"}`,
      `**${rules.devUpsCost} 🪙** — Development upgrade (cap: ${rules.devUpsCap}/season)${rules.devUpsCost !== COSTS.dev_up ? " *(custom)*" : " *(default)*"}`,
      `**${rules.ageResetCost} 🪙** — Age reset (cap: ${rules.ageResetsCap}/season)${rules.ageResetCost !== COSTS.age_reset ? " *(custom)*" : " *(default)*"}`,
      `**${packageCost("gold", cpSettings)} 🪙** — Custom player (Gold, ${packagePoints("gold", cpSettings)} creation pts) *(via /admin-customplayersettings)*`,
      `**${packageCost("silver", cpSettings)} 🪙** — Custom player (Silver, ${packagePoints("silver", cpSettings)} creation pts) *(via /admin-customplayersettings)*`,
      `**${packageCost("bronze", cpSettings)} 🪙** — Custom player (Bronze, ${packagePoints("bronze", cpSettings)} creation pts) *(via /admin-customplayersettings)*`,
      `**${packageCost("kp", cpSettings)} 🪙** — Custom player (K/P, ${packagePoints("kp", cpSettings)} creation pts) *(via /admin-customplayersettings)*`,
    ];

    // ── Section 4: Win Milestone Bonuses (hardcoded) ─────────────────────────
    const milestoneLines = MILESTONES.map(m =>
      `**${m.bonus} 🪙** — Milestone bonus at **${m.wins} all-time H2H wins** *(hardcoded)*`
    );

    const embed = new EmbedBuilder()
      .setTitle("💰 Economy Configuration — All Values")
      .setColor(Colors.Blurple)
      .addFields(
        {
          name:   "🎮 Game Payouts",
          value:  gameLines.join("\n"),
          inline: false,
        },
        ...(gotwLines.length > 0 ? [{
          name:   "🏈 GOTW Voter Bonuses",
          value:  gotwLines.join("\n"),
          inline: false,
        }] : []),
        ...(activityLines.length > 0 ? [{
          name:   "📺 Channel Activity Payouts",
          value:  activityLines.join("\n"),
          inline: false,
        }] : []),
        {
          name:   "🏆 End-of-Season Bonuses",
          value:  bonusLines.join("\n"),
          inline: false,
        },
        {
          name:   "🏃 Individual Player Bonuses *(set via /admin-setpayouts set)*",
          value:  indivLines.join("\n"),
          inline: false,
        },
        ...(minLines.length > 0 ? [{
          name:   "📏 Attempt Minimums *(must hit this volume to be eligible)*",
          value:  minLines.join("\n"),
          inline: false,
        }] : []),
        ...(threshLines.length > 0 ? [{
          name:   "📐 Qualifying Thresholds *(must hit this stat rate to earn the bonus)*",
          value:  threshLines.join("\n"),
          inline: false,
        }] : []),
        {
          name:   "🏪 Store Prices *(edit via /admin-season)*",
          value:  storeLines.join("\n"),
          inline: false,
        },
        {
          name:   "🎯 Win Milestone Bonuses *(hardcoded)*",
          value:  milestoneLines.join("\n"),
          inline: false,
        },
      )
      .setFooter({ text: "Use /admin-setpayouts set to update Game Payouts or Season Bonuses • Store prices via /admin-season" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── SET ────────────────────────────────────────────────────────────────────
  if (sub === "set_payout_amounts") {
    const key    = interaction.options.getString("reward", true) as PayoutKey;
    const amount = interaction.options.getInteger("amount", true);
    await setPayoutValue(key, amount, interaction.user.id);
    const meta   = getAllPayoutKeys().find(k => k.key === key)!;

    const isAttemptKey  = meta.category === "Stat Minimums";
    const isDecimalKey  = key === "eos_qb_min_ypa" || key === "eos_rb_min_ypc";
    const isIntKey      = key === "eos_db_min_ints";
    const fmt = (v: number) =>
      isAttemptKey  ? `**${v} attempts/carries**` :
      isDecimalKey  ? `**${(v / 10).toFixed(1)}** (stored as ${v}×10)` :
      isIntKey      ? `**${v} INTs**` :
      `**${v} 🪙**`;

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Economy Value Updated")
        .setColor(Colors.Green)
        .addFields(
          { name: "Setting",    value: meta.description,           inline: false },
          { name: "New Value",  value: fmt(amount),                inline: true  },
          { name: "Default",    value: fmt(meta.defaultValue),     inline: true  },
          { name: "Category",   value: meta.category,              inline: true  },
        )
        .setFooter({ text: `Updated by ${interaction.user.username}` })
        .setTimestamp()],
    });
  }
}
