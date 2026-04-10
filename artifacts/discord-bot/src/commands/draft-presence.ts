import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";
import {
  getActiveSession, startDraftSession, populatePresence,
  postInitialMessages, refreshPresence, endDraftSession,
  togglePresence,
} from "../lib/draft-presence-manager.js";

export const data = new SlashCommandBuilder()
  .setName("draftpresence")
  .setDescription("Draft day presence tracker")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("start")
    .setDescription("Open the draft room and launch the presence tracker"),
  )
  .addSubcommand(sub => sub
    .setName("stop")
    .setDescription("Close the draft room and delete the channel"),
  )
  .addSubcommand(sub => sub
    .setName("refresh")
    .setDescription("Re-sync the user list (use if someone joined mid-draft)"),
  )
  .addSubcommand(sub => sub
    .setName("toggle")
    .setDescription("Admin: manually toggle any manager's presence status")
    .addUserOption(o => o
      .setName("user")
      .setDescription("The league member to toggle")
      .setRequired(true),
    ),
  );

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const discordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const dbAdmin      = await isAdminUser(interaction.user.id);
  return discordAdmin || dbAdmin;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!await checkAdmin(interaction)) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const sub     = interaction.options.getSubcommand();
  const guild   = interaction.guild;
  const guildId = interaction.guildId ?? "";

  // ── START ──────────────────────────────────────────────────────────────────
  if (sub === "start") {
    if (!guild) {
      await interaction.editReply({ content: "❌ This command must be used in a server." });
      return;
    }

    const existing = await getActiveSession(guildId);
    if (existing) {
      await interaction.editReply({
        content: `⚠️ A draft session is already active in <#${existing.channelId}>. Use \`/draftpresence stop\` first.`,
      });
      return;
    }

    try {
      const { sessionId, channel } = await startDraftSession(interaction.client, guildId, guild);
      await populatePresence(sessionId);

      // @everyone announcement
      await channel.send({
        content: "@everyone\n🏈 **Draft room is now open!** Use your button below to mark yourself away if needed.",
      });

      // Post status embed + per-user button panel
      await postInitialMessages(interaction.client, sessionId, channel);

      await interaction.editReply({
        content: `✅ Draft room created: <#${channel.id}>\nAll managers default to **Present**. They can toggle themselves away using their button.`,
      });
    } catch (err) {
      console.error("[draftpresence] Start error:", err);
      await interaction.editReply({ content: `❌ Failed to start draft session: ${err}` });
    }
    return;
  }

  // ── STOP ───────────────────────────────────────────────────────────────────
  if (sub === "stop") {
    const session = await getActiveSession(guildId);
    if (!session) {
      await interaction.editReply({ content: "⚠️ No active draft session found." });
      return;
    }

    await interaction.editReply({ content: "✅ Closing draft room… channel will be deleted in 10 seconds." });
    endDraftSession(interaction.client, session.id).catch(console.error);
    return;
  }

  // ── REFRESH ────────────────────────────────────────────────────────────────
  if (sub === "refresh") {
    const session = await getActiveSession(guildId);
    if (!session) {
      await interaction.editReply({ content: "⚠️ No active draft session found." });
      return;
    }

    await populatePresence(session.id);
    await refreshPresence(interaction.client, session.id);
    await interaction.editReply({ content: "✅ Presence list refreshed with the latest league roster." });
    return;
  }

  // ── TOGGLE (admin force-toggle) ────────────────────────────────────────────
  if (sub === "toggle") {
    const session = await getActiveSession(guildId);
    if (!session) {
      await interaction.editReply({ content: "⚠️ No active draft session found." });
      return;
    }

    const target    = interaction.options.getUser("user", true);
    const newStatus = await togglePresence(session.id, target.id);

    if (newStatus === null) {
      await interaction.editReply({ content: `⚠️ <@${target.id}> is not registered in the league.` });
      return;
    }

    await refreshPresence(interaction.client, session.id);
    await interaction.editReply({
      content: `✅ Toggled <@${target.id}> → **${newStatus ? "Present ✅" : "Away 🔴"}**`,
    });
    return;
  }
}
