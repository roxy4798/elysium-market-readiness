import { describe, expect, it } from 'vitest';
import { applyTransfers, balanceKey, balanceKeysFor, type BalanceTransfer } from '../src/holder-engine.js';
import { ADDR } from './helpers/fakes.js';

const T = ADDR.tokenA;
let n = 0;
const tr = (from: string, to: string, amount: bigint, block = 1n): BalanceTransfer => ({
  tokenAddress: T, txHash: `0x${(++n).toString(16)}`, logIndex: n, blockNumber: block, from, to, amount,
});
const bal = (entries: Array<[string, bigint]>) => new Map(entries.map(([h, b]) => [balanceKey(T, h), b]));
const get = (r: ReturnType<typeof applyTransfers>, h: string) => r.updates.find((u) => u.holderAddress === h)?.balance;

describe('5. mint handling', () => {
  it('credits recipient and never creates a zero-address balance', () => {
    const r = applyTransfers(new Map(), [tr(ADDR.zero, ADDR.alice, 1000n)]);
    expect(get(r, ADDR.alice)).toBe(1000n);
    expect(r.updates.some((u) => u.holderAddress === ADDR.zero)).toBe(false);
    expect(r.anomalies).toHaveLength(0);
    expect(balanceKeysFor([tr(ADDR.zero, ADDR.alice, 1n)]).map((k) => k.holder)).toEqual([ADDR.alice]);
  });
});

describe('6. burn handling', () => {
  it('debits sender and never credits the zero address', () => {
    const r = applyTransfers(bal([[ADDR.alice, 1000n]]), [tr(ADDR.alice, ADDR.zero, 400n)]);
    expect(get(r, ADDR.alice)).toBe(600n);
    expect(r.updates.some((u) => u.holderAddress === ADDR.zero)).toBe(false);
  });
});

describe('7. self-transfer handling', () => {
  it('does not mutate balances but counts the transfer', () => {
    const r = applyTransfers(bal([[ADDR.alice, 50n]]), [tr(ADDR.alice, ADDR.alice, 50n)]);
    expect(r.updates).toHaveLength(0);
    expect(r.skippedSelfTransfers).toBe(1);
    expect(r.anomalies).toHaveLength(0);
  });
  it('is a no-op even if the self-transfer exceeds the balance', () => {
    const r = applyTransfers(new Map(), [tr(ADDR.alice, ADDR.alice, 10n)]);
    expect(r.updates).toHaveLength(0);
    expect(r.anomalies).toHaveLength(0);
  });
});

describe('8. balance updates', () => {
  it('moves value between holders in chain order', () => {
    const r = applyTransfers(new Map(), [
      tr(ADDR.alice, ADDR.carol, 30n, 3n), // applied last despite list position
      tr(ADDR.zero, ADDR.alice, 100n, 1n),
      tr(ADDR.alice, ADDR.bob, 40n, 2n),
    ]);
    expect(r.anomalies).toHaveLength(0);
    expect(get(r, ADDR.alice)).toBe(30n);
    expect(get(r, ADDR.bob)).toBe(40n);
    expect(get(r, ADDR.carol)).toBe(30n);
    expect(r.updates.find((u) => u.holderAddress === ADDR.alice)?.lastUpdatedBlock).toBe(3n);
  });

  it('keeps a zero balance row when a holder is fully drained', () => {
    const r = applyTransfers(bal([[ADDR.alice, 5n]]), [tr(ADDR.alice, ADDR.bob, 5n)]);
    expect(get(r, ADDR.alice)).toBe(0n);
  });

  it('never goes negative: rejects the whole mutation and reports an anomaly', () => {
    const r = applyTransfers(bal([[ADDR.alice, 10n]]), [tr(ADDR.alice, ADDR.bob, 11n), tr(ADDR.alice, ADDR.carol, 4n)]);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ holder: ADDR.alice, balance: 10n, amount: 11n, reason: 'INSUFFICIENT_BALANCE' });
    expect(get(r, ADDR.bob)).toBeUndefined(); // recipient not credited either
    expect(get(r, ADDR.alice)).toBe(6n);
    expect(get(r, ADDR.carol)).toBe(4n);
    expect(r.updates.every((u) => u.balance >= 0n)).toBe(true);
  });

  it('does not mutate the input map', () => {
    const cur = bal([[ADDR.alice, 10n]]);
    applyTransfers(cur, [tr(ADDR.alice, ADDR.bob, 10n)]);
    expect(cur.get(balanceKey(T, ADDR.alice))).toBe(10n);
  });
});
