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
        { name: "🏃 EOS bonus — RB 7.0+ YPC (100+ carries)",             value: PAYOUT_KEYS.EOS_RB_YPC_BONUS },
        { name: "🏈 EOS bonus — QB 8.5+ YPA (150+ attempts)",            value: PAYOUT_KEYS.EOS_QB_YPA_BONUS },
        { name: "🛡️ EOS bonus — DB individual player 8+ INTs",           value: PAYOUT_KEYS.EOS_DB_INT_BONUS },
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
  if (sub === "view") {
    const config = await getAllPayoutConfig();
    const keys   = getAllPayoutKeys();
    const season = await getOrCreateActiveSeason();
    const rules  = await getSeasonRules(season);

    // ── Section 1: Game Payouts ──────────────────────────────────────────────
    const gameKeys    = keys.filter(k => k.category === "Game Payouts");
    const gameLines   = gameKeys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const tag     = current === defaultValue ? "*(default)*" : "*(custom)*";
      return `**${current} 🪙** — ${description} ${tag}`;
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

    // ── Section 3: Store Prices (from season rules) ──────────────────────────
    const storeLines = [
      `**${rules.legendCost.toLocaleString()} 🪙** — Legend card${rules.legendCost !== COSTS.legend ? " *(custom)*" : " *(default)*"}`,
      `**${rules.coreAttrCost} 🪙/pt** — Core attribute upgrade (cap: ${rules.coreAttrCap}/season)${rules.coreAttrCost !== COSTS.core_attribute ? " *(custom)*" : " *(default)*"}`,
      `**${rules.nonCoreAttrCost} 🪙/pt** — Non-core attribute upgrade (cap: ${rules.nonCoreAttrCap}/season)${rules.nonCoreAttrCost !== COSTS.non_core_attribute ? " *(custom)*" : " *(default)*"}`,
      `**${rules.devUpsCost} 🪙** — Development upgrade (cap: ${rules.devUpsCap}/season)${rules.devUpsCost !== COSTS.dev_up ? " *(custom)*" : " *(default)*"}`,
      `**${rules.ageResetCost} 🪙** — Age reset (cap: ${rules.ageResetsCap}/season)${rules.ageResetCost !== COSTS.age_reset ? " *(custom)*" : " *(default)*"}`,
      `**${rules.customGoldCost} 🪙** — Custom player (Gold)${rules.customGoldCost !== COSTS.custom_player_gold ? " *(custom)*" : " *(default)*"}`,
      `**${rules.customSilverCost} 🪙** — Custom player (Silver)${rules.customSilverCost !== COSTS.custom_player_silver ? " *(custom)*" : " *(default)*"}`,
      `**${rules.customBronzeCost} 🪙** — Custom player (Bronze)${rules.customBronzeCost !== COSTS.custom_player_bronze ? " *(custom)*" : " *(default)*"}`,
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
  if (sub === "set") {
    const key    = interaction.options.getString("reward", true) as PayoutKey;
    const amount = interaction.options.getInteger("amount", true);
    await setPayoutValue(key, amount, interaction.user.id);
    const meta   = getAllPayoutKeys().find(k => k.key === key)!;

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Economy Value Updated")
        .setColor(Colors.Green)
        .addFields(
          { name: "Setting",    value: meta.description,         inline: false },
          { name: "New Amount", value: `**${amount} 🪙**`,        inline: true  },
          { name: "Default",    value: `${meta.defaultValue} 🪙`, inline: true  },
          { name: "Category",   value: meta.category,            inline: true  },
        )
        .setFooter({ text: `Updated by ${interaction.user.username}` })
        .setTimestamp()],
    });
  }
}
