import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, Colors,
  EmbedBuilder,
} from "discord.js";
import { getRivalsForUser, RIVAL_MIN_GAMES, type RivalryEntry } from "../economy/rivalries.js";

function backRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
}

function formatRecord(r: RivalryEntry): string {
  const pdSign = r.pointDiff >= 0 ? `+${r.pointDiff}` : `${r.pointDiff}`;
  return `**${r.wins}-${r.losses}** (${pdSign} PD)`;
}

function formatEntry(idx: number, r: RivalryEntry): string {
  const handle = r.opponentName ? `${r.opponentName} (<@${r.opponentId}>)` : `<@${r.opponentId}>`;
  const team   = r.opponentTeam ? ` — *${r.opponentTeam}*` : "";
  const trash  = r.trashTalkBoost > 0 ? `  •  🔥 ${r.trashTalkBoost} trash-talk` : "";
  return [
    `**${idx}. ${handle}**${team}`,
    `   ${r.temperature}  •  Rating **${r.rating}**`,
    `   Series: ${r.games} games, ${formatRecord(r)}, avg margin ${r.avgMargin}${trash}`,
  ].join("\n");
}

export async function handleAcRivalries(interaction: ButtonInteraction): Promise<void> {
  const gid = interaction.guildId!;
  const rivals = await getRivalsForUser(gid, interaction.user.id, 4);

  const embed = new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle("⚔️ Your Rivalries")
    .setFooter({ text: `Opponents qualify after ${RIVAL_MIN_GAMES}+ all-time H2H games. Trash talk in the Press Conference boosts rating.` });

  if (rivals.length === 0) {
    embed.setDescription(
      `You don't have any rivals yet.\n\n` +
      `An opponent becomes a rival once you've played them **${RIVAL_MIN_GAMES}+ all-time games**. ` +
      `Close, frequent series rank highest — and trash talk in your **🎙️ Press Conference** adds a +1 boost per session.`,
    );
  } else {
    embed.setDescription(
      `Your top **${rivals.length}** rival${rivals.length === 1 ? "" : "s"} ` +
      `— the opponents you've battled most, weighted toward narrow-margin series and trash-talk history.\n\n` +
      `_Rivalry games pay a **20-coin bonus** to each side when they win, as long as the opponent is in their personal top-4._\n\n` +
      rivals.map((r, i) => formatEntry(i + 1, r)).join("\n\n"),
    );
  }

  // First call from menu uses .reply; subsequent navigation could use .update —
  // here we always reply since this is a leaf action.
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components: [backRow()] });
  } else {
    await interaction.reply({ ephemeral: true, embeds: [embed], components: [backRow()] });
  }
}
