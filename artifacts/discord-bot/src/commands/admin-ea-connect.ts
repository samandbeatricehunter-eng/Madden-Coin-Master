import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from "discord.js";
import {
  EA_LOGIN_URL,
  exchangeCodeForToken,
  detectPersonas,
  getPersonaScopedTokens,
  getLeaguesFromToken,
  saveEAConnection,
  loadEAConnection,
  deleteEAConnection,
  pendingConnections,
  type EALeague,
  type TokenInfo,
} from "../lib/ea-client.js";

export const data = new SlashCommandBuilder()
  .setName("admin_ea_connect")
  .setDescription("Connect directly to EA's Madden API for automatic franchise data imports")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand((s) =>
    s
      .setName("start")
      .setDescription("Step 1: Get the EA login URL to begin the connection process"),
  )
  .addSubcommand((s) =>
    s
      .setName("code")
      .setDescription("Step 2: Paste the redirect URL after logging in to connect your league")
      .addStringOption((o) =>
        o
          .setName("redirect_url")
          .setDescription('The full redirect URL from EA (starts with http://127.0.0.1/success?code=)')
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("connect")
      .setDescription("Step 2b: If multiple leagues were found, pick one by ID")
      .addIntegerOption((o) =>
        o
          .setName("league_id")
          .setDescription("The EA league ID shown in the list")
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s.setName("status").setDescription("Show current EA connection status"),
  )
  .addSubcommand((s) =>
    s.setName("disconnect").setDescription("Remove the EA API connection (reverts to MCA mode)"),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "start")      return handleStart(interaction);
  if (sub === "code")       return handleCode(interaction);
  if (sub === "connect")    return handleConnect(interaction);
  if (sub === "status")     return handleStatus(interaction);
  if (sub === "disconnect") return handleDisconnect(interaction);
}

// ── /admin_ea_connect start ───────────────────────────────────────────────────
async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🔗 EA Direct Connect — Step 1")
    .setDescription(
      [
        "**Click the link below to log in to EA.** Use the EA account linked to the commissioner's Madden franchise.",
        "",
        `**[→ Login to EA](${EA_LOGIN_URL})**`,
        "",
        "After logging in, EA will redirect your browser to a page that **won't load** (it tries to go to `http://127.0.0.1/success?code=...`).",
        "",
        "**Copy the full URL from your browser's address bar** — it will look like:",
        "```http://127.0.0.1/success?code=QUOhAFs1kcSeHLr18Vv...```",
        "",
        "Then run:",
        "```/admin_ea_connect code redirect_url:<paste the full URL here>```",
        "",
        "⚠️ Each login URL can only be used **once**. If you need to retry, run `/admin_ea_connect start` again to get a fresh link.",
      ].join("\n"),
    )
    .setFooter({ text: "EA Direct Connect • Madden 26" });

  await interaction.editReply({ embeds: [embed] });
}

