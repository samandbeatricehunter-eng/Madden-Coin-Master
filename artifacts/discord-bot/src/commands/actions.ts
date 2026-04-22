import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} from "discord.js";
import { getServerSettings } from "../lib/server-settings.js";
import type { ServerSettings } from "../lib/server-settings.js";
import { isAdminUser, getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("menu")
  .setDescription("League menu — coins, wagers, rosters, standings, PR, and more in one place");

export function buildActionsHubEmbed(settings: ServerSettings, isAdmin: boolean): EmbedBuilder {
  const mcaVisible  = settings.mcaImportEnabled || isAdmin;
  const ecoVisible  = settings.coinEconomy;
  const wagerVisible = settings.coinEconomy && settings.wagerEnabled;

  const sections: string[] = [];

  const row1Items: string[] = [];
  if (ecoVisible)   row1Items.push("💳 Make a Purchase");
  if (wagerVisible) row1Items.push("⚔️ Place a Wager");
  if (ecoVisible)   row1Items.push("🪙 Coins");
  row1Items.push("🎙️ Interview", "🐦 Tweet");
  sections.push(`**Economy & Social**\n${row1Items.join(" · ")}`);

  if (mcaVisible) {
    sections.push("**Rosters & Schedule**\n📋 My Roster · 👥 Rosters · 📅 Schedule\n*(All Players, Free Agents, Player Cards & Team Stats accessible inside Rosters)*");
    sections.push("**League Info**\n📈 Standings *(In The Hunt & Teams to Watch inside Standings)*\n👤 Any User Stats");
  }

  const row4Items: string[] = ["🥇 Season PR", "🏆 All-Time PR", "🌐 Global PR"];
  if (ecoVisible) row4Items.push("💰 EOS Payouts", "🎯 Milestones");
  sections.push(`**Rankings & Payouts**\n${row4Items.join(" · ")}`);

  sections.push("**Requests**\n🟢 Active Teams · 🔴 Open Teams · ✈️ Auto-Pilot · 📜 Rules · 🚨 Report Violation");

  return new EmbedBuilder()
    .setColor(0x1a1a2e)
    .setTitle("🏈 /menu — League Menu")
    .setDescription(
      "Select any action below. All menus are private (visible only to you).\n\n" +
      sections.join("\n\n")
    )
    .setFooter({ text: "/menu — selections expire after 15 minutes" });
}

export function buildActionsHubRows(settings: ServerSettings, isAdmin: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const mcaVisible   = settings.mcaImportEnabled || isAdmin;
  const ecoVisible   = settings.coinEconomy;
  const wagerVisible = settings.coinEconomy && settings.wagerEnabled;

  // ── Row 1: Economy & Social ─────────────────────────────────────────────────
  const sec1: ButtonBuilder[] = [];
  if (ecoVisible)   sec1.push(new ButtonBuilder().setCustomId("ac_purchase").setLabel("💳 Purchase").setStyle(ButtonStyle.Secondary));
  if (wagerVisible) sec1.push(new ButtonBuilder().setCustomId("ac_wager").setLabel("⚔️ Wager").setStyle(ButtonStyle.Secondary));
  if (ecoVisible)   sec1.push(new ButtonBuilder().setCustomId("ac_coins").setLabel("🪙 Bank").setStyle(ButtonStyle.Secondary));
  sec1.push(
    new ButtonBuilder().setCustomId("ac_interview").setLabel("🎙️ Interview").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_tweet").setLabel("🐦 Tweet").setStyle(ButtonStyle.Secondary),
  );

  // ── Row 2: Roster, Schedule & League Info ───────────────────────────────────
  const sec2: ButtonBuilder[] = [];
  if (mcaVisible) {
    sec2.push(
      new ButtonBuilder().setCustomId("ac_schedule").setLabel("📅 Schedule").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_myroster").setLabel("📋 My Roster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_anyroster").setLabel("👥 Rosters").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_standings").setLabel("📈 Standings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_anyuserstats").setLabel("👤 Any User Stats").setStyle(ButtonStyle.Secondary),
    );
  }

  // ── Row 3: Power Rankings ───────────────────────────────────────────────────
  const sec3: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId("ac_seasonpr").setLabel("🥇 Season PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_alltimepr").setLabel("🏆 All-Time PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_globalpr").setLabel("🌐 Global PR").setStyle(ButtonStyle.Secondary),
  ];

  // ── Row 4: Payouts (economy only) ───────────────────────────────────────────
  const sec4: ButtonBuilder[] = [];
  if (ecoVisible) {
    sec4.push(
      new ButtonBuilder().setCustomId("ac_weeklypayouts").setLabel("📅 Weekly Payouts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_eospayouts").setLabel("💰 EOS Payouts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_milestonepayouts").setLabel("🎯 Milestones").setStyle(ButtonStyle.Secondary),
    );
  }

  // ── Row 5: Tools & Navigation ───────────────────────────────────────────────
  const sec5: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId("ac_myprofile").setLabel("👤 My Profile").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_autopilot").setLabel("✈️ Auto-Pilot").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_violation").setLabel("🚨 Report Violation").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close Menu").setStyle(ButtonStyle.Danger),
  ];

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const section of [sec1, sec2, sec3, sec4, sec5]) {
    if (section.length > 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...section));
    }
  }
  return rows;
}

