import { db } from "@workspace/db";
import {
  usersTable,
  userSavingsTable,
  serverSettingsTable,
  coinTransactionsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { Client } from "discord.js";

const BPS_DENOM = 10_000;

export interface LuxuryTaxSummary {
  ran: boolean;
  skippedReason?: string;
  threshold: number;
  rateBps: number;
  taxedCount: number;
  poolAmount: number;
  beneficiaryCount: number;
  perBeneficiary: number;
  remainder: number;
  taxed: Array<{ discordId: string; combined: number; tax: number }>;
  beneficiaries: string[];
}

interface UserWealth {
  discordId: string;
  wallet: number;
  savings: number;
  combined: number;
}

async function loadGuildWealth(guildId: string): Promise<UserWealth[]> {
  const wallets = await db.select({
    discordId: usersTable.discordId,
    balance:   usersTable.balance,
  })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));

  if (wallets.length === 0) return [];

  // Global savings table — join in memory; the user pool is small (dozens, not
  // thousands) so a plain map lookup is simpler than a SQL join across schemas.
  const allSavings = await db.select({
    discordId: userSavingsTable.discordId,
    balance:   userSavingsTable.balance,
  })
    .from(userSavingsTable);
  const savingsByUser = new Map(allSavings.map(s => [s.discordId, s.balance]));

  return wallets.map(w => {
    const wallet  = Number(w.balance) || 0;
    const savings = savingsByUser.get(w.discordId) ?? 0;
    return {
      discordId: w.discordId,
      wallet,
      savings,
      combined: wallet + savings,
    };
  });
}

/**
 * Debit `amount` from a user using the provided transaction executor `tx`,
 * taking from savings first (until 0) then from their wallet. Returns the
 * actual amount removed (may be less if combined balance is below `amount`,
 * which should not happen for tax math but is defensive).
 */
async function chargeFromSavingsThenWallet(
  tx: any,
  guildId: string,
  discordId: string,
  amount: number,
  currentSavings: number,
  currentWallet: number,
): Promise<{ takenFromSavings: number; takenFromWallet: number }> {
  if (amount <= 0) return { takenFromSavings: 0, takenFromWallet: 0 };

  const takenFromSavings = Math.min(currentSavings, amount);
  const remaining        = amount - takenFromSavings;
  const takenFromWallet  = Math.min(currentWallet, remaining);

  if (takenFromSavings > 0) {
    await tx.update(userSavingsTable)
      .set({
        balance:   sql`${userSavingsTable.balance} - ${takenFromSavings}`,
        updatedAt: new Date(),
      })
      .where(eq(userSavingsTable.discordId, discordId));
  }
  if (takenFromWallet > 0) {
    await tx.update(usersTable)
      .set({
        balance:   sql`${usersTable.balance} - ${takenFromWallet}`,
        updatedAt: new Date(),
      })
      .where(sql`${usersTable.discordId} = ${discordId} AND ${usersTable.guildId} = ${guildId}`);
  }

  return { takenFromSavings, takenFromWallet };
}

/**
 * Run end-of-regular-season luxury tax for a guild. Idempotent per season:
 * once `server_settings.luxuryTaxLastSeasonId` equals `seasonId`, calling
 * again is a no-op so a re-advance can't double-charge.
 *
 * - Wealthy = wallet + savings ≥ threshold
 * - Tax     = ceil(rate * (combined − threshold)), debited savings-first
 * - Pool    = sum of all taxes
 * - Bottom 50% of NON-wealthy users by combined wealth receive
 *   floor(pool / N) each (remainder stays in nobody's pocket — logged below)
 */
