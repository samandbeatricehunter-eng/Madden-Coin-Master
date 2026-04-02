import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import {
  getAllPayoutKeys, getAllPayoutConfig, setPayoutValue, PAYOUT_KEYS,
  type PayoutKey,
} from "../lib/payout-config.js";

export const data = new SlashCommandBuilder()
  .setName("admin-setpayouts")
  .setDescription("Admin: view or update configurable payout amounts for end-of-season rewards")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("view")
    .setDescription("Show all current payout amounts"))
  .addSubcommand(sub => sub
    .setName("set")
    .setDescription("Update a specific payout amount")
    .addStringOption(o => o
      .setName("reward")
      .setDescription("Which reward to update")
      .setRequired(true)
      .addChoices(
        { name: "Award Win Bonus (per team with an in-game season award winner)", value: PAYOUT_KEYS.AWARD_WIN_BONUS  },
        { name: "Season PR — #1 ranked player",                                  value: PAYOUT_KEYS.SEASON_PR_1      },
        { name: "Season PR — #2 ranked player",                                  value: PAYOUT_KEYS.SEASON_PR_2      },
        { name: "Season PR — #3–6 ranked players",                               value: PAYOUT_KEYS.SEASON_PR_3_6    },
        { name: "Season PR — #7–8 ranked players",                               value: PAYOUT_KEYS.SEASON_PR_7_8    },
        { name: "Season PR — #9–10 ranked players",                              value: PAYOUT_KEYS.SEASON_PR_9_10   },
        { name: "GOTY Award — coins per winner",                                 value: PAYOUT_KEYS.GOTY_WINNER      },
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

  if (sub === "view") {
    const config  = await getAllPayoutConfig();
    const keys    = getAllPayoutKeys();
    const lines   = keys.map(({ key, description, defaultValue }) => {
      const current = config.get(key) ?? defaultValue;
      const note    = current === defaultValue ? " *(default)*" : " *(custom)*";
      return `**${current} 🪙** — ${description}${note}`;
    });
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("💰 End-of-Season Payout Configuration")
        .setColor(Colors.Blurple)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Use /admin-setpayouts set to update any amount" })
        .setTimestamp()],
    });
    return;
  }

  if (sub === "set") {
    const key    = interaction.options.getString("reward", true) as PayoutKey;
    const amount = interaction.options.getInteger("amount", true);
    await setPayoutValue(key, amount, interaction.user.id);
    const meta   = getAllPayoutKeys().find(k => k.key === key)!;
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Payout Updated")
        .setColor(Colors.Green)
        .addFields(
          { name: "Reward",     value: meta.description,        inline: false },
          { name: "New Amount", value: `**${amount} 🪙**`,       inline: true  },
          { name: "Default",    value: `${meta.defaultValue} 🪙`, inline: true  },
        )
        .setTimestamp()],
    });
  }
}
