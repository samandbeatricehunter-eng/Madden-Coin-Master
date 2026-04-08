import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ALL_POSITIONS, formatArchetypeEmbed } from "../lib/custom-player-helpers.js";

// ── Default archetypes seeded per position ────────────────────────────────────
// Attribute names match standard Madden labels.
// Commissioners can edit values with /admin-customarchetypes add (upsert).
const ARCHETYPE_DEFAULTS: Array<{ position: string; name: string; attributes: Record<string, number> }> = [
  // ── QB ──────────────────────────────────────────────────────────────────────
  { position: "QB", name: "Pocket Passer",
    attributes: { Speed: 72, Acceleration: 75, Agility: 75, Strength: 67, Awareness: 80,
                  ThrowPower: 83, ThrowShortAcc: 85, ThrowMedAcc: 82, ThrowDeepAcc: 79,
                  ThrowOnRun: 74, PlayAction: 76, BreakSack: 65 } },
  { position: "QB", name: "Scrambler",
    attributes: { Speed: 82, Acceleration: 84, Agility: 83, Strength: 72, Awareness: 75,
                  ThrowPower: 80, ThrowShortAcc: 79, ThrowMedAcc: 77, ThrowDeepAcc: 73,
                  ThrowOnRun: 82, PlayAction: 72, BreakSack: 74 } },
  { position: "QB", name: "Strong Arm",
    attributes: { Speed: 70, Acceleration: 73, Agility: 72, Strength: 68, Awareness: 77,
                  ThrowPower: 90, ThrowShortAcc: 79, ThrowMedAcc: 78, ThrowDeepAcc: 82,
                  ThrowOnRun: 72, PlayAction: 74, BreakSack: 65 } },
  { position: "QB", name: "Field General",
    attributes: { Speed: 72, Acceleration: 75, Agility: 74, Strength: 67, Awareness: 85,
                  ThrowPower: 82, ThrowShortAcc: 83, ThrowMedAcc: 83, ThrowDeepAcc: 77,
                  ThrowOnRun: 74, PlayAction: 79, BreakSack: 68 } },

  // ── HB ──────────────────────────────────────────────────────────────────────
  { position: "RB", name: "Power Back",
    attributes: { Speed: 79, Acceleration: 84, Agility: 81, Strength: 83, Awareness: 74,
                  Elusiveness: 76, BreakTackle: 84, Trucking: 86, Carrying: 85,
                  CatchInTraffic: 76, ShortRoute: 68, Catching: 72 } },
  { position: "RB", name: "Elusive Back",
    attributes: { Speed: 85, Acceleration: 90, Agility: 91, Strength: 72, Awareness: 76,
                  Elusiveness: 91, BreakTackle: 75, Trucking: 73, Carrying: 86,
                  CatchInTraffic: 75, ShortRoute: 72, Catching: 75 } },
  { position: "RB", name: "Speed Back",
    attributes: { Speed: 91, Acceleration: 91, Agility: 86, Strength: 70, Awareness: 74,
                  Elusiveness: 84, BreakTackle: 72, Trucking: 70, Carrying: 85,
                  CatchInTraffic: 73, ShortRoute: 72, Catching: 75 } },
  { position: "RB", name: "Receiving Back",
    attributes: { Speed: 83, Acceleration: 87, Agility: 86, Strength: 72, Awareness: 78,
                  Elusiveness: 82, BreakTackle: 73, Trucking: 72, Carrying: 84,
                  CatchInTraffic: 83, ShortRoute: 81, Catching: 84 } },

  // ── FB ──────────────────────────────────────────────────────────────────────
  { position: "FB", name: "Blocking",
    attributes: { Speed: 74, Acceleration: 79, Agility: 74, Strength: 87, Awareness: 78,
                  PassBlocking: 84, RunBlocking: 87, Catching: 68, Elusiveness: 68 } },
  { position: "FB", name: "Receiving",
    attributes: { Speed: 77, Acceleration: 82, Agility: 79, Strength: 78, Awareness: 78,
                  PassBlocking: 75, RunBlocking: 78, Catching: 82, Elusiveness: 76 } },

  // ── WR ──────────────────────────────────────────────────────────────────────
  { position: "WR", name: "Route Runner",
    attributes: { Speed: 87, Acceleration: 89, Agility: 88, Strength: 68, Awareness: 79,
                  Catching: 88, CatchInTraffic: 84, ShortRoute: 92, MedRoute: 89,
                  DeepRoute: 84, SpectacularCatch: 81, Release: 88 } },
  { position: "WR", name: "Deep Threat",
    attributes: { Speed: 94, Acceleration: 91, Agility: 84, Strength: 66, Awareness: 74,
                  Catching: 85, CatchInTraffic: 78, ShortRoute: 78, MedRoute: 80,
                  DeepRoute: 93, SpectacularCatch: 87, Release: 83 } },
  { position: "WR", name: "Slot",
    attributes: { Speed: 87, Acceleration: 90, Agility: 91, Strength: 65, Awareness: 78,
                  Catching: 86, CatchInTraffic: 82, ShortRoute: 90, MedRoute: 86,
                  DeepRoute: 78, SpectacularCatch: 79, Release: 84 } },
  { position: "WR", name: "Physical",
    attributes: { Speed: 84, Acceleration: 86, Agility: 82, Strength: 76, Awareness: 76,
                  Catching: 84, CatchInTraffic: 88, ShortRoute: 80, MedRoute: 82,
                  DeepRoute: 82, SpectacularCatch: 88, Release: 80 } },

  // ── TE ──────────────────────────────────────────────────────────────────────
  { position: "TE", name: "Blocking TE",
    attributes: { Speed: 75, Acceleration: 79, Agility: 75, Strength: 85, Awareness: 78,
                  Catching: 74, CatchInTraffic: 77, ShortRoute: 73, MedRoute: 71,
                  DeepRoute: 68, PassBlocking: 85, RunBlocking: 87 } },
  { position: "TE", name: "Vertical Threat",
    attributes: { Speed: 82, Acceleration: 84, Agility: 78, Strength: 75, Awareness: 76,
                  Catching: 85, CatchInTraffic: 82, ShortRoute: 76, MedRoute: 79,
                  DeepRoute: 85, PassBlocking: 70, RunBlocking: 72 } },
  { position: "TE", name: "Receiving TE",
    attributes: { Speed: 79, Acceleration: 83, Agility: 80, Strength: 77, Awareness: 79,
                  Catching: 87, CatchInTraffic: 86, ShortRoute: 84, MedRoute: 82,
                  DeepRoute: 78, PassBlocking: 72, RunBlocking: 74 } },

  // ── OL (applies to LT / LG / C / RG / RT — sub-position is chosen after archetype) ─
  { position: "OL", name: "Pass Blocker",
    attributes: { Speed: 68, Strength: 82, Awareness: 80, Agility: 71,
                  PassBlockPower: 80, PassBlockFinesse: 83, RunBlockPower: 74,
                  RunBlockFinesse: 75, ImpactBlocking: 74 } },
  { position: "OL", name: "Power",
    attributes: { Speed: 66, Strength: 90, Awareness: 77, Agility: 68,
                  PassBlockPower: 83, PassBlockFinesse: 74, RunBlockPower: 89,
                  RunBlockFinesse: 76, ImpactBlocking: 86 } },

  // ── DL ──────────────────────────────────────────────────────────────────────
  { position: "DL", name: "Pass Rusher",
    attributes: { Speed: 78, Strength: 82, Acceleration: 82, Agility: 79, Awareness: 75,
                  BlockShedding: 82, PowerMoves: 80, FinesseMoves: 86,
                  Tackle: 75, HitPower: 79, PursuitAngle: 80 } },
  { position: "DL", name: "Run Stopper",
    attributes: { Speed: 73, Strength: 90, Acceleration: 77, Agility: 74, Awareness: 77,
                  BlockShedding: 85, PowerMoves: 87, FinesseMoves: 74,
                  Tackle: 84, HitPower: 84, PursuitAngle: 78 } },
  { position: "DL", name: "Power",
    attributes: { Speed: 74, Strength: 88, Acceleration: 79, Agility: 75, Awareness: 76,
                  BlockShedding: 84, PowerMoves: 89, FinesseMoves: 76,
                  Tackle: 82, HitPower: 86, PursuitAngle: 77 } },

  // ── LB ──────────────────────────────────────────────────────────────────────
  { position: "LB", name: "Pass Coverage",
    attributes: { Speed: 82, Acceleration: 86, Agility: 83, Strength: 76, Awareness: 80,
                  Tackle: 76, HitPower: 74, ZoneCoverage: 84, ManCoverage: 78,
                  PlayRecognition: 82, PursuitAngle: 78 } },
  { position: "LB", name: "Speed",
    attributes: { Speed: 87, Acceleration: 90, Agility: 86, Strength: 76, Awareness: 77,
                  Tackle: 76, HitPower: 75, ZoneCoverage: 77, ManCoverage: 74,
                  PlayRecognition: 78, PursuitAngle: 84 } },
  { position: "LB", name: "Power",
    attributes: { Speed: 76, Acceleration: 81, Agility: 78, Strength: 87, Awareness: 76,
                  Tackle: 87, HitPower: 87, ZoneCoverage: 74, ManCoverage: 72,
                  PlayRecognition: 77, PursuitAngle: 78 } },
  { position: "LB", name: "Field General",
    attributes: { Speed: 79, Acceleration: 83, Agility: 80, Strength: 80, Awareness: 86,
                  Tackle: 82, HitPower: 80, ZoneCoverage: 82, ManCoverage: 76,
                  PlayRecognition: 88, PursuitAngle: 81 } },

  // ── CB ──────────────────────────────────────────────────────────────────────
  { position: "CB", name: "Man Coverage",
    attributes: { Speed: 90, Acceleration: 91, Agility: 90, Strength: 70, Awareness: 78,
                  ManCoverage: 90, ZoneCoverage: 78, Press: 83,
                  HitPower: 74, PlayRecognition: 80, Tackle: 72 } },
  { position: "CB", name: "Zone Coverage",
    attributes: { Speed: 87, Acceleration: 90, Agility: 88, Strength: 70, Awareness: 82,
                  ManCoverage: 80, ZoneCoverage: 90, Press: 74,
                  HitPower: 72, PlayRecognition: 86, Tackle: 74 } },
  { position: "CB", name: "Slot",
    attributes: { Speed: 88, Acceleration: 91, Agility: 92, Strength: 68, Awareness: 80,
                  ManCoverage: 84, ZoneCoverage: 82, Press: 78,
                  HitPower: 72, PlayRecognition: 82, Tackle: 73 } },

  // ── FS ──────────────────────────────────────────────────────────────────────
  { position: "FS", name: "Deep Zone",
    attributes: { Speed: 88, Acceleration: 90, Agility: 84, Strength: 72, Awareness: 82,
                  ZoneCoverage: 88, ManCoverage: 77, PlayRecognition: 84,
                  HitPower: 74, Tackle: 76 } },
  { position: "FS", name: "Cover",
    attributes: { Speed: 85, Acceleration: 88, Agility: 85, Strength: 74, Awareness: 84,
                  ZoneCoverage: 84, ManCoverage: 83, PlayRecognition: 86,
                  HitPower: 76, Tackle: 78 } },

  // ── SS ──────────────────────────────────────────────────────────────────────
  { position: "SS", name: "Enforcer",
    attributes: { Speed: 84, Acceleration: 87, Agility: 82, Strength: 80, Awareness: 80,
                  ZoneCoverage: 78, ManCoverage: 75, PlayRecognition: 82,
                  HitPower: 88, Tackle: 86 } },
  { position: "SS", name: "Hybrid",
    attributes: { Speed: 86, Acceleration: 89, Agility: 84, Strength: 78, Awareness: 82,
                  ZoneCoverage: 82, ManCoverage: 80, PlayRecognition: 84,
                  HitPower: 82, Tackle: 82 } },

  // ── K ───────────────────────────────────────────────────────────────────────
  { position: "K", name: "Accurate",
    attributes: { Speed: 72, KickPower: 80, KickAccuracy: 92 } },
  { position: "K", name: "Power",
    attributes: { Speed: 72, KickPower: 92, KickAccuracy: 80 } },

  // ── P ───────────────────────────────────────────────────────────────────────
  { position: "P", name: "Directional",
    attributes: { Speed: 72, KickPower: 82, KickAccuracy: 90 } },
  { position: "P", name: "Power",
    attributes: { Speed: 72, KickPower: 93, KickAccuracy: 79 } },
];

