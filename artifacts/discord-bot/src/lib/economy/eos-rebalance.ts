import type { Client } from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userSavingsTable, serverSettingsTable, pendingEosPayoutsTable, coinTransactionsTable,
} from "@workspace/db";
import { and, eq, ne, or, isNull, isNotNull, notLike, sql } from "drizzle-orm";
import { assertEconomyEligible } from "./economy-gate.js";

export interface EosRebalanceSummary {
  ran: boolean;
  skippedReason?: string;
  pool: number;
  beneficiaryCount: number;
  perBeneficiary: number;
  beneficiaries: { discordId: string; combined: number; awarded: number }[];
  tieBreakRolls?: { discordId: string; roll: number; round: number }[];
}

// Sum of 5d10 — used as the RNG tiebreak per the league rules. Re-rolls on
// continued tie are handled by the caller; this function is a single round.
function rollFiveD10(): number {
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += 1 + Math.floor(Math.random() * 10);
  return sum;
}

// Given a list of candidates tied at the same wealth bucket and the number of
// "slots" to award from that bucket, returns the chosen subset in order.
// Logs every roll round to `rolls` for transparency.
function breakTieByDice(
  candidates: { discordId: string; combined: number }[],
  slotsNeeded: number,
  rolls: { discordId: string; roll: number; round: number }[],
): { discordId: string; combined: number }[] {
  if (candidates.length <= slotsNeeded) return candidates.slice();

  let pool = candidates.slice();
  let round = 1;
  const winners: { discordId: string; combined: number }[] = [];

  while (winners.length < slotsNeeded && pool.length > 0) {
    const rolled = pool.map(c => {
      const roll = rollFiveD10();
      rolls.push({ discordId: c.discordId, roll, round });
      return { ...c, roll };
    });
    const remainingSlots = slotsNeeded - winners.length;
    rolled.sort((a, b) => b.roll - a.roll);

    // Walk top-down. Anyone strictly higher than the slot cutoff is a clear
    // winner; any tie around the cutoff goes back into the next round.
    const cutoffRoll = rolled[remainingSlots - 1]!.roll;
    const clearWinners = rolled.filter(r => r.roll > cutoffRoll);
    const cutoffTied   = rolled.filter(r => r.roll === cutoffRoll);

    for (const w of clearWinners) winners.push({ discordId: w.discordId, combined: w.combined });

    const stillNeed = slotsNeeded - winners.length;
    if (stillNeed <= 0) break;

    if (cutoffTied.length === stillNeed) {
      for (const w of cutoffTied) winners.push({ discordId: w.discordId, combined: w.combined });
      break;
    }
    // Re-roll just the tied group for the remaining slots.
    pool = cutoffTied.map(({ discordId, combined }) => ({ discordId, combined }));
    round++;
    if (round > 20) {
      // Safety vent — astronomically unlikely. Pick by lexical id so we always halt.
      pool.sort((a, b) => a.discordId.localeCompare(b.discordId));
      for (const w of pool.slice(0, stillNeed)) winners.push(w);
      break;
    }
  }
  return winners;
}

/**
 * Distributes the accumulated EOS Rebalance Tax pool (5% withheld from each
 * top-4 EOS payout during commissioner approval) to the bottom-4 active+linked
 * users by combined wealth, EXCLUDING anyone in the top-4 taxed set for that
 * same season.
 *
 * Runs once per season at the SB→Offseason advance. Idempotent via
 * `server_settings.eosRebalanceLastSeasonId === seasonId`.
 *
 * Gated by `assertEconomyEligible` (≥8 active+linked users) — skipped silently
 * if not eligible.
 */
