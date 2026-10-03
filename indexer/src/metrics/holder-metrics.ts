/**
 * Holder metrics for a specific date:
 * - holder_count: Number of token holders with positive balance (> 0) at end of day.
 * - new_holders: Number of addresses that became holders for the first time on the selected day
 *   (balance transitioned from 0 -> positive).
 *   Excludes existing holders, self-transfers, zero address, burns. Counted at most once per address.
 */
import { ZERO_ADDRESS, type HolderMetrics, type MetricTransfer } from './types.js';

export function calculateHolderMetrics(
  priorTransfers: readonly MetricTransfer[],
  dayTransfers: readonly MetricTransfer[],
): HolderMetrics {
  // 1. Reconstruct balances and prior history from transfers before this day
  const balances = new Map<string, bigint>();
  const everHeldPositivePrior = new Set<string>();

  for (const t of priorTransfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const amount = t.amount;

    if (from !== ZERO_ADDRESS) {
      const prev = balances.get(from) ?? 0n;
      balances.set(from, prev - amount);
    }

    if (to !== ZERO_ADDRESS) {
      const prev = balances.get(to) ?? 0n;
      const next = prev + amount;
      balances.set(to, next);
      if (next > 0n) {
        everHeldPositivePrior.add(to);
      }
    }
  }

  // Record addresses that already held a positive balance at the beginning of the day
  const positiveAtStartOfDay = new Set<string>();
  for (const [addr, bal] of balances) {
    if (bal > 0n && addr !== ZERO_ADDRESS) {
      positiveAtStartOfDay.add(addr);
      everHeldPositivePrior.add(addr);
    }
  }

  // 2. Process day's transfers in chronological order to detect first-time positive balance transitions
  const currentBalances = new Map<string, bigint>(balances);
  const newHolders = new Set<string>();

  for (const t of dayTransfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const amount = t.amount;

    // A new holder is an address whose balance transitions from 0 -> positive for the first time
    // Exclude:
    // - zero address
    // - self-transfers (from === to)
    // - transfers with amount <= 0
    // - addresses that were already holders at start of day
    // - addresses that had held positive balance in prior history
    if (to !== ZERO_ADDRESS && to !== from && amount > 0n) {
      const currentToBal = currentBalances.get(to) ?? 0n;
      if (currentToBal <= 0n && !positiveAtStartOfDay.has(to) && !everHeldPositivePrior.has(to)) {
        newHolders.add(to);
      }
    }

    // Apply transfer mutations to current balances
    if (from !== ZERO_ADDRESS) {
      const prev = currentBalances.get(from) ?? 0n;
      currentBalances.set(from, prev - amount);
    }

    if (to !== ZERO_ADDRESS) {
      const prev = currentBalances.get(to) ?? 0n;
      currentBalances.set(to, prev + amount);
    }
  }

  // 3. Extract positive balances at the end of the day
  const positiveBalances = new Map<string, bigint>();
  for (const [addr, bal] of currentBalances) {
    if (addr !== ZERO_ADDRESS && bal > 0n) {
      positiveBalances.set(addr, bal);
    }
  }

  return {
    holderCount: positiveBalances.size,
    newHolders: newHolders.size,
    positiveBalances,
  };
}