export async function runLuxuryTaxForGuild(
  client: Client | null,
  guildId: string,
  seasonId: number,
  opts: { force?: boolean } = {},
): Promise<LuxuryTaxSummary> {
  const settingsRow = await db.select()
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  const settings = settingsRow[0];

  const baseSummary = (): LuxuryTaxSummary => ({
    ran: false,
    threshold: settings?.luxuryTaxThreshold ?? 5000,
    rateBps:   settings?.luxuryTaxRateBps ?? 700,
    taxedCount: 0,
    poolAmount: 0,
    beneficiaryCount: 0,
    perBeneficiary: 0,
    remainder: 0,
    taxed: [],
    beneficiaries: [],
  });

  if (!settings) {
    return { ...baseSummary(), skippedReason: "no server_settings row" };
  }
  if (!settings.luxuryTaxEnabled) {
    return { ...baseSummary(), skippedReason: "disabled" };
  }
  if (!opts.force && settings.luxuryTaxLastSeasonId === seasonId) {
    return { ...baseSummary(), skippedReason: "already ran for this season" };
  }

  // Economy gate (defense in depth — main entry point also gates) — never
  // tax a guild without the minimum active+linked user count.
  const { assertEconomyEligible } = await import("./economy-gate.js");
  const gate = await assertEconomyEligible(guildId);
  if (!gate.ok) {
    return { ...baseSummary(), skippedReason: gate.reason };
  }

  const threshold = settings.luxuryTaxThreshold;
  const rateBps   = settings.luxuryTaxRateBps;

  const wealth = await loadGuildWealth(guildId);
  const wealthy = wealth.filter(u => u.combined >= threshold);

  // Bottom 50% of NON-wealthy registered users by combined wealth (wealthy
  // by definition aren't poor; redistribute to the half the tax was meant
  // to help). Selection happens off pre-tax balances — the tax doesn't
  // shift the ranking enough to matter and we need this set BEFORE the tx
  // begins so the whole thing is one atomic commit.
  const nonWealthy = wealth.filter(u => u.combined < threshold);
  nonWealthy.sort((a, b) => a.combined - b.combined);
  const half = nonWealthy.length > 0 ? Math.max(1, Math.floor(nonWealthy.length / 2)) : 0;
  const beneficiaries = nonWealthy.slice(0, half);

  // All balance mutations + the idempotency stamp must commit atomically.
  // If anything throws inside the tx, Postgres rolls back EVERY charge,
  // payout, and ledger row — and the stamp is never set, so the next
  // advance retries cleanly. Without this, a crash mid-loop would leave
  // some users charged AND block a retry once the stamp lands.
  let poolAmount = 0;
  const taxed: Array<{ discordId: string; combined: number; tax: number }> = [];
  let perBeneficiary = 0;
  let remainder      = 0;

  await db.transaction(async (tx) => {
    // 1) Tax pool
    for (const u of wealthy) {
      const excess = u.combined - threshold;
      const tax    = Math.ceil(excess * rateBps / BPS_DENOM);
      if (tax <= 0) continue;

      const { takenFromSavings, takenFromWallet } = await chargeFromSavingsThenWallet(
        tx, guildId, u.discordId, tax, u.savings, u.wallet,
      );
      const actual = takenFromSavings + takenFromWallet;
      if (actual <= 0) continue;

      poolAmount += actual;
      taxed.push({ discordId: u.discordId, combined: u.combined, tax: actual });

      await tx.insert(coinTransactionsTable).values({
        guildId,
        discordId:   u.discordId,
        amount:      -actual,
        type:        "luxury_tax_charge",
        description:
          `Luxury tax (${(rateBps / 100).toFixed(2)}%) on ${u.combined.toLocaleString()} ` +
          `combined coins — ${takenFromSavings.toLocaleString()} from savings, ` +
          `${takenFromWallet.toLocaleString()} from wallet`,
      });
    }

    // 2) Redistribution
    if (poolAmount > 0 && beneficiaries.length > 0) {
      perBeneficiary = Math.floor(poolAmount / beneficiaries.length);
      remainder      = poolAmount - perBeneficiary * beneficiaries.length;

      if (perBeneficiary > 0) {
        for (const b of beneficiaries) {
          await tx.update(usersTable)
            .set({
              balance:   sql`${usersTable.balance} + ${perBeneficiary}`,
              updatedAt: new Date(),
            })
            .where(sql`${usersTable.discordId} = ${b.discordId} AND ${usersTable.guildId} = ${guildId}`);

          await tx.insert(coinTransactionsTable).values({
            guildId,
            discordId:   b.discordId,
            amount:      perBeneficiary,
            type:        "luxury_tax_payout",
            description:
              `Luxury tax redistribution — equal share of ${poolAmount.toLocaleString()} coin pool ` +
              `across ${beneficiaries.length} bottom-half users`,
          });
        }
      }
    }

    // 3) Stamp idempotency + last-run summary (inside the same tx, so a
    //    rollback drops it and a retry can run again cleanly)
    await tx.update(serverSettingsTable)
      .set({
        luxuryTaxLastSeasonId:         seasonId,
        luxuryTaxLastRunAt:            new Date(),
        luxuryTaxLastTaxedCount:       taxed.length,
        luxuryTaxLastPoolAmount:       poolAmount,
        luxuryTaxLastBeneficiaryCount: beneficiaries.length,
        luxuryTaxLastPerBeneficiary:   perBeneficiary,
        updatedAt:                     new Date(),
      })
      .where(eq(serverSettingsTable.guildId, guildId));
  });

  // 4) Best-effort DMs (no failures should roll back the tax math above)
  if (client) {
    for (const t of taxed) {
      try {
        const user = await client.users.fetch(t.discordId);
        await user.send(
          `📉 **Luxury Tax — End of Regular Season**\n` +
          `Your combined balance of **${t.combined.toLocaleString()}** coins ` +
          `(wallet + savings) was above the **${threshold.toLocaleString()}** ` +
          `coin threshold, so a **${(rateBps / 100).toFixed(2)}%** tax on the ` +
          `excess was collected: **${t.tax.toLocaleString()}** coins.\n` +
          `Charged from savings first, then wallet. Pooled with all other ` +
          `wealthy users this season and redistributed evenly to the poorest ` +
          `half of the server.`,
        );
      } catch { /* DMs closed — skip */ }
    }
    if (perBeneficiary > 0) {
      for (const b of beneficiaries) {
        try {
          const user = await client.users.fetch(b.discordId);
          await user.send(
            `💰 **Luxury Tax Redistribution**\n` +
            `You received **${perBeneficiary.toLocaleString()}** coins as ` +
            `your equal share of this season's luxury tax pool ` +
            `(${poolAmount.toLocaleString()} coins from ${taxed.length} ` +
            `wealthy user${taxed.length === 1 ? "" : "s"}, split across ` +
            `${beneficiaries.length} bottom-half users).`,
          );
        } catch { /* DMs closed — skip */ }
      }
    }
  }

  return {
    ran: true,
    threshold,
    rateBps,
    taxedCount: taxed.length,
    poolAmount,
    beneficiaryCount: beneficiaries.length,
    perBeneficiary,
    remainder,
    taxed,
    beneficiaries: beneficiaries.map(b => b.discordId),
  };
}