export async function runEosRebalanceForGuild(
  client: Client | null,
  guildId: string,
  seasonId: number,
): Promise<EosRebalanceSummary> {
  const baseSummary = (): EosRebalanceSummary => ({
    ran: false, pool: 0, beneficiaryCount: 0, perBeneficiary: 0, beneficiaries: [],
  });

  const gate = await assertEconomyEligible(guildId);
  if (!gate.ok) {
    // Don't stamp idempotency — keep pool intact for a future re-attempt once
    // the user count grows. But also don't loop on every advance; just exit.
    return { ...baseSummary(), skippedReason: gate.reason };
  }

  // The ENTIRE pipeline runs inside one transaction with a guarded stamp at
  // the top acting as the lock — only one concurrent run can claim a given
  // season. This eliminates the precheck/distribute race that would otherwise
  // double-pay beneficiaries if two advances fire near-simultaneously.
  type ChosenRow = { discordId: string; combined: number };
  let result: EosRebalanceSummary = baseSummary();
  let chosen: ChosenRow[] = [];
  let perBeneficiary = 0;
  let poolUsed = 0;

  await db.transaction(async (tx) => {
    // Atomic claim: only the first concurrent caller for THIS season succeeds.
    const claimed = await tx.update(serverSettingsTable)
      .set({ eosRebalanceLastSeasonId: seasonId, eosRebalanceLastRunAt: new Date() })
      .where(and(
        eq(serverSettingsTable.guildId, guildId),
        or(
          isNull(serverSettingsTable.eosRebalanceLastSeasonId),
          ne(serverSettingsTable.eosRebalanceLastSeasonId, seasonId),
        ),
      ))
      .returning();
    if (claimed.length === 0) {
      result = { ...baseSummary(), skippedReason: "already ran for this season" };
      return;
    }
    const s = claimed[0]!;

    // Pool is only meaningful if it belongs to THIS season. Stale pools from
    // a prior season are ignored (and cleared below).
    const poolValid = s.eosRebalancePoolSeasonId === seasonId;
    const pool = poolValid ? (s.eosRebalancePoolAmount ?? 0) : 0;
    poolUsed = pool;

    if (pool <= 0) {
      // Already-stamped; just clear pool fields and exit silently.
      await tx.update(serverSettingsTable).set({
        eosRebalanceLastPool:             0,
        eosRebalanceLastBeneficiaryCount: 0,
        eosRebalanceLastPerBeneficiary:   0,
        eosRebalancePoolSeasonId:         null,
        eosRebalancePoolAmount:           0,
      }).where(eq(serverSettingsTable.guildId, guildId));
      result = { ...baseSummary(), skippedReason: "pool empty" };
      return;
    }

    // Identify the taxed top-4 to exclude from the bottom-4 selection.
    const taxedRows = await tx.select({ discordId: pendingEosPayoutsTable.discordId })
      .from(pendingEosPayoutsTable)
      .where(and(
        eq(pendingEosPayoutsTable.seasonId, seasonId),
        eq(pendingEosPayoutsTable.rebalanceTaxed, true),
      ));
    const excluded = new Set(taxedRows.map(r => r.discordId));

    const allUsers = await tx.select({
      discordId: usersTable.discordId,
      balance:   usersTable.balance,
      savings:   userSavingsTable.balance,
    })
      .from(usersTable)
      .leftJoin(userSavingsTable, eq(userSavingsTable.discordId, usersTable.discordId))
      .where(and(
        eq(usersTable.guildId, guildId),
        isNotNull(usersTable.team),
        ne(usersTable.team, ""),
        notLike(usersTable.discordId, "unlinked_%"),
      ));

    const eligible = allUsers
      .filter(u => !excluded.has(u.discordId))
      .map(u => ({ discordId: u.discordId, combined: (u.balance ?? 0) + (u.savings ?? 0) }));

    const NUM_BENEFICIARIES = 4;
    if (eligible.length === 0) {
      result = { ...baseSummary(), skippedReason: "no eligible beneficiaries" };
      return;
    }

    eligible.sort((a, b) => a.combined - b.combined);
    const slots = Math.min(NUM_BENEFICIARIES, eligible.length);
    const tieBreakRolls: { discordId: string; roll: number; round: number }[] = [];

    let i = 0;
    while (chosen.length < slots && i < eligible.length) {
      const bucketWealth = eligible[i]!.combined;
      const bucket: ChosenRow[] = [];
      while (i < eligible.length && eligible[i]!.combined === bucketWealth) {
        bucket.push(eligible[i]!);
        i++;
      }
      const remainingSlots = slots - chosen.length;
      if (bucket.length <= remainingSlots) {
        chosen = chosen.concat(bucket);
      } else {
        chosen = chosen.concat(breakTieByDice(bucket, remainingSlots, tieBreakRolls));
      }
    }

    const beneficiaryCount = chosen.length;
    perBeneficiary = Math.floor(pool / beneficiaryCount);

    if (perBeneficiary <= 0) {
      await tx.update(serverSettingsTable).set({
        eosRebalanceLastPool:             pool,
        eosRebalanceLastBeneficiaryCount: 0,
        eosRebalanceLastPerBeneficiary:   0,
        eosRebalancePoolSeasonId:         null,
        eosRebalancePoolAmount:           0,
      }).where(eq(serverSettingsTable.guildId, guildId));
      result = { ...baseSummary(), pool, skippedReason: "pool < beneficiary count" };
      chosen = [];
      return;
    }

    for (const b of chosen) {
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${perBeneficiary}` })
        .where(and(eq(usersTable.guildId, guildId), eq(usersTable.discordId, b.discordId)));
      await tx.insert(coinTransactionsTable).values({
        guildId,
        discordId:   b.discordId,
        amount:      perBeneficiary,
        type:        "eos_rebalance_payout",
        description: `EOS Rebalance — Season ${seasonId} bottom-4 redistribution from top-4 5% tax pool`,
      });
    }
    await tx.update(serverSettingsTable).set({
      eosRebalanceLastPool:             pool,
      eosRebalanceLastBeneficiaryCount: beneficiaryCount,
      eosRebalanceLastPerBeneficiary:   perBeneficiary,
      eosRebalancePoolSeasonId:         null,
      eosRebalancePoolAmount:           0,
    }).where(eq(serverSettingsTable.guildId, guildId));

    result = {
      ran: true,
      pool,
      beneficiaryCount,
      perBeneficiary,
      beneficiaries: chosen.map(b => ({ ...b, awarded: perBeneficiary })),
      tieBreakRolls: tieBreakRolls.length ? tieBreakRolls : undefined,
    };
  });

  if (!result.ran) return result;
  void poolUsed;

  // DM each beneficiary (best-effort, never fails the run).
  if (client) {
    for (const b of chosen) {
      try {
        const u = await client.users.fetch(b.discordId);
        await u.send(
          `💸 **EOS Rebalance — Season ${seasonId}**\n` +
          `You received **+${perBeneficiary.toLocaleString()} coins** from the league's ` +
          `end-of-season Rebalance Pool — a 5% redistribution from the top-4 EOS payouts ` +
          `to the bottom-4 by combined wallet+savings wealth.\n\n` +
          `Pool: ${result.pool.toLocaleString()} coins • Beneficiaries: ${result.beneficiaryCount}`,
        ).catch(() => {});
      } catch {/* ignore — DMs closed */}
    }
  }

  return result;
}