export function buildUnlinkedHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("🏈 /menu — Welcome to the League")
    .setDescription(
      "You are not currently linked to a team. Use the buttons below to request one or browse league info.\n\n" +

      "**🔴🟢 Team Requests**\n" +
      "**Open Teams** — browse available franchises by division (AFC/NFC × East/North/South/West)\n" +
      "**User Teams** — see every user currently linked to a team\n" +
      "**Request Open Team** — submit a request for a specific open franchise\n" +
      "**Add / Remove Waitlist** — join or leave the commissioner's waitlist\n\n" +

      "**👥 Rosters**\n" +
      "Browse any team's full roster with player cards (bio · attributes · career stats)\n" +
      "Inside Rosters: **All Players** and **Free Agents** — filter by position, dev trait, and name, " +
      "then sort by up to **5 criteria** in priority order (OVR, age, height, weight, contract, " +
      "any offensive or defensive attribute, Kick Power/Accuracy/Return)\n\n" +

      "**📈 Standings**\n" +
      "Current season standings with **In The Hunt** and **Teams to Watch** breakdowns\n\n" +

      "**👤 User Stats**\n" +
      "View any user's season record, server all-time record, and global record — " +
      "including W/L, point differential, playoff record, and Super Bowl results\n\n" +

      "**🥇🏆🌐 Power Rankings**\n" +
      "Season PR · All-Time PR · Global PR\n\n" +

      "**📜 Rules**\n" +
      "Full league rulebook and scoring settings",
    )
    .setFooter({ text: "Contact a commissioner to get linked to a team · /menu expires after 15 min" });
}

export function buildUnlinkedHubRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_openteams").setLabel("🔴 Open Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_activeteams").setLabel("🟢 User Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_req_openteam").setLabel("📬 Request Team").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_req_addwaitlist").setLabel("📋 Add Waitlist").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_req_rmwaitlist").setLabel("❌ Leave Waitlist").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_anyroster").setLabel("👥 Rosters").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_standings").setLabel("📈 Standings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_anyuserstats").setLabel("👤 User Stats").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_seasonpr").setLabel("🥇 Season PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_alltimepr").setLabel("🏆 All-Time PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_globalpr").setLabel("🌐 Global PR").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  const [settings, member, user, season] = await Promise.all([
    getServerSettings(gid),
    interaction.guild?.members.fetch(uid).catch(() => null),
    getOrCreateUser(uid, interaction.user.username, gid),
    getOrCreateActiveSeason(gid),
  ]);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(uid, gid);
  const isAdmin        = isDiscordAdmin || isDbAdmin;

  // ── Unlinked user — show restricted hub ──────────────────────────────────────
  if (!user.team && !isAdmin) {
    await interaction.editReply({
      embeds:     [buildUnlinkedHubEmbed()],
      components: buildUnlinkedHubRows(),
    });
    return;
  }

  await interaction.editReply({
    embeds:     [buildActionsHubEmbed(settings, isAdmin)],
    components: buildActionsHubRows(settings, isAdmin),
  });
}
