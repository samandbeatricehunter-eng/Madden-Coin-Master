import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, PermissionFlagsBits,
} from "discord.js";
import {
  isAdminUser, getOrSeedRules, setRules, getAllSections, createSection, DEFAULT_RULES,
} from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("adminrules")
  .setDescription("Add, edit, remove, or create sections in the league rulebook (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  // ── add ──────────────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("add")
    .setDescription("Append a new rule to a section")
    .addStringOption(o => o
      .setName("section")
      .setDescription("Which section to add the rule to?")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addStringOption(o => o
      .setName("text")
      .setDescription("The full text of the new rule")
      .setRequired(true)
      .setMaxLength(1500),
    ),
  )

  // ── set ───────────────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("set")
    .setDescription("Replace the text of an existing rule by its number")
    .addStringOption(o => o
      .setName("section")
      .setDescription("Which section contains the rule?")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addIntegerOption(o => o
      .setName("number")
      .setDescription("The rule number to replace (see /adminrules list)")
      .setRequired(true)
      .setMinValue(1),
    )
    .addStringOption(o => o
      .setName("text")
      .setDescription("The new text for this rule")
      .setRequired(true)
      .setMaxLength(1500),
    ),
  )

  // ── remove ────────────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Delete a rule from a section by its number (remaining rules re-number)")
    .addStringOption(o => o
      .setName("section")
      .setDescription("Which section contains the rule?")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addIntegerOption(o => o
      .setName("number")
      .setDescription("The rule number to delete")
      .setRequired(true)
      .setMinValue(1),
    ),
  )

  // ── list ──────────────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("list")
    .setDescription("Show all rules in a section with their numbers (admin view)")
    .addStringOption(o => o
      .setName("section")
      .setDescription("Which section to list?")
      .setRequired(true)
      .setAutocomplete(true),
    ),
  )

  // ── reset ─────────────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("reset")
    .setDescription("Reset a section to its built-in defaults, or clear a custom section entirely")
    .addStringOption(o => o
      .setName("section")
      .setDescription("Which section to reset?")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addBooleanOption(o => o
      .setName("confirm")
      .setDescription("Must be True to proceed — this overwrites all current rules in the section")
      .setRequired(true),
    ),
  )

  // ── new-section ───────────────────────────────────────────────────────────────
  .addSubcommand(sub => sub
    .setName("new-section")
    .setDescription("Create a new custom rules section")
    .addStringOption(o => o
      .setName("key")
      .setDescription("Short identifier for the section (lowercase, no spaces — e.g. 'playoffs')")
      .setRequired(true)
      .setMaxLength(40),
    )
    .addStringOption(o => o
      .setName("title")
      .setDescription("Display title shown in /rules (e.g. '🏆 Playoff Rules')")
      .setRequired(true)
      .setMaxLength(80),
    ),
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const allSections = await getAllSections(interaction.guildId!).catch(() => ({}));
  const choices = Object.entries(allSections)
    .map(([key, meta]) => ({ name: meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim(), value: key }))
    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices);
}

