/**
 * Shared helpers used across the individual purchase commands
 * (buy-legend, buy-attribute, buy-devup, buy-agereset, buy-customplayer).
 */

import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, franchiseRostersTable, franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { errorEmbed } from "../discord/embeds.js";

export const DEV_LABEL: Record<number, string> = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };

// ── Insufficient-funds reply ───────────────────────────────────────────────────
export function insufficientFunds(
  interaction: ChatInputCommandInteraction,
  cost: number,
  balance: number,
) {
  return interaction.editReply({
    embeds: [errorEmbed(
      "Insufficient Funds",
      `You need **${cost.toLocaleString()} coins** but only have **${balance.toLocaleString()} coins**. ` +
      `You're short by **${(cost - balance).toLocaleString()} coins**.`,
    )],
  });
}

// ── Commissioner notification ──────────────────────────────────────────────────
// No-op: commissioner-facing notifications are now surfaced through the
// pending-transactions hub instead of being posted into a designated channel.
export async function sendCommissionerNotification(
  _interaction: ChatInputCommandInteraction,
  type: string,
  purchaseId: number,
  _details: Record<string, string | number | undefined>,
) {
  console.log(`[purchase-shared] sendCommissionerNotification no-op: type=${type} purchaseId=${purchaseId}`);
  return;
}

// ── Roster row lookup (shared by autocomplete in devup / agereset / attribute) ─
export type RosterField = {
  position?: string;
  firstName?: string;
  lastName?: string;
  devTrait?: number;
  overall?: number;
  age?: number;
};

export async function getRosterRows<T extends Record<string, any>>(
  interaction: AutocompleteInteraction | ChatInputCommandInteraction,
  seasonId: number,
  fields: T,
): Promise<T[]> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  // Primary: direct discord_id match on roster rows (fastest, works after cascade)
  const baseWhere = and(
    eq(franchiseRostersTable.seasonId, seasonId),
    eq(franchiseRostersTable.discordId, userId),
  );
  const direct = await (db.select(fields).from(franchiseRostersTable).where(baseWhere) as any) as T[];
  if (direct.length > 0) return direct;

  // Fallback 1: look up team via discord_id on MCA teams — reliable, no name-matching needed.
  // Handles cases where roster rows weren't cascaded yet (e.g. team linked after roster import).
  const [teamByDiscord] = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      eq(franchiseMcaTeamsTable.discordId, userId),
    ))
    .limit(1);

  if (teamByDiscord) {
    const byTeam = await (db.select(fields).from(franchiseRostersTable).where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamId, teamByDiscord.teamId),
    )) as any) as T[];
    if (byTeam.length > 0) return byTeam;
  }

  // Fallback 2: resolve via team name stored in economy_users (handles edge cases
  // where the user's discord_id is not yet linked in franchise_mca_teams)
  const [userRow] = await db
    .select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, userId), eq(usersTable.guildId, guildId)))
    .limit(1);
  if (!userRow?.team) return [];

  const teamSearch  = userRow.team.trim();
  const teamEntries = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      or(
        ilike(franchiseMcaTeamsTable.fullName, `%${teamSearch}%`),
        ilike(franchiseMcaTeamsTable.nickName, `%${teamSearch}%`),
      ),
    ));
  if (teamEntries.length === 0) return [];

  const teamIds = teamEntries.map(t => t.teamId);
  return (db.select(fields).from(franchiseRostersTable).where(and(
    eq(franchiseRostersTable.seasonId, seasonId),
    teamIds.length === 1
      ? eq(franchiseRostersTable.teamId, teamIds[0]!)
      : sql`${franchiseRostersTable.teamId} = ANY(ARRAY[${sql.join(teamIds.map(id => sql`${id}`), sql`, `)}])`,
  )) as any) as T[];
}
