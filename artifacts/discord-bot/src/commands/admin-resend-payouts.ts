import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  pendingChannelPayoutsTable, usersTable, franchiseScheduleTable,
} from "@workspace/db";
import { and, eq, isNull, inArray, or, count } from "drizzle-orm";
import { getOrCreateActiveSeason, addBalance, logTransaction } from "../lib/db-helpers.js";

const STREAM_CHANNEL_ID    = "1486369417309978644";
const HIGHLIGHTS_CHANNEL_ID = "1485643704206229638";
const TWITCH_URL_RE        = /https?:\/\/(?:[\w-]+\.)?twitch\.tv\/\S+/i;
const STREAM_PAYOUT        = 10;
const HIGHLIGHT_PAYOUT     = 20;
const SCAN_LIMIT           = 10; // messages to fetch from each channel
const QUALIFY_LIMIT        = 4;  // max qualifying posts to act on

export const data = new SlashCommandBuilder()
  .setName("admin-resend-payouts")
  .setDescription("Scan stream/highlight channels for missed payouts and issue them automatically")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o
    .setName("type")
    .setDescription("Which payout type to recover (default: both)")
    .setRequired(false)
    .addChoices(
      { name: "Streams only",    value: "stream"    },
      { name: "Highlights only", value: "highlight" },
      { name: "Both",            value: "both"      },
    ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const typeFilter   = interaction.options.getString("type") ?? "both";
  const doStreams    = typeFilter !== "highlight";
  const doHighlights = typeFilter !== "stream";

  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";
  const botId       = interaction.client.user!.id;

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
  const commChannel   = commChannelId
    ? await interaction.client.channels.fetch(commChannelId).catch(() => null)
    : null;

  const lines: string[] = [];
  let orphansSent = 0;
  let autoPaid    = 0;

  // ── Part 1: Re-send orphaned pending records ────────────────────────────────
  // These are pending records with no commMessageId — the DB row exists but the
  // commissioner message was never delivered.  Route them through normal approval.

  if (commChannel?.isTextBased()) {
    const types: ("stream" | "highlight")[] = doStreams && doHighlights
      ? ["stream", "highlight"]
      : doStreams ? ["stream"] : ["highlight"];

    const orphans = await db
      .select()
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        inArray(pendingChannelPayoutsTable.type, types),
        inArray(pendingChannelPayoutsTable.status, ["pending"]),
        isNull(pendingChannelPayoutsTable.commMessageId),
      ));

    for (const payout of orphans) {
      try {
        const [userRow] = await db
          .select({ team: usersTable.team })
          .from(usersTable)
          .where(eq(usersTable.discordId, payout.discordId))
          .limit(1);
        const team = userRow?.team ?? null;

        if (payout.type === "stream") {
          const isH2H      = !!payout.opponentDiscordId;
          const payoutDesc = isH2H
            ? `+${payout.amount} coins → <@${payout.discordId}>\n+${payout.opponentAmount ?? payout.amount} coins → <@${payout.opponentDiscordId}> (H2H opponent)`
            : `+${payout.amount} coins → <@${payout.discordId}> (CPU game — opponent not awarded)`;

          const embed = new EmbedBuilder()
            .setColor(Colors.Purple)
            .setTitle("🎮 Stream Payout — Approval Required")
            .setDescription(
              `<@${payout.discordId}>${team ? ` (${team})` : ""} posted a Twitch stream.\n\n` +
              `**Payout:**\n${payoutDesc}\n\n` +
              `⚠️ *This message was re-sent by admin — original delivery failed.*`,
            )
            .setFooter({ text: `Payout #${payout.id} • Week ${payout.week}` })
            .setTimestamp();

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`stream_approve:${payout.id}`).setLabel("✅ Approve & Pay Out").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`stream_deny:${payout.id}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
          );

          const msg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });
          await db.update(pendingChannelPayoutsTable)
            .set({ commMessageId: msg.id })
            .where(eq(pendingChannelPayoutsTable.id, payout.id));
          orphansSent++;

        } else if (payout.type === "highlight") {
          const embed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle("🎬 Highlight Payout — Approval Required")
            .setDescription(
              `<@${payout.discordId}>${team ? ` (${team})` : ""} posted a highlight video.\n\n` +
              `**Payout:** +${payout.amount} coins → <@${payout.discordId}>\n\n` +
              `⚠️ *This message was re-sent by admin — original delivery failed.*`,
            )
            .setFooter({ text: `Payout #${payout.id} • Week ${payout.week}` })
            .setTimestamp();

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`highlight_approve:${payout.id}`).setLabel("✅ Approve & Pay Out").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`highlight_deny:${payout.id}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
          );

          const msg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });
          await db.update(pendingChannelPayoutsTable)
            .set({ commMessageId: msg.id })
            .where(eq(pendingChannelPayoutsTable.id, payout.id));
          orphansSent++;
        }
      } catch (err) {
        console.error(`[admin-resend-payouts] Orphan re-send failed for payout #${payout.id}:`, err);
        lines.push(`❌ Failed to re-send orphan payout #${payout.id} (<@${payout.discordId}>)`);
      }
    }

    if (orphansSent > 0) {
      lines.push(`📨 Re-sent **${orphansSent}** orphaned payout(s) to the commissioner log for approval.`);
    }
  } else if (commChannelId) {
    lines.push("⚠️ Cannot reach commissioner channel — orphan re-send skipped.");
  }

  // ── Part 2: Channel scan — auto-pay posts that slipped through entirely ──────
  // Look at the most recent qualifying posts in each channel. If the bot hasn't
  // reacted ✅ to a post AND there is no pending/approved DB record for it,
  // issue the payout directly and react ✅ so it's marked as handled.

  if (doStreams) {
    try {
      const streamCh = await interaction.client.channels.fetch(STREAM_CHANNEL_ID).catch(() => null);
      if (!streamCh?.isTextBased()) {
        lines.push("⚠️ Cannot reach stream channel — check that the bot is in the guild and the channel ID is correct.");
      } else {
        let fetched;
        try {
          fetched = await (streamCh as TextChannel).messages.fetch({ limit: SCAN_LIMIT });
        } catch (fetchErr: any) {
          const code = fetchErr?.code ?? fetchErr?.status;
          if (code === 50013 || code === 50001 || fetchErr?.message?.includes("Missing")) {
            lines.push("⚠️ Stream channel scan skipped — bot is missing **Read Message History** permission in that channel. Grant it in Discord → Channel Settings → Permissions.");
          } else {
            lines.push(`⚠️ Stream channel scan skipped — could not fetch messages: ${fetchErr?.message ?? String(fetchErr)}`);
          }
          fetched = null;
        }

        if (fetched) {
        const qualifying = [...fetched.values()]
          .filter(m => !m.author.bot && TWITCH_URL_RE.test(m.content))
          .slice(0, QUALIFY_LIMIT);

        for (const msg of qualifying) {
          // ✅ bot reaction means already approved — skip
          const checkReaction = msg.reactions.cache.get("✅");
          if (checkReaction?.me) continue;

          // Check DB for any existing record tied to this specific message
          const [existing] = await db
            .select({ id: pendingChannelPayoutsTable.id, status: pendingChannelPayoutsTable.status, commMessageId: pendingChannelPayoutsTable.commMessageId })
            .from(pendingChannelPayoutsTable)
            .where(eq(pendingChannelPayoutsTable.messageId, msg.id))
            .limit(1);

          if (existing) {
            // Approved (commMessage was sent and processed) → skip
            if (existing.status === "approved") continue;
            // Pending with a commissioner message already in flight → skip
            if (existing.commMessageId) continue;
            // Orphaned pending record — delete it so we can auto-pay fresh
            await db.delete(pendingChannelPayoutsTable).where(eq(pendingChannelPayoutsTable.id, existing.id));
          }

          // Look up poster
          const [userRow] = await db
            .select({ team: usersTable.team })
            .from(usersTable)
            .where(eq(usersTable.discordId, msg.author.id))
            .limit(1);

          if (!userRow) {
            lines.push(`⚠️ Stream by <@${msg.author.id}> skipped — not registered in the league.`);
            continue;
          }

          // Find H2H opponent via schedule
          let opponentDiscordId: string | null = null;
          let opponentTeam: string | null = null;
          if (userRow.team) {
            const weekIndex = parseInt(currentWeek, 10) - 1;
            const [matchup] = await db
              .select({ homeTeamName: franchiseScheduleTable.homeTeamName, awayTeamName: franchiseScheduleTable.awayTeamName })
              .from(franchiseScheduleTable)
              .where(and(
                eq(franchiseScheduleTable.seasonId, season.id),
                eq(franchiseScheduleTable.weekIndex, weekIndex),
                or(
                  eq(franchiseScheduleTable.homeTeamName, userRow.team),
                  eq(franchiseScheduleTable.awayTeamName, userRow.team),
                ),
              ))
              .limit(1);

            if (matchup) {
              opponentTeam = matchup.homeTeamName === userRow.team ? matchup.awayTeamName : matchup.homeTeamName;
              const [oppRow] = await db
                .select({ discordId: usersTable.discordId })
                .from(usersTable)
                .where(eq(usersTable.team, opponentTeam!))
                .limit(1);
              opponentDiscordId = oppRow?.discordId ?? null;
            }
          }

          // Credit coins
          await addBalance(msg.author.id, STREAM_PAYOUT);
          await logTransaction(msg.author.id, STREAM_PAYOUT, "addcoins",
            `Stream payout — Week ${currentWeek} (auto-recovered by admin)`, interaction.user.id);

          if (opponentDiscordId) {
            await addBalance(opponentDiscordId, STREAM_PAYOUT);
            await logTransaction(opponentDiscordId, STREAM_PAYOUT, "addcoins",
              `Stream payout (opponent) — Week ${currentWeek} (auto-recovered by admin)`, interaction.user.id);
          }

          // Insert an approved record so this message is never double-processed
          await db.insert(pendingChannelPayoutsTable).values({
            type:              "stream",
            discordId:         msg.author.id,
            amount:            STREAM_PAYOUT,
            opponentDiscordId: opponentDiscordId ?? undefined,
            opponentAmount:    opponentDiscordId ? STREAM_PAYOUT : undefined,
            opponentTeam:      opponentTeam ?? undefined,
            channelId:         msg.channelId,
            messageId:         msg.id,
            guildId:           msg.guildId!,
            seasonId:          season.id,
            week:              currentWeek,
            status:            "approved",
            resolvedBy:        interaction.user.id,
            resolvedAt:        new Date(),
          });

          // React ✅ to the original post
          await msg.react("✅").catch(() => {});

          const isH2H = !!opponentDiscordId;
          lines.push(
            `✅ Stream auto-paid: <@${msg.author.id}> +${STREAM_PAYOUT}c` +
            (isH2H ? ` | <@${opponentDiscordId}> +${STREAM_PAYOUT}c (H2H)` : " (CPU — opponent not awarded)"),
          );
          autoPaid++;
        }

        if (qualifying.length === 0) {
          lines.push("📺 Stream channel: no qualifying Twitch posts found in the last 10 messages.");
        } else if (autoPaid === 0 && orphansSent === 0) {
          lines.push("📺 Stream channel: all recent Twitch posts already have ✅ reactions — nothing missed.");
        }
        } // end if (fetched)
      }
    } catch (err: any) {
      console.error("[admin-resend-payouts] Stream scan error:", err);
      lines.push(`❌ Error scanning stream channel: ${err?.message ?? String(err)}`);
    }
  }

  if (doHighlights) {
    try {
      const hlCh = await interaction.client.channels.fetch(HIGHLIGHTS_CHANNEL_ID).catch(() => null);
      if (!hlCh?.isTextBased()) {
        lines.push("⚠️ Cannot reach highlights channel — check that the bot is in the guild and the channel ID is correct.");
      } else {
        let hlFetched;
        try {
          hlFetched = await (hlCh as TextChannel).messages.fetch({ limit: SCAN_LIMIT });
        } catch (fetchErr: any) {
          const code = fetchErr?.code ?? fetchErr?.status;
          if (code === 50013 || code === 50001 || fetchErr?.message?.includes("Missing")) {
            lines.push("⚠️ Highlight channel scan skipped — bot is missing **Read Message History** permission in that channel. Grant it in Discord → Channel Settings → Permissions.");
          } else {
            lines.push(`⚠️ Highlight channel scan skipped — could not fetch messages: ${fetchErr?.message ?? String(fetchErr)}`);
          }
          hlFetched = null;
        }

        if (hlFetched) {
        const qualifying = [...hlFetched.values()]
          .filter(m => !m.author.bot && [...m.attachments.values()].some(a => a.contentType?.startsWith("video/")))
          .slice(0, QUALIFY_LIMIT);

        let hlAutoPaid = 0;

        for (const msg of qualifying) {
          const checkReaction = msg.reactions.cache.get("✅");
          if (checkReaction?.me) continue;

          // Check how many approved records exist for this user this week
          // (highlights allow up to 2 per week)
          const existingForMsg = await db
            .select({ id: pendingChannelPayoutsTable.id, status: pendingChannelPayoutsTable.status, commMessageId: pendingChannelPayoutsTable.commMessageId })
            .from(pendingChannelPayoutsTable)
            .where(eq(pendingChannelPayoutsTable.messageId, msg.id));

          // If any record for this message is approved, skip
          if (existingForMsg.some(r => r.status === "approved")) continue;
          // If a pending record with a comm message is in flight, skip
          if (existingForMsg.some(r => r.commMessageId)) continue;

          // Delete any orphaned pending records for this message
          const orphanIds = existingForMsg.filter(r => !r.commMessageId).map(r => r.id);
          for (const id of orphanIds) {
            await db.delete(pendingChannelPayoutsTable).where(eq(pendingChannelPayoutsTable.id, id));
          }

          // Check weekly cap: how many approved highlight payouts does this user already have this week?
          const [capRow] = await db
            .select({ total: count() })
            .from(pendingChannelPayoutsTable)
            .where(and(
              eq(pendingChannelPayoutsTable.type, "highlight"),
              eq(pendingChannelPayoutsTable.discordId, msg.author.id),
              eq(pendingChannelPayoutsTable.seasonId, season.id),
              eq(pendingChannelPayoutsTable.week, currentWeek),
              eq(pendingChannelPayoutsTable.status, "approved"),
            ));

          const usedSlots = Number(capRow?.total ?? 0);
          if (usedSlots >= 2) {
            lines.push(`⚠️ Highlight by <@${msg.author.id}> skipped — already at 2/week cap.`);
            continue;
          }

          // Look up poster
          const [userRow] = await db
            .select({ team: usersTable.team })
            .from(usersTable)
            .where(eq(usersTable.discordId, msg.author.id))
            .limit(1);

          if (!userRow) {
            lines.push(`⚠️ Highlight by <@${msg.author.id}> skipped — not registered in the league.`);
            continue;
          }

          // Credit coins
          await addBalance(msg.author.id, HIGHLIGHT_PAYOUT);
          await logTransaction(msg.author.id, HIGHLIGHT_PAYOUT, "addcoins",
            `Highlight payout — Week ${currentWeek} (auto-recovered by admin)`, interaction.user.id);

          // Insert approved record
          await db.insert(pendingChannelPayoutsTable).values({
            type:      "highlight",
            discordId: msg.author.id,
            amount:    HIGHLIGHT_PAYOUT,
            channelId: msg.channelId,
            messageId: msg.id,
            guildId:   msg.guildId!,
            seasonId:  season.id,
            week:      currentWeek,
            status:    "approved",
            resolvedBy: interaction.user.id,
            resolvedAt: new Date(),
          });

          await msg.react("✅").catch(() => {});

          lines.push(`✅ Highlight auto-paid: <@${msg.author.id}> +${HIGHLIGHT_PAYOUT}c`);
          autoPaid++;
          hlAutoPaid++;
        }

        if (qualifying.length === 0) {
          lines.push("🎬 Highlight channel: no video posts found in the last 10 messages.");
        } else if (hlAutoPaid === 0 && orphansSent === 0) {
          lines.push("🎬 Highlight channel: all recent video posts already have ✅ reactions — nothing missed.");
        }
        } // end if (hlFetched)
      }
    } catch (err: any) {
      console.error("[admin-resend-payouts] Highlight scan error:", err);
      lines.push(`❌ Error scanning highlight channel: ${err?.message ?? String(err)}`);
    }
  }

  if (lines.length === 0) {
    lines.push("✅ Everything looks clean — no missed payouts found.");
  } else {
    lines.unshift(`**Recovery summary** — Week ${currentWeek}:`);
    if (orphansSent > 0 || autoPaid > 0) {
      lines.push(`\n**Total auto-paid:** ${autoPaid} | **Sent to commissioner:** ${orphansSent}`);
    }
  }

  await interaction.editReply(lines.join("\n"));
}