// ── Execute ───────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const sub = interaction.options.getSubcommand();

  const isAdmin = await isAdminUser(interaction.user.id, guildId);
  const isDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  if (!isAdmin && !isDiscordAdmin) {
    await interaction.reply({ content: "❌ Commissioner access required.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // ── list ────────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const section = interaction.options.getString("section", true);
      const allSections = await getAllSections(guildId);
      const meta = allSections[section];
      if (!meta) {
        await interaction.editReply("❌ Unknown section. Use autocomplete to pick a valid one.");
        return;
      }
      const rules = await getOrSeedRules(section, guildId);
      if (!rules.length) {
        await interaction.editReply(`📋 **${meta.title}** has no rules yet. Use \`/adminrules add\` to add the first one.`);
        return;
      }
      const lines = rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n\n");
      const embed = new EmbedBuilder()
        .setColor(meta.color)
        .setTitle(`${meta.title} — ${rules.length} rule${rules.length === 1 ? "" : "s"}`)
        .setDescription(lines.length > 4000 ? lines.slice(0, 3990) + "…" : lines)
        .setFooter({ text: "Use /adminrules set [section] [#] to edit · /adminrules remove to delete" })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── add ─────────────────────────────────────────────────────────────────────
    if (sub === "add") {
      const section = interaction.options.getString("section", true);
      const text    = interaction.options.getString("text", true).trim();
      const allSections = await getAllSections(guildId);
      const meta = allSections[section];
      if (!meta) {
        await interaction.editReply("❌ Unknown section.");
        return;
      }
      const rules = await getOrSeedRules(section, guildId);
      rules.push(text);
      await setRules(section, rules, interaction.user.id, guildId);
      await interaction.editReply(
        `✅ Rule **#${rules.length}** added to **${meta.title}**:\n>>> ${text}`,
      );
      return;
    }

    // ── set ─────────────────────────────────────────────────────────────────────
    if (sub === "set") {
      const section = interaction.options.getString("section", true);
      const num     = interaction.options.getInteger("number", true);
      const text    = interaction.options.getString("text", true).trim();
      const allSections = await getAllSections(guildId);
      const meta = allSections[section];
      if (!meta) {
        await interaction.editReply("❌ Unknown section.");
        return;
      }
      const rules = await getOrSeedRules(section, guildId);
      if (num > rules.length) {
        await interaction.editReply(`❌ Rule #${num} doesn't exist. This section has **${rules.length}** rule(s).`);
        return;
      }
      const old = rules[num - 1];
      rules[num - 1] = text;
      await setRules(section, rules, interaction.user.id, guildId);
      await interaction.editReply(
        `✅ Rule **#${num}** in **${meta.title}** updated.\n\n**Was:** ${old}\n\n**Now:** ${text}`,
      );
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const section = interaction.options.getString("section", true);
      const num     = interaction.options.getInteger("number", true);
      const allSections = await getAllSections(guildId);
      const meta = allSections[section];
      if (!meta) {
        await interaction.editReply("❌ Unknown section.");
        return;
      }
      const rules = await getOrSeedRules(section, guildId);
      if (num > rules.length) {
        await interaction.editReply(`❌ Rule #${num} doesn't exist. This section has **${rules.length}** rule(s).`);
        return;
      }
      const [removed] = rules.splice(num - 1, 1);
      await setRules(section, rules, interaction.user.id, guildId);
      await interaction.editReply(
        `🗑️ Rule **#${num}** removed from **${meta.title}**. Remaining rules have been re-numbered.\n\n**Removed:** ${removed}`,
      );
      return;
    }

    // ── reset ────────────────────────────────────────────────────────────────────
    if (sub === "reset") {
      const section = interaction.options.getString("section", true);
      const confirm = interaction.options.getBoolean("confirm", true);
      if (!confirm) {
        await interaction.editReply("❌ Set `confirm: True` to proceed with the reset.");
        return;
      }
      const defaults = (DEFAULT_RULES as Record<string, string[]>)[section] ?? [];
      await setRules(section, defaults, interaction.user.id, guildId);
      if (defaults.length) {
        await interaction.editReply(
          `🔄 **${section}** has been reset to ${defaults.length} default rule(s). Members can view them with \`/rules ${section}\`.`,
        );
      } else {
        await interaction.editReply(
          `🗑️ **${section}** has been cleared (no built-in defaults exist for this section).`,
        );
      }
      return;
    }

    // ── new-section ──────────────────────────────────────────────────────────────
    if (sub === "new-section") {
      const rawKey  = interaction.options.getString("key", true).trim().toLowerCase().replace(/\s+/g, "_");
      const title   = interaction.options.getString("title", true).trim();
      const allSections = await getAllSections(guildId);
      if (allSections[rawKey]) {
        await interaction.editReply(`❌ A section with key \`${rawKey}\` already exists: **${allSections[rawKey]!.title}**`);
        return;
      }
      await createSection(rawKey, title, 0x3498db, guildId);
      await interaction.editReply(
        `✅ Section **${title}** created with key \`${rawKey}\`.\nUse \`/adminrules add ${rawKey}\` to start adding rules, and \`/rules ${rawKey}\` for members to view them.`,
      );
      return;
    }

    await interaction.editReply("❌ Unknown subcommand.");

  } catch (err) {
    console.error("[/adminrules] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`❌ Something went wrong: ${msg}`).catch(() => {});
  }
}