// ── /admin_ea_connect code ────────────────────────────────────────────────────
async function handleCode(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const redirectUrl = interaction.options.getString("redirect_url", true);

  try {
    // Step 1: exchange code for initial access token
    await interaction.editReply({ content: "⏳ Exchanging auth code with EA..." });
    const accessToken = await exchangeCodeForToken(redirectUrl);

    // Step 2: find Madden 26 personas
    await interaction.editReply({ content: "⏳ Looking up your EA personas and platform..." });
    const personas = await detectPersonas(accessToken);

    if (personas.length === 0) {
      await interaction.editReply({
        content:
          "❌ No Madden 26 personas found on this EA account. Make sure you're using the commissioner's EA account that owns Madden 26.",
      });
      return;
    }

    // Use the first valid persona (most leagues have exactly one)
    const persona = personas[0]!;

    // Step 3: get persona-scoped tokens (needed for Blaze/franchise access)
    await interaction.editReply({
      content: `⏳ Authorizing persona **${persona.personaId}** (${persona.platform.toUpperCase()})...`,
    });
    const scopedToken = await getPersonaScopedTokens(
      accessToken,
      persona.personaId,
      persona.namespace,
      persona.platform,
    );

    // Step 4: get leagues from Blaze
    await interaction.editReply({ content: "⏳ Fetching your Madden leagues from EA..." });
    const leagues = await getLeaguesFromToken(scopedToken);

    if (leagues.length === 0) {
      await interaction.editReply({
        content:
          "❌ No Madden 26 franchises found. Make sure the commissioner's team is in an active CFM league.",
      });
      return;
    }

    if (leagues.length === 1) {
      // Auto-connect the only league
      const league = leagues[0]!;
      await saveEAConnection({
        eaLeagueId:  league.leagueId,
        leagueName:  league.leagueName,
        token:       scopedToken,
        connectedBy: interaction.user.id,
      });

      const embed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ EA Direct Connect — Connected!")
        .addFields(
          { name: "League",    value: league.leagueName,         inline: true },
          { name: "League ID", value: String(league.leagueId),   inline: true },
          { name: "Platform",  value: scopedToken.platform.toUpperCase(), inline: true },
        )
        .setDescription(
          "Your franchise is now connected to the EA API directly.\n\n" +
          "Use `/admin_ea_export` to pull stats any time — no more MCA needed!",
        )
        .setFooter({ text: "Token auto-refreshes on each export" });

      await interaction.editReply({ content: "", embeds: [embed] });
      return;
    }

    // Multiple leagues — store pending and ask user to pick
    const userId = interaction.user.id;
    pendingConnections.set(userId, {
      personas,
      leagues,
      tokens: scopedToken,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10-minute TTL
    });

    const leagueList = leagues
      .map((l) => `• **${l.leagueName}** — ID: \`${l.leagueId}\` (your team: ${l.userTeamName})`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🏈 Multiple Leagues Found — Pick One")
      .setDescription(
        `Found **${leagues.length}** leagues. Run the command below with the correct league ID:\n\n` +
        leagueList +
        "\n\n```/admin_ea_connect connect league_id:<ID>```\n\n" +
        "⚠️ You have **10 minutes** to pick before the session expires.",
      );

    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (err: any) {
    console.error("[ea-connect/code] Error:", err);
    await interaction.editReply({
      content: `❌ Connection failed: ${err?.message ?? String(err)}\n\nTry running \`/admin_ea_connect start\` to get a new login link.`,
    });
  }
}

// ── /admin_ea_connect connect ─────────────────────────────────────────────────
async function handleConnect(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const userId   = interaction.user.id;
  const leagueId = interaction.options.getInteger("league_id", true);

  const pending = pendingConnections.get(userId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingConnections.delete(userId);
    await interaction.editReply({
      content:
        "❌ No pending session found or session expired. Please run `/admin_ea_connect code` again.",
    });
    return;
  }

  const league = pending.leagues.find((l) => l.leagueId === leagueId);
  if (!league) {
    const validIds = pending.leagues.map((l) => l.leagueId).join(", ");
    await interaction.editReply({
      content: `❌ League ID \`${leagueId}\` not found. Valid IDs: ${validIds}`,
    });
    return;
  }

  try {
    await saveEAConnection({
      eaLeagueId:  league.leagueId,
      leagueName:  league.leagueName,
      token:       pending.tokens,
      connectedBy: interaction.user.id,
    });
    pendingConnections.delete(userId);

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ EA Direct Connect — Connected!")
      .addFields(
        { name: "League",    value: league.leagueName,                      inline: true },
        { name: "League ID", value: String(league.leagueId),                inline: true },
        { name: "Platform",  value: pending.tokens.platform.toUpperCase(),  inline: true },
      )
      .setDescription(
        "Use `/admin_ea_export` to pull stats any time — no more MCA needed!",
      )
      .setFooter({ text: "Token auto-refreshes on each export" });

    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (err: any) {
    console.error("[ea-connect/connect] Error:", err);
    await interaction.editReply({ content: `❌ Failed to save connection: ${err?.message}` });
  }
}

// ── /admin_ea_connect status ──────────────────────────────────────────────────
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const conn = await loadEAConnection();
    if (!conn) {
      await interaction.editReply({
        content:
          "❌ **No EA connection.** The bot is using MCA manual imports.\n\nRun `/admin_ea_connect start` to set up a direct EA connection.",
      });
      return;
    }

    const { token, eaLeagueId, leagueName } = conn;
    const expiresIn = Math.max(0, Math.round((token.expiry.getTime() - Date.now()) / 60000));

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🔗 EA Direct Connect — Active")
      .addFields(
        { name: "League",       value: leagueName || "(unknown)",       inline: true },
        { name: "League ID",    value: String(eaLeagueId),              inline: true },
        { name: "Platform",     value: token.platform.toUpperCase(),    inline: true },
        { name: "Token Expiry", value: `${expiresIn} min (auto-refreshes on export)`, inline: false },
      )
      .setDescription(
        "✅ Bot is connected directly to EA. Use `/admin_ea_export` to pull franchise data.",
      )
      .setFooter({ text: `Blaze ID: ${token.blazeId}` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Error checking status: ${err?.message}` });
  }
}

// ── /admin_ea_connect disconnect ──────────────────────────────────────────────
async function handleDisconnect(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const conn = await loadEAConnection();
    if (!conn) {
      await interaction.editReply({ content: "No EA connection to remove." });
      return;
    }

    await deleteEAConnection();

    await interaction.editReply({
      content:
        "✅ EA connection removed. The bot will now rely on MCA manual imports again.\n\n" +
        "Run `/admin_ea_connect start` any time to reconnect.",
    });
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Error disconnecting: ${err?.message}` });
  }
}
