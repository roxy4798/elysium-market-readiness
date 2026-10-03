/**
 * Holder engine: pure, deterministic balance accounting for ERC-20 transfers.
 *
 * Rules
 *  - from balance -= amount, to balance += amount
 *  - Mint  (from == 0x0): only credit `to`
 *  - Burn  (to   == 0x0): only debit `from`
 *  - The zero address never gets a balance row
 *  - Self-transfer (from == to): no balance mutation (event is still stored elsewhere)
 *  - A balance may never become negative. If a transfer would make it negative, that
 *    transfer's balance mutation is rejected atomically (neither side changes) and an
 *    anomaly is reported. Typical causes: indexing started after token deployment, or a
 *    non-standard token (rebasing / fee-on-transfer with misleading events).
 */
import { ZERO_ADDRESS } from './abi/erc20.js';

export interface BalanceTransfer {
  readonly tokenAddress: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

export interface BalanceAnomaly {
  readonly tokenAddress: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly holder: string;
  readonly balance: bigint;
  readonly amount: bigint;
  readonly reason: 'INSUFFICIENT_BALANCE';
}

export interface BalanceUpdate {
  readonly tokenAddress: string;
  readonly holderAddress: string;
  readonly balance: bigint;
  readonly lastUpdatedBlock: bigint;
}

export interface HolderEngineResult {
  readonly updates: BalanceUpdate[];
  readonly anomalies: BalanceAnomaly[];
  readonly applied: number;
  readonly skippedSelfTransfers: number;
}

export const balanceKey = (token: string, holder: string): string => `${token}:${holder}`;

/** Collect the (token, holder) pairs whose current balance is needed to apply `transfers`. */
export function balanceKeysFor(transfers: readonly BalanceTransfer[]): Array<{ token: string; holder: string }> {
  const seen = new Map<string, { token: string; holder: string }>();
  for (const t of transfers) {
    if (t.from === t.to) continue;
    for (const h of [t.from, t.to]) {
      if (h === ZERO_ADDRESS) continue;
      seen.set(balanceKey(t.tokenAddress, h), { token: t.tokenAddress, holder: h });
    }
  }
  return [...seen.values()];
}

export function compareTransfers(a: BalanceTransfer, b: BalanceTransfer): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/**
 * Apply transfers (in chain order) on top of `current` balances.
 * `current` maps balanceKey -> balance; missing keys are treated as 0. Input is not mutated.
 */
export function applyTransfers(
  current: ReadonlyMap<string, bigint>,
  transfers: readonly BalanceTransfer[],
): HolderEngineResult {
  const balances = new Map(current);
  const touched = new Map<string, { token: string; holder: string; block: bigint }>();
  const anomalies: BalanceAnomaly[] = [];
  let applied = 0;
  let skippedSelfTransfers = 0;

  const ordered = [...transfers].sort(compareTransfers);

  for (const t of ordered) {
    if (t.amount < 0n) throw new Error(`negative transfer amount in ${t.txHash}:${t.logIndex}`);
    if (t.from === t.to) {
      skippedSelfTransfers++;
      continue;
    }
    const isMint = t.from === ZERO_ADDRESS;
    const isBurn = t.to === ZERO_ADDRESS;
    const fromKey = balanceKey(t.tokenAddress, t.from);
    const toKey = balanceKey(t.tokenAddress, t.to);

    if (!isMint) {
      const fromBal = balances.get(fromKey) ?? 0n;
      if (fromBal < t.amount) {
        anomalies.push({
          tokenAddress: t.tokenAddress,
          txHash: t.txHash,
          logIndex: t.logIndex,
          blockNumber: t.blockNumber,
          holder: t.from,
          balance: fromBal,
          amount: t.amount,
          reason: 'INSUFFICIENT_BALANCE',
        });
        continue; // reject the whole mutation for this transfer
      }
      balances.set(fromKey, fromBal - t.amount);
      touched.set(fromKey, { token: t.tokenAddress, holder: t.from, block: t.blockNumber });
    }
    if (!isBurn) {
      balances.set(toKey, (balances.get(toKey) ?? 0n) + t.amount);
      touched.set(toKey, { token: t.tokenAddress, holder: t.to, block: t.blockNumber });
    }
    applied++;
  }

  const updates: BalanceUpdate[] = [...touched.entries()].map(([key, v]) => ({
    tokenAddress: v.token,
    holderAddress: v.holder,
    balance: balances.get(key) ?? 0n,
    lastUpdatedBlock: v.block,
  }));

  return { updates, anomalies, applied, skippedSelfTransfers };
}
