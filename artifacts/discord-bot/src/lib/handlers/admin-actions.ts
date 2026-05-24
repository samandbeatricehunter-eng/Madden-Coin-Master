import { Client, Guild, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { usersTable, coinTransactionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export type AdminAction =
  | { type: "POST_WARNING";      targetDiscordId: string; channelId?: string | null; reason: string; ruleRef?: string | null; severity?: string | null; fineAmount?: number | null }
  | { type: "FINE_USER";         targetDiscordId: string; amount: number; reason: string; channelId?: string | null }
  | { type: "POST_ANNOUNCEMENT"; channelId?: string | null; text: string };

export interface AdminActionContext {
  client: Client;
  guild: Guild | null | undefined;
  actorId: string;
}

export async function resolveChannel(
  ctx: AdminActionContext,
  channelId: string | null | undefined,
): Promise<TextChannel | null> {
  if (channelId) {
    const ch = await ctx.client.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) return ch as TextChannel;
  }
  const fallback = ctx.guild?.channels.cache.find(
    c => c.isTextBased() && ["general", "general-chat", "general_chat"].includes(c.name.toLowerCase()),
  );
  return (fallback as TextChannel | undefined) ?? null;
}

export async function executeAdminAction(
  action: AdminAction,
  ctx: AdminActionContext,
): Promise<string> {
  try {
    if (action.type === "POST_WARNING" || action.type === "FINE_USER") {
      const targetId  = action.targetDiscordId;
      const member    = await ctx.guild?.members.fetch(targetId).catch(() => null);
      const [userRow] = await db.select({ team: usersTable.team, balance: usersTable.balance })
        .from(usersTable).where(eq(usersTable.discordId, targetId)).limit(1);

      const displayName = member?.displayName ?? `<@${targetId}>`;
      const teamLabel   = userRow?.team ? ` (${userRow.team})` : "";

      if (action.type === "POST_WARNING") {
        const targetChannel = await resolveChannel(ctx, action.channelId ?? null);
        if (!targetChannel) return "❌ Couldn't find a channel to post the warning in. Mention a channel explicitly next time.";

        const severityLabel = (action.severity ?? "warning").toLowerCase();
        const isCitation    = severityLabel === "citation";
        const hasFine       = (action.fineAmount ?? 0) > 0;

        const embed = new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle(isCitation ? "📋 Official League Citation" : "⚠️ Official League Warning")
          .addFields(
            { name: "Member",    value: `<@${targetId}>${teamLabel}`, inline: true },
            { name: "Severity",  value: severityLabel.charAt(0).toUpperCase() + severityLabel.slice(1), inline: true },
            { name: "Violation", value: action.reason },
          );

        if (action.ruleRef) embed.addFields({ name: "Rule Reference", value: action.ruleRef });
        if (hasFine) embed.addFields({ name: "Fine Issued", value: `${action.fineAmount!.toLocaleString()} coins deducted` });
        embed.setFooter({ text: "Issued by The R.E.C. League Commissioners" }).setTimestamp();

        await targetChannel.send({ content: `<@${targetId}>`, embeds: [embed] });

        if (hasFine) {
          const fine = action.fineAmount!;
          await db.transaction(async (tx) => {
            await tx.update(usersTable)
              .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${fine})`, updatedAt: new Date() })
              .where(eq(usersTable.discordId, targetId));
            await tx.insert(coinTransactionsTable).values({
              discordId:     targetId,
              amount:        -fine,
              type:          "removecoins",
              description:   `Commissioner fine: ${action.reason}`,
              relatedUserId: ctx.actorId,
            });
          });
          return `✅ Warning posted in <#${targetChannel.id}> and ${fine} coins deducted from ${displayName}.`;
        }

        return `✅ Warning posted in <#${targetChannel.id}> and ${displayName} has been notified.`;
      }

      if (action.type === "FINE_USER") {
        const fine = Math.abs(action.amount);
        await db.transaction(async (tx) => {
          await tx.update(usersTable)
            .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${fine})`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, targetId));
          await tx.insert(coinTransactionsTable).values({
            discordId:     targetId,
            amount:        -fine,
            type:          "removecoins",
            description:   `Commissioner fine: ${action.reason}`,
            relatedUserId: ctx.actorId,
          });
        });

        const targetChannel = action.channelId
          ? await resolveChannel(ctx, action.channelId) : null;

        if (targetChannel) {
          const embed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle("💸 Commissioner Fine")
            .addFields(
              { name: "Member", value: `<@${targetId}>${teamLabel}`, inline: true },
              { name: "Amount", value: `${fine.toLocaleString()} coins`,     inline: true },
              { name: "Reason", value: action.reason },
            )
            .setFooter({ text: "Issued by The R.E.C. League Commissioners" })
            .setTimestamp();
          await targetChannel.send({ content: `<@${targetId}>`, embeds: [embed] });
        }

        return `✅ ${fine.toLocaleString()} coins deducted from ${displayName}${targetChannel ? ` and posted in <#${targetChannel.id}>` : ""}.`;
      }
    }

    if (action.type === "POST_ANNOUNCEMENT") {
      const targetChannel = await resolveChannel(ctx, action.channelId ?? null);
      if (!targetChannel) return "❌ Couldn't find a channel to post in. Mention a channel explicitly.";
      await targetChannel.send(action.text);
      return `✅ Announcement posted in <#${targetChannel.id}>.`;
    }

    return "❌ Unknown action type — nothing was done.";
  } catch (err) {
    console.error("executeAdminAction error:", err);
    return "❌ Something went wrong executing that action. Check the bot logs.";
  }
}
