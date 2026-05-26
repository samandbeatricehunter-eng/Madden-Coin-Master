import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../db/db-helpers.js";

export const POTY_CATEGORIES = [
  { key: "run", label: "Run of the Year" },
  { key: "pass", label: "Pass of the Year" },
  { key: "catch", label: "Catch of the Year" },
  { key: "interception", label: "Interception of the Year" },
  { key: "hit_stick", label: "Hit Stick of the Year" },
  { key: "return", label: "Return of the Year" },
  { key: "defensive_play", label: "Defensive Play of the Year" },
] as const;

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export async function ensureHighlightTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists highlight_nominees (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week text,
      category text not null,
      submitter_discord_id text not null,
      channel_id text not null,
      message_id text not null,
      jump_url text,
      status text not null default 'nominated',
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
  await db.execute(sql`
    create unique index if not exists highlight_nominees_unique_msg_cat_idx
    on highlight_nominees(guild_id, season_id, message_id, category)
  `);
  await db.execute(sql`
    create index if not exists highlight_nominees_category_idx
    on highlight_nominees(guild_id, season_id, category, status)
  `);
  await db.execute(sql`
    create table if not exists highlight_votes (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      category text not null,
      nominee_id integer not null,
      voter_discord_id text not null,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, season_id, category, voter_discord_id)
    )
  `);
}

export async function promptHighlightNomination(message: any): Promise<void> {
  await ensureHighlightTables();
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hlnom_pick:${message.guildId}:${message.channelId}:${message.id}`)
    .setPlaceholder("Nominate this highlight?")
    .addOptions([
      ...POTY_CATEGORIES.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
          .setValue(c.key),
      ),
      new StringSelectMenuOptionBuilder()
        .setLabel("Do Not Nominate")
        .setValue("none"),
    ]);

  await message.author.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏆 Play of the Year Nomination")
        .setDescription(
          "Your weekly highlight was accepted.\n\n" +
          "Select a Play of the Year category to nominate it, or choose **Do Not Nominate**.\n\n" +
          "Limit: **3 nominations per category per season**.",
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  }).catch(() => null);
}

export async function handleHighlightNominationInteraction(interaction: StringSelectMenuInteraction | ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("hlnom_") && !interaction.customId.startsWith("poty_")) return false;

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("hlnom_pick:")) {
    await ensureHighlightTables();
    const [, , guildId, channelId, messageId] = interaction.customId.split(":");
    const category = interaction.values[0]!;
    if (category === "none") {
      await interaction.update({ content: "Nomination closed. Your highlight still received the weekly upload payout.", embeds: [], components: [] });
      return true;
    }

    const season = await getOrCreateActiveSeason(guildId!);
    const existing = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from highlight_nominees
      where guild_id = ${guildId}
        and season_id = ${season.id}
        and submitter_discord_id = ${interaction.user.id}
        and category = ${category}
    `);
    if (Number(existing[0]?.count ?? 0) >= 3) {
      await interaction.update({ content: "❌ You already have 3 nominations in this category this season.", embeds: [], components: [] });
      return true;
    }

    await db.execute(sql`
      insert into highlight_nominees (
        guild_id, season_id, week, category, submitter_discord_id,
        channel_id, message_id, jump_url, status
      )
      values (
        ${guildId}, ${season.id}, ${(season as any).currentWeek ?? "1"}, ${category}, ${interaction.user.id},
        ${channelId}, ${messageId}, ${`https://discord.com/channels/${guildId}/${channelId}/${messageId}`}, 'nominated'
      )
      on conflict (guild_id, season_id, message_id, category) do nothing
    `);

    const label = POTY_CATEGORIES.find((c) => c.key === category)?.label ?? category;
    await interaction.update({ content: `✅ Highlight nominated for **${label}**.`, embeds: [], components: [] });
    return true;
  }

  if (interaction.isButton() && interaction.customId === "poty_home") {
    await renderPotyVote(interaction);
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith("poty_page:")) {
    const [, , category, pageRaw] = interaction.customId.split(":");
    await renderPotyVote(interaction, category, Math.max(0, Number(pageRaw ?? 0)));
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith("poty_vote:")) {
    await ensureHighlightTables();
    const [, , nomineeIdRaw] = interaction.customId.split(":");
    const nomineeId = Number(nomineeIdRaw);
    const nomineeRows = await rowsOf<any>(sql`
      select *
      from highlight_nominees
      where id = ${nomineeId}
      limit 1
    `);
    const nominee = nomineeRows[0];
    if (!nominee) {
      await interaction.reply({ ephemeral: true, content: "Nominee not found." });
      return true;
    }
    await db.execute(sql`
      insert into highlight_votes (guild_id, season_id, category, nominee_id, voter_discord_id)
      values (${nominee.guild_id}, ${nominee.season_id}, ${nominee.category}, ${nominee.id}, ${interaction.user.id})
      on conflict (guild_id, season_id, category, voter_discord_id)
      do update set nominee_id = excluded.nominee_id, updated_at = now()
    `);
    await interaction.reply({ ephemeral: true, content: "✅ Vote recorded. You can change your vote until voting closes." });
    return true;
  }

  return true;
}

export async function renderPotyVote(interaction: ButtonInteraction | StringSelectMenuInteraction, category?: string, page = 0): Promise<void> {
  await ensureHighlightTables();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);

  if (!category) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("poty_category")
      .setPlaceholder("Select Play of the Year category…")
      .addOptions(POTY_CATEGORIES.map((c) => new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.key)));
    const payload = {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle("🏆 Play of the Year Voting").setDescription("Select a category to view nominees and vote.")],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    };
    if ((interaction as any).deferred || (interaction as any).replied) await (interaction as any).editReply(payload);
    else await (interaction as any).update(payload);
    return;
  }

  const rows = await rowsOf<any>(sql`
    select *
    from highlight_nominees
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and category = ${category}
      and status = 'nominated'
    order by created_at asc
    limit 1 offset ${page}
  `);
  const totalRows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from highlight_nominees
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and category = ${category}
      and status = 'nominated'
  `);
  const total = Number(totalRows[0]?.count ?? 0);
  const nominee = rows[0];
  const label = POTY_CATEGORIES.find((c) => c.key === category)?.label ?? category;

  if (!nominee) {
    await (interaction as any).update({
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle(`🏆 ${label}`).setDescription("No nominees in this category.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("poty_home").setLabel("← Categories").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  await (interaction as any).update({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🏆 ${label}`)
        .setDescription(
          `Nominee **${page + 1}/${Math.max(1, total)}**\n` +
          `Submitted by: <@${nominee.submitter_discord_id}>\n` +
          `Week: **${nominee.week ?? "?"}**\n\n` +
          `[Open Original Highlight](${nominee.jump_url})`,
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`poty_page:${category}:${Math.max(0, page - 1)}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`poty_vote:${nominee.id}`).setLabel("✅ Vote").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`poty_page:${category}:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("poty_home").setLabel("← Categories").setStyle(ButtonStyle.Secondary)),
    ],
  });
}
