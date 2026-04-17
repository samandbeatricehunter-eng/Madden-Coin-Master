/**
 * All custom-player-purchase interaction handlers (ccp_* prefixed).
 * Routed from interactionCreate.ts.
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
  EmbedBuilder, Colors, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  customArchetypesTable, customPlayersTable, usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  getSession, purgeExpiredSessions,
  customPlayerSessions,
  pointsUsed, pointCostForRaise,
  type CustomPlayerSession,
} from "./custom-player-session.js";
import {
  getSettings, packagePoints, packageCost, packageLabel,
  archetypeSelectRow, devTraitSelectRow, packageSelectRow,
  buildAttrRows, attrAllocEmbed, attrSelectPageCount,
  heightOptions, weightOptions, inchesToDisplay,
  buildCommissionerEmbed, buildCommissionerRows, buildAttrEmbeds,
  olSubPositionSelectRow, positionSelectRow,
  KP_POSITIONS, DEV_TRAIT_COST, DEV_TRAIT_LABEL,
  buildArchetypeNavRows, buildAttrPageNavRow, attrPageCount, formatArchetypeEmbed,
  THROWING_MOTIONS, throwingMotionStyleRow,
} from "./custom-player-helpers.js";
import { addBalance, logTransaction, getOrCreateUser, getGuildChannel, CHANNEL_KEYS } from "./db-helpers.js";

// ── Expired session helper ─────────────────────────────────────────────────────
async function sessionExpired(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  await interaction.reply({
    content: "⏰ Your session expired (30-min limit). Run `/purchasecustomplayer` to start over.",
    ephemeral: true,
  });
}

// ── Pre-step: User confirmed draft-pick warning → show position select ────────
export async function handleCcpPreConfirm(interaction: ButtonInteraction, sessionId: string) {
  purgeExpiredSessions();
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  await interaction.deferUpdate();

  await interaction.editReply({
    content:
      "**🏈 Custom Player Builder — Step 1 of 9**\n\n" +
      "Select your player's position to get started:",
    embeds:     [],
    components: [positionSelectRow(sessionId)],
  });
}

// ── Shared: build the archetype browser message for the current session state ──
function archBrowserReply(session: CustomPlayerSession, sessionId: string) {
  const arch        = session.archetypeList[session.archetypePreviewIdx]!;
  const attrPage    = session.archetypeAttrPage;
  const totalAttrs  = attrPageCount(arch.attributes);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (totalAttrs > 1) {
    components.push(buildAttrPageNavRow(sessionId, attrPage, totalAttrs));
  }
  components.push(...buildArchetypeNavRows(sessionId, session.archetypePreviewIdx, session.archetypeList.length));

  return {
    content:
      `**🏈 Custom Player Builder — Step 2 of 9**\n\n` +
      `Position: **${session.position}**\n\n` +
      `Use **Prev/Next Attrs** to page through all base attributes. Use **Prev/Next** to switch archetypes. Press **Choose This Archetype** when ready.`,
    embeds:     [formatArchetypeEmbed(session.position!, arch.name, arch.attributes, attrPage)],
    components,
  };
}

// ── Step 1: Position selected — show paged archetype browser ─────────────────
export async function handleCcpPos(interaction: StringSelectMenuInteraction, sessionId: string) {
  purgeExpiredSessions();
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const position = interaction.values[0]!;
  session.position = position;
  session.step = 2;

  await interaction.deferUpdate();

  const archs = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.position, position));
  const active = archs.filter(a => a.isActive);

  if (active.length === 0) {
    await interaction.editReply({
      content: `❌ No archetypes available for **${position}** yet. Check back soon!`,
      components: [], embeds: [],
    });
    return;
  }

  session.archetypeList        = active.map(a => ({
    id: a.id, name: a.name, attributes: a.attributes as Record<string, number>,
  }));
  session.archetypePreviewIdx  = 0;
  session.archetypeAttrPage    = 0;

  await interaction.editReply(archBrowserReply(session, sessionId));
}

// ── Step 2: Archetype navigation — Prev ───────────────────────────────────────
export async function handleCcpArchPrev(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  if (session.archetypePreviewIdx <= 0) return;
  session.archetypePreviewIdx--;
  session.archetypeAttrPage = 0;
  await interaction.editReply(archBrowserReply(session, sessionId));
}

// ── Step 2: Archetype navigation — Next ───────────────────────────────────────
export async function handleCcpArchNext(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  if (session.archetypePreviewIdx >= session.archetypeList.length - 1) return;
  session.archetypePreviewIdx++;
  session.archetypeAttrPage = 0;
  await interaction.editReply(archBrowserReply(session, sessionId));
}

// ── Step 2: Attribute page — Prev ─────────────────────────────────────────────
export async function handleCcpAttrPagePrev(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  if (session.archetypeAttrPage <= 0) return;
  session.archetypeAttrPage--;
  await interaction.editReply(archBrowserReply(session, sessionId));
}

// ── Step 2: Attribute page — Next ─────────────────────────────────────────────
export async function handleCcpAttrPageNext(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  const arch = session.archetypeList[session.archetypePreviewIdx];
  if (!arch) return;
  if (session.archetypeAttrPage >= attrPageCount(arch.attributes) - 1) return;
  session.archetypeAttrPage++;
  await interaction.editReply(archBrowserReply(session, sessionId));
}

// ── Helper: show the appearance (head #) modal directly from a component interaction ──
// Works for both ButtonInteraction and StringSelectMenuInteraction (no deferUpdate needed).
async function showAppearanceModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sessionId: string,
) {
  const modal = new ModalBuilder()
    .setCustomId(`ccp_appearance_modal:${sessionId}`)
    .setTitle("Player Appearance");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("headNumber")
        .setLabel("Head # (enter a number or type 'any')")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4)
        .setPlaceholder("e.g. 42 or any"),
    ),
  );

  await interaction.showModal(modal);
}

// ── Step 2: Archetype selected — commit and advance ───────────────────────────
export async function handleCcpArchPick(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const arch = session.archetypeList[session.archetypePreviewIdx];
  if (!arch) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: "❌ No archetype selected — go back and try again.", components: [], embeds: [] });
    return;
  }

  session.archetypeId    = arch.id;
  session.archetypeName  = arch.name;
  session.attributes     = { ...arch.attributes };
  session.attributeBases = { ...arch.attributes };
  session.attributeOrder = Object.keys(arch.attributes);

  // OL players must pick a specific sub-position (LT/LG/C/RG/RT) before continuing.
  // Then the OL sub-pos handler shows the appearance modal.
  if (session.position === "OL") {
    session.step = 2;
    await interaction.deferUpdate();
    await interaction.editReply({
      content:
        `**🏈 Custom Player Builder — Step 2 of 9**\n\n` +
        `Position: **OL** | Archetype: **${arch.name}**\n\n` +
        `Select your specific OL position:`,
      components: [olSubPositionSelectRow(sessionId)],
      embeds: [],
    });
    return;
  }

  // QB players choose throwing motion style first (then motion # + appearance in one modal).
  if (session.position === "QB") {
    session.step = 3;
    await interaction.deferUpdate();
    await interaction.editReply({
      content:
        `**🏈 Custom Player Builder — Step 3 of 9**\n\n` +
        `Position: **QB** | Archetype: **${arch.name}**\n\n` +
        `Select your throwing motion style:`,
      components: [throwingMotionStyleRow(sessionId)],
      embeds: [],
    });
    return;
  }

  // All other positions: show appearance modal directly.
  // The modal submit handler (handleCcpAppearanceModal) creates the next message.
  session.step = 3;
  await showAppearanceModal(interaction, sessionId);
}

// ── Legacy: old ccp_arch select-menu handler (kept for any in-flight sessions) ─
export async function handleCcpArch(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const archetypeId = parseInt(interaction.values[0]!, 10);

  const [arch] = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.id, archetypeId))
    .limit(1);

  if (!arch) {
    await interaction.deferUpdate();
    await interaction.editReply({ content: "❌ Archetype not found.", components: [] });
    return;
  }

  session.archetypeId    = arch.id;
  session.archetypeName  = arch.name;
  session.attributes     = { ...(arch.attributes as Record<string, number>) };
  session.attributeBases = { ...(arch.attributes as Record<string, number>) };
  session.attributeOrder = Object.keys(arch.attributes as Record<string, number>);

  if (session.position === "OL") {
    session.step = 2;
    await interaction.deferUpdate();
    await interaction.editReply({
      content: `**🏈 Custom Player Builder — Step 2 of 9**\n\nPosition: **OL** | Archetype: **${arch.name}**\n\nSelect your specific OL position:`,
      components: [olSubPositionSelectRow(sessionId)], embeds: [],
    });
    return;
  }
  if (session.position === "QB") {
    session.step = 3;
    await interaction.deferUpdate();
    await interaction.editReply({
      content: `**🏈 Custom Player Builder — Step 3 of 9**\n\nPosition: **QB** | Archetype: **${arch.name}**\n\nSelect your throwing motion style:`,
      components: [throwingMotionStyleRow(sessionId)], embeds: [],
    });
    return;
  }
  session.step = 3;
  await showAppearanceModal(interaction, sessionId);
}

// ── Step 2b (OL only): Specific OL position selected → appearance modal ───────
export async function handleCcpOlPos(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const olPosition = interaction.values[0]! as "LT" | "LG" | "C" | "RG" | "RT";
  session.position = olPosition;
  session.step = 3;

  // Show appearance modal — the modal submit handler continues to package select.
  await showAppearanceModal(interaction, sessionId);
}

// ── Step 3: Package selected ───────────────────────────────────────────────────
export async function handleCcpPkg(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  session.packageTier = interaction.values[0]! as any;
  session.step = 4;

  await interaction.deferUpdate();
  const settings = await getSettings();
  session.packagePoints = packagePoints(session.packageTier!, settings);

  await interaction.editReply({
    content:
      `**🏈 Custom Player Builder — Step 5 of 9**\n\n` +
      `Position: **${session.position}** | Archetype: **${session.archetypeName}**\n` +
      `Package: **${packageLabel(session.packageTier!)}** (${session.packagePoints} pts)\n\nSelect development trait:`,
    components: [devTraitSelectRow(sessionId)],
    embeds: [],
  });
}

// ── Step 4: Dev trait selected → balance check ────────────────────────────────
export async function handleCcpDev(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  session.devTrait = interaction.values[0]! as any;
  session.step = 5;

  await interaction.deferUpdate();

  // Package tier already set (kp auto-assigned for K/P, chosen for others)
  const settings = await getSettings();
  const pkgCost  = packageCost(session.packageTier!, settings);
  const devCost  = DEV_TRAIT_COST[session.devTrait!] ?? 0;
  session.totalCost = pkgCost + devCost;

  await showBalanceCheck(interaction, session, sessionId, settings);
}

async function showBalanceCheck(
  interaction: StringSelectMenuInteraction,
  session: CustomPlayerSession,
  sessionId: string,
  settings: any,
) {
  // Check balance
  const [uRow] = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, session.userId))
    .limit(1);
  const balance = uRow?.balance ?? 0;

  if (balance < session.totalCost) {
    await interaction.editReply({
      content:
        `❌ **Insufficient Balance!**\n\n` +
        `Required: **${session.totalCost} coins**\n` +
        `Your balance: **${balance} coins**\n\n` +
        `You need **${session.totalCost - balance} more coins** to proceed.\n` +
        `Run \`/balance\` to check your earnings.`,
      components: [],
      embeds: [],
    });
    return;
  }

  // Show attribute allocation
  session.step = 6;
  session.attrSelectPage = 0;
  session.selectedAttr = session.attributeOrder[0] ?? null;

  const embed = attrAllocEmbed(session);
  const rows  = buildAttrRows(session, sessionId);

  await interaction.editReply({
    content:
      `**🏈 Custom Player Builder — Step 6 of 9**\n\n` +
      `Balance: **${balance} coins** | Cost: **${session.totalCost} coins** | After purchase: **${balance - session.totalCost} coins**`,
    embeds:     [embed],
    components: rows,
  });
}

// ── Step 6: Attribute select ───────────────────────────────────────────────────
export async function handleCcpAttrSel(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  session.selectedAttr = interaction.values[0]!;
  await interaction.deferUpdate();

  const embed = attrAllocEmbed(session);
  const rows  = buildAttrRows(session, sessionId);
  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Step 6: Attribute selector page — Prev ────────────────────────────────────
export async function handleCcpAttrSelPrev(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  if ((session.attrSelectPage ?? 0) <= 0) return;
  session.attrSelectPage--;
  session.selectedAttr = null; // clear selection when page changes
  const embed = attrAllocEmbed(session);
  const rows  = buildAttrRows(session, sessionId);
  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Step 6: Attribute selector page — Next ────────────────────────────────────
export async function handleCcpAttrSelNext(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }
  await interaction.deferUpdate();
  if ((session.attrSelectPage ?? 0) >= attrSelectPageCount(session) - 1) return;
  session.attrSelectPage++;
  session.selectedAttr = null; // clear selection when page changes
  const embed = attrAllocEmbed(session);
  const rows  = buildAttrRows(session, sessionId);
  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Step 6: Attribute adjust buttons ──────────────────────────────────────────
export async function handleCcpAttrAdjust(
  interaction: ButtonInteraction,
  sessionId: string,
  delta: number,
) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const attr = session.selectedAttr;
  if (!attr) {
    await interaction.reply({ content: "⚠️ Select an attribute first.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const cur  = session.attributes[attr] ?? 0;
  const base = session.attributeBases[attr] ?? cur;
  const used = pointsUsed(session.attributes, session.attributeBases);
  const rem  = session.packagePoints - used;

  if (delta > 0) {
    // Apply increments one at a time to respect tier costs
    let remaining = rem;
    let newVal = cur;
    const steps = Math.abs(delta);
    for (let i = 0; i < steps; i++) {
      if (newVal >= 99) break;
      const cost = pointCostForRaise(newVal);
      if (remaining < cost) break;
      remaining -= cost;
      newVal++;
    }
    session.attributes[attr] = newVal;
  } else {
    // Decrement — no cost, just don't go below base
    const steps = Math.abs(delta);
    session.attributes[attr] = Math.max(base, cur - steps);
  }

  const embed = attrAllocEmbed(session);
  const rows  = buildAttrRows(session, sessionId);
  await interaction.editReply({ embeds: [embed], components: rows });
}

// ── Step 7: Submit attributes → open modal ─────────────────────────────────────
export async function handleCcpSubmitAttrs(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "⏰ Session expired.", ephemeral: true });
    return;
  }

  const used = pointsUsed(session.attributes, session.attributeBases);
  if (used > session.packagePoints) {
    await interaction.reply({ content: "❌ You've spent more points than your package allows.", ephemeral: true });
    return;
  }

  session.attrsLocked = true;
  session.step = 7;

  const modal = new ModalBuilder()
    .setCustomId(`ccp_modal:${sessionId}`)
    .setTitle("Player Details");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("firstName").setLabel("First Name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("lastName").setLabel("Last Name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("jerseyNumber").setLabel("Jersey Number (1–99)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("college").setLabel("College").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50),
    ),
  );

  await interaction.showModal(modal);
}

// ── Step 7 modal submitted → show dominant hand ────────────────────────────────
export async function handleCcpModal(interaction: ModalSubmitInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "⏰ Session expired.", ephemeral: true });
    return;
  }

  const firstName    = interaction.fields.getTextInputValue("firstName").trim();
  const lastName     = interaction.fields.getTextInputValue("lastName").trim();
  const jerseyRaw    = interaction.fields.getTextInputValue("jerseyNumber").trim();
  const college      = interaction.fields.getTextInputValue("college").trim();
  const jerseyNumber = parseInt(jerseyRaw, 10);

  if (isNaN(jerseyNumber) || jerseyNumber < 1 || jerseyNumber > 99) {
    await interaction.reply({ content: "❌ Jersey number must be between 1 and 99.", ephemeral: true });
    return;
  }

  session.firstName    = firstName;
  session.lastName     = lastName;
  session.jerseyNumber = jerseyNumber;
  session.college      = college;
  session.step         = 8;

  const handRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_hand:${sessionId}`)
      .setPlaceholder("Select dominant hand…")
      .addOptions([
        new StringSelectMenuOptionBuilder().setLabel("Right").setValue("right"),
        new StringSelectMenuOptionBuilder().setLabel("Left").setValue("left"),
      ]),
  );

  await interaction.reply({
    ephemeral: true,
    content:
      `**🏈 Custom Player Builder — Step 8 of 9**\n\n` +
      `Name: **${firstName} ${lastName}** | #${jerseyNumber} | ${college}\n\nSelect dominant hand:`,
    components: [handRow],
  });
}

// ── Step 8a: Hand selected → show height ─────────────────────────────────────
export async function handleCcpHand(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  session.dominantHand = interaction.values[0]! as "left" | "right";
  await interaction.deferUpdate();

  const opts = heightOptions(session.position!);
  const heightRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_height:${sessionId}`)
      .setPlaceholder("Select height…")
      .addOptions(opts.map(o => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value))),
  );

  await interaction.editReply({
    content:
      `**🏈 Custom Player Builder — Step 8 of 9**\n\n` +
      `Name: **${session.firstName} ${session.lastName}** | #${session.jerseyNumber} | ${session.college}\n` +
      `Hand: **${session.dominantHand === "left" ? "Left" : "Right"}**\n\nSelect height:`,
    components: [heightRow],
  });
}

// ── Step 8b: Height selected → show weight ───────────────────────────────────
export async function handleCcpHeight(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const totalInches = parseInt(interaction.values[0]!, 10);
  session.heightFt  = Math.floor(totalInches / 12);
  session.heightIn  = totalInches % 12;
  await interaction.deferUpdate();

  const opts = weightOptions(session.position!);
  const weightRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_weight:${sessionId}`)
      .setPlaceholder("Select weight…")
      .addOptions(opts.map(o => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value))),
  );

  await interaction.editReply({
    content:
      `**🏈 Custom Player Builder — Step 8 of 9**\n\n` +
      `Name: **${session.firstName} ${session.lastName}** | #${session.jerseyNumber} | ${session.college}\n` +
      `Hand: **${session.dominantHand === "left" ? "Left" : "Right"}** | Height: **${inchesToDisplay(totalInches)}**\n\nSelect weight:`,
    components: [weightRow],
  });
}

// ── Step 8c: Weight selected → show final summary + confirm ──────────────────
export async function handleCcpWeight(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  session.weightLbs = parseInt(interaction.values[0]!, 10);
  await interaction.deferUpdate();

  const heightStr = `${session.heightFt}'${session.heightIn}"`;
  const devLabel  = DEV_TRAIT_LABEL[session.devTrait!] ?? "Normal";

  // Only show attributes that were upgraded above base (keeps the field under 1024 chars)
  const upgradedLines = session.attributeOrder
    .filter(a => (session.attributes[a] ?? 0) > (session.attributeBases[a] ?? 0))
    .map(a => {
      const val  = session.attributes[a]!;
      const base = session.attributeBases[a]!;
      return `**${a}**: ${base} → **${val}**`;
    });
  const attrFieldValue = upgradedLines.length > 0 ? upgradedLines.join("  ·  ") : "No upgrades applied — base archetype stats";

  const summaryFields: { name: string; value: string; inline: boolean }[] = [
    { name: "Name",          value: `${session.firstName} ${session.lastName}`, inline: true },
    { name: "Position",      value: session.position!,    inline: true },
    { name: "Jersey #",      value: String(session.jerseyNumber ?? "?"), inline: true },
    { name: "Height",        value: heightStr,            inline: true },
    { name: "Weight",        value: `${session.weightLbs} lbs`, inline: true },
    { name: "College",       value: session.college!,     inline: true },
    { name: "Dominant Hand", value: session.dominantHand === "left" ? "Left" : "Right", inline: true },
    { name: "Package",       value: `${packageLabel(session.packageTier!)} (${session.packagePoints} pts)`, inline: true },
    { name: "Dev Trait",     value: devLabel,             inline: true },
    { name: "Archetype",     value: session.archetypeName!, inline: true },
    { name: "Total Cost",    value: `**${session.totalCost} coins**`, inline: true },
    { name: "\u200b",        value: "\u200b",             inline: true },
  ];

  if (session.throwingMotionStyle != null && session.throwingMotionNumber != null) {
    summaryFields.push({
      name:   "Throwing Motion",
      value:  `${session.throwingMotionStyle} #${session.throwingMotionNumber}`,
      inline: true,
    });
  }

  if (session.appearanceHead != null) {
    summaryFields.push({
      name:   "Appearance (Head #)",
      value:  session.appearanceHead === "any" ? "Any (random)" : `#${session.appearanceHead}`,
      inline: true,
    });
  }

  summaryFields.push({ name: "Attribute Upgrades", value: attrFieldValue.slice(0, 1020), inline: false });

  const summaryEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("📋 Review Your Custom Player — Step 9 of 9")
    .addFields(summaryFields)
    .setFooter({ text: "Review carefully — once submitted, coins are deducted immediately." });

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_confirm:${sessionId}`)
      .setLabel("✅ Confirm & Submit Player")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ccp_cancel:${sessionId}`)
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    content: "",
    embeds:  [summaryEmbed],
    components: [confirmRow],
  });
}

// ── Final confirm ──────────────────────────────────────────────────────────────
export async function handleCcpConfirm(interaction: ButtonInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "⏰ Session expired.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  // Guard: session already processed (prevents double-click or duplicate session confirm)
  if (session.submitted) {
    await interaction.editReply({
      content: "⚠️ This player has already been submitted — check your DMs or the commissioner log for confirmation.",
      embeds: [], components: [],
    });
    return;
  }

  // Mark submitted immediately before any async work — prevents race conditions
  // if Discord fires the interaction twice (double-click, network retry, etc.)
  session.submitted = true;

  // Final balance check
  const [uRow] = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, session.userId))
    .limit(1);
  const balance = uRow?.balance ?? 0;

  if (balance < session.totalCost) {
    // Unmark so the user can't be permanently locked out if they genuinely can't afford it
    session.submitted = false;
    await interaction.editReply({
      content: `❌ Insufficient balance. You need **${session.totalCost} coins** but only have **${balance}**.`,
      embeds: [], components: [],
    });
    return;
  }

  // Deduct coins
  if (session.totalCost > 0) {
    await addBalance(session.userId, -session.totalCost, interaction.guildId!);
    await logTransaction(
      session.userId, -session.totalCost, "purchase",
      `Custom player: ${session.firstName} ${session.lastName} (${session.position} / ${session.archetypeName})`,
      interaction.guildId!, "system",
    );
  }

  // Look up the owner's current team so the record is stamped with the franchise,
  // not the individual user — inventory follows the team across ownership changes.
  const [ownerRow] = await db
    .select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, session.userId), eq(usersTable.guildId, session.guildId)))
    .limit(1);
  const ownerTeam = ownerRow?.team ?? null;

  // Save to DB
  const [savedPlayer] = await db.insert(customPlayersTable).values({
    discordId:           session.userId,
    seasonId:            session.seasonId,
    teamName:            ownerTeam,
    position:            session.position!,
    archetypeName:       session.archetypeName!,
    devTrait:            session.devTrait ?? "normal",
    packageTier:         session.packageTier!,
    creationPoints:      session.packagePoints,
    firstName:           session.firstName!,
    lastName:            session.lastName!,
    jerseyNumber:        session.jerseyNumber!,
    college:             session.college!,
    dominantHand:        session.dominantHand ?? "right",
    heightFt:            session.heightFt!,
    heightIn:            session.heightIn!,
    weightLbs:           session.weightLbs!,
    attributes:          session.attributes,
    throwingMotionStyle:  session.throwingMotionStyle  ?? null,
    throwingMotionNumber: session.throwingMotionNumber ?? null,
    appearanceHead:       session.appearanceHead       ?? null,
    totalCost:           session.totalCost,
    status:              "pending",
  }).returning();

  const playerId = savedPlayer!.id;

  // Post to commissioner channel
  let commMsgId: string | undefined;
  let commChanId: string | undefined;
  try {
    const commId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER);
    const ch = commId ? await interaction.client.channels.fetch(commId).catch(() => null) : null;
    if (ch?.isTextBased()) {
      const tc        = ch as TextChannel;
      const commEmbed = buildCommissionerEmbed(playerId, session);
      const attrEmbeds = buildAttrEmbeds(session);
      const commRow   = buildCommissionerRows(playerId);
      const commMsg   = await tc.send({ embeds: [commEmbed, ...attrEmbeds], components: [commRow] });
      commMsgId = commMsg.id;
      commChanId = tc.id;
    }
  } catch (err) {
    console.error("[custom-player] Failed to post to commissioner channel:", err);
  }

  // Update DB with commissioner message info
  if (commMsgId) {
    await db.update(customPlayersTable)
      .set({ commissionerMessageId: commMsgId, commissionerChannelId: commChanId })
      .where(eq(customPlayersTable.id, playerId));
  }

  // Confirm to user
  const newBalance = balance - session.totalCost;
  const confirmEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Custom Player Submitted!")
    .setDescription(
      `**${session.firstName} ${session.lastName}** (${session.position} / ${session.archetypeName}) has been submitted for review.\n\n` +
      `A commissioner will apply your player to the draft class. You'll receive a DM when they've been added.`,
    )
    .addFields(
      { name: "Cost Paid",     value: `${session.totalCost} coins`, inline: true },
      { name: "New Balance",   value: `${newBalance} coins`,        inline: true },
      { name: "Player ID",     value: `#${playerId}`,               inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [confirmEmbed], components: [] });

  // Clean up session
  customPlayerSessions.delete(sessionId);
}

// ── QB Step 3: Throwing motion style selected → show combined QB details modal ─
// (motion number + appearance in one modal, since motion # range depends on style)
export async function handleCcpMotionStyle(interaction: StringSelectMenuInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) { await sessionExpired(interaction); return; }

  const style = interaction.values[0]!;
  const range = THROWING_MOTIONS[style];

  if (!range) {
    await interaction.reply({ content: "❌ Unknown throwing motion style. Please try again.", ephemeral: true });
    return;
  }

  session.throwingMotionStyle = style;

  const modal = new ModalBuilder()
    .setCustomId(`ccp_qb_details_modal:${sessionId}`)
    .setTitle("QB Details");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("motionNumber")
        .setLabel(`Motion # (${range.min}–${range.max} for ${style})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setPlaceholder(`Enter ${range.min}–${range.max}`),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("headNumber")
        .setLabel("Appearance — Head # or type 'any' for random")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4)
        .setPlaceholder("e.g. 42 or any"),
    ),
  );

  await interaction.showModal(modal);
}

// ── QB Step 4: QB details modal submitted → package select ────────────────────
export async function handleCcpQbDetailsModal(interaction: ModalSubmitInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "⏰ Session expired.", ephemeral: true });
    return;
  }

  const motionRaw = interaction.fields.getTextInputValue("motionNumber").trim();
  const headRaw   = interaction.fields.getTextInputValue("headNumber").trim();

  const style = session.throwingMotionStyle;
  const range = style ? THROWING_MOTIONS[style] : null;

  if (!range || !style) {
    await interaction.reply({ content: "❌ No throwing motion style recorded. Please start over with `/purchasecustomplayer`.", ephemeral: true });
    return;
  }

  const motionNum = parseInt(motionRaw, 10);
  if (isNaN(motionNum) || motionNum < range.min || motionNum > range.max) {
    await interaction.reply({
      content: `❌ Invalid motion number. **${style}** accepts **${range.min}–${range.max}**. You entered: \`${motionRaw}\``,
      ephemeral: true,
    });
    return;
  }

  const headLower = headRaw.toLowerCase().trim();
  const headNum   = parseInt(headRaw, 10);
  if (headLower !== "any" && (isNaN(headNum) || headNum < 0)) {
    await interaction.reply({ content: "❌ Head # must be a non-negative number, or type `any` for random.", ephemeral: true });
    return;
  }

  session.throwingMotionNumber = motionNum;
  session.appearanceHead = headLower === "any" ? "any" : String(headNum);
  session.step = 5;

  // QB can never be K/P — always show package select
  const settings = await getSettings();
  await interaction.reply({
    ephemeral: true,
    content:
      `**🏈 Custom Player Builder — Step 5 of 9**\n\n` +
      `Position: **QB** | Archetype: **${session.archetypeName}**\n` +
      `Throwing Motion: **${style} #${motionNum}** | Appearance: **Head #${session.appearanceHead}**\n\nSelect your creation package:`,
    components: [packageSelectRow(sessionId, settings)],
  });
}

// ── Step 3 (all non-QB): Appearance modal submitted → package or dev trait ────
export async function handleCcpAppearanceModal(interaction: ModalSubmitInteraction, sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.userId !== interaction.user.id) {
    await interaction.reply({ content: "⏰ Session expired.", ephemeral: true });
    return;
  }

  const headRaw   = interaction.fields.getTextInputValue("headNumber").trim();
  const headLower = headRaw.toLowerCase().trim();
  const headNum   = parseInt(headRaw, 10);

  if (headLower !== "any" && (isNaN(headNum) || headNum < 0)) {
    await interaction.reply({ content: "❌ Head # must be a non-negative number, or type `any` for random.", ephemeral: true });
    return;
  }

  session.appearanceHead = headLower === "any" ? "any" : String(headNum);
  session.step = 4;

  const settings = await getSettings();

  // K/P: auto-assign KP package, skip straight to dev trait
  if (KP_POSITIONS.has(session.position!)) {
    session.packageTier   = "kp";
    session.packagePoints = packagePoints("kp", settings);
    await interaction.reply({
      ephemeral: true,
      content:
        `**🏈 Custom Player Builder — Step 4 of 9**\n\n` +
        `Position: **${session.position}** | Archetype: **${session.archetypeName}**\n` +
        `Appearance: **Head #${session.appearanceHead}**\n\nSelect development trait:`,
      components: [devTraitSelectRow(sessionId)],
    });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    content:
      `**🏈 Custom Player Builder — Step 4 of 9**\n\n` +
      `Position: **${session.position}** | Archetype: **${session.archetypeName}**\n` +
      `Appearance: **Head #${session.appearanceHead}**\n\nSelect your creation package:`,
    components: [packageSelectRow(sessionId, settings)],
  });
}

// ── Cancel ─────────────────────────────────────────────────────────────────────
export async function handleCcpCancel(interaction: ButtonInteraction, sessionId: string) {
  const { customPlayerSessions } = await import("./custom-player-session.js");
  customPlayerSessions.delete(sessionId);
  await interaction.update({
    content: "❌ Purchase cancelled. Run `/purchasecustomplayer` to start again.",
    embeds: [], components: [],
  });
}

// ── Commissioner: Applied in Game ─────────────────────────────────────────────
export async function handleCcpApplied(interaction: ButtonInteraction, playerIdStr: string) {
  await interaction.deferUpdate();
  const playerId = parseInt(playerIdStr, 10);
  const [row] = await db.select().from(customPlayersTable).where(eq(customPlayersTable.id, playerId)).limit(1);
  if (!row) { await interaction.followUp({ content: "❌ Player not found.", ephemeral: true }); return; }
  if (row.status === "applied") { await interaction.followUp({ content: "⚠️ Already marked as applied.", ephemeral: true }); return; }

  await db.update(customPlayersTable)
    .set({ status: "applied", appliedAt: new Date() })
    .where(eq(customPlayersTable.id, playerId));

  // Update commissioner embed
  const newEmbed = EmbedBuilder.from(interaction.message.embeds[0]!)
    .setColor(Colors.Green)
    .setTitle("✅ Custom Player — Applied in Game");
  await interaction.editReply({
    embeds: [newEmbed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ccp_applied:${playerId}`).setLabel("✅ Applied").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`ccp_refund:${playerId}`).setLabel("💰 Refund").setStyle(ButtonStyle.Danger),
      ),
    ],
  });

  // DM the player
  try {
    const discordUser = await interaction.client.users.fetch(row.discordId);
    await discordUser.send(
      `✅ **Your custom player has been added to the draft class!**\n\n` +
      `**${row.firstName} ${row.lastName}** (${row.position}) has been applied in-game.\n\n` +
      `📋 **Reminder:** You will need to use a **draft pick** to select this player in the upcoming draft. ` +
      `Make sure you have a pick available when your round comes up.\n\n` +
      `⭐ Don't forget to **favorite the player** in-game so they appear at the top of your draft queue!`,
    ).catch(() => {});
  } catch (_) {}
}

// ── Commissioner: Refund (opens modal for reason) ─────────────────────────────
export async function handleCcpRefund(interaction: ButtonInteraction, playerIdStr: string) {
  const playerId = parseInt(playerIdStr, 10);
  const modal = new ModalBuilder()
    .setCustomId(`ccp_refund_modal:${playerIdStr}`)
    .setTitle("Refund Reason");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for refund")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(200),
    ),
  );
  await interaction.showModal(modal);
}

// ── Commissioner: Refund modal submitted ──────────────────────────────────────
export async function handleCcpRefundModal(interaction: ModalSubmitInteraction, playerIdStr: string) {
  await interaction.deferUpdate();
  const playerId = parseInt(playerIdStr, 10);
  const reason   = interaction.fields.getTextInputValue("reason").trim();

  const [row] = await db.select().from(customPlayersTable).where(eq(customPlayersTable.id, playerId)).limit(1);
  if (!row) { await interaction.followUp({ content: "❌ Player not found.", ephemeral: true }); return; }
  if (row.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.", ephemeral: true }); return; }

  // Refund coins
  if (row.totalCost > 0) {
    await addBalance(row.discordId, row.totalCost, interaction.guildId!);
    await logTransaction(
      row.discordId, row.totalCost, "addcoins",
      `Custom player refund (#${playerId}): ${reason}`,
      interaction.guildId!, interaction.user.id,
    );
  }

  await db.update(customPlayersTable)
    .set({ status: "refunded", refundedAt: new Date(), refundReason: reason })
    .where(eq(customPlayersTable.id, playerId));

  // Update commissioner embed
  const newEmbed = EmbedBuilder.from(interaction.message!.embeds[0]!)
    .setColor(Colors.Red)
    .setTitle("💰 Custom Player — Refunded")
    .addFields({ name: "Refund Reason", value: reason });
  await interaction.editReply({
    embeds: [newEmbed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ccp_applied:${playerId}`).setLabel("✅ Applied").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`ccp_refund:${playerId}`).setLabel("💰 Refunded").setStyle(ButtonStyle.Danger).setDisabled(true),
      ),
    ],
  });

  // DM the player
  try {
    const discordUser = await interaction.client.users.fetch(row.discordId);
    await discordUser.send(
      `💰 **Custom Player Refund**\n\n` +
      `Your custom player **${row.firstName} ${row.lastName}** (${row.position}) has been refunded.\n` +
      `**+${row.totalCost} coins** returned to your balance.\n` +
      `**Reason:** ${reason}`,
    ).catch(() => {});
  } catch (_) {}
}