export const data = new SlashCommandBuilder()
  .setName("admin-customarchetypes")
  .setDescription("Manage custom player archetypes")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("list")
    .setDescription("List all archetypes (optionally filter by position)")
    .addStringOption(o => o
      .setName("position")
      .setDescription("Filter by position")
      .setRequired(false)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))),
    ),
  )
  .addSubcommand(sub => sub
    .setName("seed-defaults")
    .setDescription("Seed all positions with default Madden-style archetypes")
    .addBooleanOption(o => o
      .setName("overwrite")
      .setDescription("Overwrite archetypes that already exist? (default: false — skips existing)")
      .setRequired(false),
    ),
  )
  .addSubcommand(sub => sub
    .setName("add")
    .setDescription("Add or replace an archetype (JSON format: {\"Speed\":70,\"Accel\":72,...})")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true))
    .addStringOption(o => o.setName("attributes").setDescription('JSON object: {"SpeedAttr":70,"Acceleration":72,...}').setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Deactivate an archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name to deactivate").setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("restore")
    .setDescription("Re-activate a deactivated archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true)),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── List ─────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const posFilter = interaction.options.getString("position");
    const rows = posFilter
      ? await db.select().from(customArchetypesTable).where(eq(customArchetypesTable.position, posFilter))
      : await db.select().from(customArchetypesTable);

    if (rows.length === 0) {
      await interaction.editReply({
        content: "No archetypes found. Run `/admin-customarchetypes seed-defaults` to populate them.",
      });
      return;
    }

    const lines = rows.map(r =>
      `${r.isActive ? "✅" : "❌"} **${r.position}** — ${r.name}`,
    ).join("\n");

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📋 Custom Archetypes")
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: `${rows.length} total` });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Seed Defaults ─────────────────────────────────────────────────────────
  if (sub === "seed-defaults") {
    const overwrite = interaction.options.getBoolean("overwrite") ?? false;

    let created = 0;
    let skipped = 0;
    let updated = 0;

    for (const def of ARCHETYPE_DEFAULTS) {
      const existing = await db.select({ id: customArchetypesTable.id })
        .from(customArchetypesTable)
        .where(and(
          eq(customArchetypesTable.position, def.position),
          eq(customArchetypesTable.name, def.name),
        ))
        .limit(1);

      if (existing.length > 0) {
        if (overwrite) {
          await db.update(customArchetypesTable)
            .set({ attributes: def.attributes, isActive: true, updatedAt: new Date() })
            .where(eq(customArchetypesTable.id, existing[0]!.id));
          updated++;
        } else {
          skipped++;
        }
      } else {
        await db.insert(customArchetypesTable).values({
          position:   def.position,
          name:       def.name,
          attributes: def.attributes,
        });
        created++;
      }
    }

    const total = ARCHETYPE_DEFAULTS.length;
    const lines: string[] = [
      `Processed **${total}** default archetypes across all positions.`,
      `✅ Created: **${created}**`,
    ];
    if (skipped > 0) lines.push(`⏭️ Skipped (already exist): **${skipped}** — run with \`overwrite: true\` to update them`);
    if (updated > 0) lines.push(`🔄 Overwritten: **${updated}**`);

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🏈 Default Archetypes Seeded")
      .setDescription(lines.join("\n"))
      .addFields({ name: "Positions Covered", value: "QB · HB · FB · WR · TE · OL · DL · LB · CB · FS · SS · K · P" })
      .setFooter({ text: "Edit any archetype with /admin-customarchetypes add (it upserts by position+name)" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Add ──────────────────────────────────────────────────────────────────
  if (sub === "add") {
    const position   = interaction.options.getString("position", true);
    const name       = interaction.options.getString("name", true).trim();
    const attrStr    = interaction.options.getString("attributes", true);

    let attributes: Record<string, number>;
    try {
      const parsed = JSON.parse(attrStr);
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "number") throw new Error(`Value for "${k}" must be a number`);
      }
      attributes = parsed as Record<string, number>;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Invalid JSON: ${err.message}` });
      return;
    }

    const existing = await db.select()
      .from(customArchetypesTable)
      .where(and(
        eq(customArchetypesTable.position, position),
        eq(customArchetypesTable.name, name),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(customArchetypesTable)
        .set({ attributes, isActive: true, updatedAt: new Date() })
        .where(eq(customArchetypesTable.id, existing[0]!.id));
    } else {
      await db.insert(customArchetypesTable).values({ position, name, attributes });
    }

    const embed = formatArchetypeEmbed(position, name, attributes);
    embed.setTitle(`✅ Archetype Saved — ${embed.data.title}`);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Remove / Restore ─────────────────────────────────────────────────────
  const position = interaction.options.getString("position", true);
  const name     = interaction.options.getString("name", true).trim();
  const activate = sub === "restore";

  const [row] = await db.select()
    .from(customArchetypesTable)
    .where(and(
      eq(customArchetypesTable.position, position),
      eq(customArchetypesTable.name, name),
    ))
    .limit(1);

  if (!row) {
    await interaction.editReply({ content: `❌ No archetype found: **${position}** — ${name}` });
    return;
  }

  await db.update(customArchetypesTable)
    .set({ isActive: activate, updatedAt: new Date() })
    .where(eq(customArchetypesTable.id, row.id));

  await interaction.editReply({
    content: `${activate ? "✅ Restored" : "🗑️ Deactivated"}: **${position}** — ${name}`,
  });
}
