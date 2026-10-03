/**
 * Deterministic unit tests for Phase 2A — Raw Market Metrics Engine.
 * Tests all 15 required scenarios without requiring the live Elysium RPC.
 */
import { describe, expect, it } from 'vitest';
import { calculateActivityMetrics } from '../src/metrics/activity-metrics.js';
import { calculateConcentration, formatRatio } from '../src/metrics/concentration-metrics.js';
import {
  computeDailyMetricsForTransfers,
  getUtcDayBounds,
  upsertDailyMetrics,
  validateDateString,
} from '../src/metrics/daily-metrics.js';
import { calculateHolderMetrics } from '../src/metrics/holder-metrics.js';
import { ZERO_ADDRESS, type DailyMetrics, type MetricTransfer } from '../src/metrics/types.js';

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc';
const DAVE = '0xdddddddddddddddddddddddddddddddddddddddd';

function makeTransfer(overrides: Partial<MetricTransfer> = {}): MetricTransfer {
  return {
    from: ALICE,
    to: BOB,
    amount: 100n,
    blockTimestamp: new Date('2026-09-22T12:00:00.000Z'),
    blockNumber: 1000n,
    txHash: '0x1',
    logIndex: 0,
    ...overrides,
  };
}

describe('Phase 2A — Raw Market Metrics Engine', () => {
  // Scenario 1: Holder count
  it('1. calculates holder count based on strictly positive balances (> 0) at end of day', () => {
    const prior: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 100n }),
    ];
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: BOB, amount: 60n }),
      makeTransfer({ from: ALICE, to: CAROL, amount: 40n }), // ALICE balance becomes 0
    ];

    const h = calculateHolderMetrics(prior, day);
    expect(h.holderCount).toBe(2); // BOB (60) and CAROL (40); ALICE has 0
    expect(h.positiveBalances.get(BOB)).toBe(60n);
    expect(h.positiveBalances.get(CAROL)).toBe(40n);
    expect(h.positiveBalances.has(ALICE)).toBe(false);
  });

  // Scenario 2: New holder detection
  it('2. detects new holders whose balance transitioned from 0 to positive during the day', () => {
    const prior: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 500n }),
    ];
    const day: MetricTransfer[] = [
      // BOB receives for the first time -> new holder
      makeTransfer({ from: ALICE, to: BOB, amount: 100n }),
      // BOB receives additional tokens -> still counted only once
      makeTransfer({ from: ALICE, to: BOB, amount: 50n }),
      // ALICE was already an existing holder -> receiving from someone else does NOT make her new
      makeTransfer({ from: BOB, to: ALICE, amount: 10n }),
    ];

    const h = calculateHolderMetrics(prior, day);
    expect(h.newHolders).toBe(1); // Only BOB is a new holder
  });

  // Scenario 3: Active holder calculation
  it('3. calculates active holders as unique(from_address) UNION unique(to_address) excluding zero address', () => {
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: BOB, amount: 10n }),
      makeTransfer({ from: BOB, to: CAROL, amount: 5n }),
      makeTransfer({ from: ZERO_ADDRESS, to: DAVE, amount: 50n }), // Mint
    ];

    const a = calculateActivityMetrics(day);
    // Active should be ALICE, BOB, CAROL, DAVE (4 unique addresses)
    expect(a.activeHolders).toBe(4);
  });

  // Scenario 4: Transfer count
  it('4. counts valid ERC-20 transfer events stored on the selected day', () => {
    const day: MetricTransfer[] = [
      makeTransfer({ amount: 10n }),
      makeTransfer({ amount: 20n }),
      makeTransfer({ amount: 30n }),
    ];

    const a = calculateActivityMetrics(day);
    expect(a.transferCount).toBe(3);
  });

  // Scenario 5: Unique senders calculation
  it('5. calculates unique senders excluding zero address', () => {
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: BOB, amount: 10n }),
      makeTransfer({ from: ALICE, to: CAROL, amount: 20n }),
      makeTransfer({ from: BOB, to: CAROL, amount: 5n }),
      makeTransfer({ from: ZERO_ADDRESS, to: DAVE, amount: 50n }), // Mint
    ];

    const a = calculateActivityMetrics(day);
    // Senders: ALICE, BOB (2 unique non-zero senders)
    expect(a.uniqueSenders).toBe(2);
  });

  // Scenario 6: Unique receivers calculation
  it('6. calculates unique receivers excluding zero address', () => {
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: BOB, amount: 10n }),
      makeTransfer({ from: CAROL, to: BOB, amount: 20n }),
      makeTransfer({ from: DAVE, to: ALICE, amount: 5n }),
      makeTransfer({ from: BOB, to: ZERO_ADDRESS, amount: 1n }), // Burn
    ];

    const a = calculateActivityMetrics(day);
    // Receivers: BOB, ALICE (2 unique non-zero receivers)
    expect(a.uniqueReceivers).toBe(2);
  });

  // Scenario 7: Top 1 concentration
  it('7. calculates top 1 concentration as a decimal ratio between 0 and 1', () => {
    const balances = new Map<string, bigint>([
      [ALICE, 400n],
      [BOB, 300n],
      [CAROL, 300n],
    ]);
    // Total = 1000. Top 1 = 400 / 1000 = 0.40
    const c = calculateConcentration(balances);
    expect(c.top1Concentration).toBe(0.4);
  });

  // Scenario 8: Top 5 concentration
  it('8. calculates top 5 concentration accurately and caps at 1.0 when fewer than 5 holders exist', () => {
    // Exactly 3 holders: sum of top 5 must equal 100% of supply (1.0)
    const balancesSmall = new Map<string, bigint>([
      [ALICE, 500n],
      [BOB, 300n],
      [CAROL, 200n],
    ]);
    const cSmall = calculateConcentration(balancesSmall);
    expect(cSmall.top5Concentration).toBe(1);

    // 10 holders with equal balances (100 each = 1000 total) -> top 5 = 500 / 1000 = 0.50
    const balances10: bigint[] = Array.from({ length: 10 }, () => 100n);
    const c10 = calculateConcentration(balances10);
    expect(c10.top5Concentration).toBe(0.5);
  });

  // Scenario 9: Top 10 concentration
  it('9. calculates top 10 concentration accurately and caps at 1.0 when fewer than 10 holders exist', () => {
    // 7 holders: sum of top 10 must equal 100% of supply (1.0)
    const balances7: bigint[] = Array.from({ length: 7 }, () => 100n);
    const c7 = calculateConcentration(balances7);
    expect(c7.top10Concentration).toBe(1);

    // 20 holders with equal balances (50 each = 1000 total) -> top 10 = 500 / 1000 = 0.50
    const balances20: bigint[] = Array.from({ length: 20 }, () => 50n);
    const c20 = calculateConcentration(balances20);
    expect(c20.top10Concentration).toBe(0.5);
  });

  // Scenario 10: Zero address exclusion
  it('10. strictly excludes zero address from holders, senders, receivers, and active holders', () => {
    const prior: MetricTransfer[] = [];
    const day: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 1000n }), // Mint
      makeTransfer({ from: ALICE, to: ZERO_ADDRESS, amount: 200n }),  // Burn
    ];

    const h = calculateHolderMetrics(prior, day);
    const a = calculateActivityMetrics(day);

    expect(h.positiveBalances.has(ZERO_ADDRESS)).toBe(false);
    expect(h.holderCount).toBe(1); // Only ALICE
    expect(a.uniqueSenders).toBe(1); // Only ALICE
    expect(a.uniqueReceivers).toBe(1); // Only ALICE
    expect(a.activeHolders).toBe(1); // Only ALICE
  });

  // Scenario 11: Self-transfer behavior
  it('11. handles self-transfers without inflating new holders or altering net balance', () => {
    const prior: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 100n }),
    ];
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: ALICE, amount: 50n }),
    ];

    const h = calculateHolderMetrics(prior, day);
    const a = calculateActivityMetrics(day);

    expect(h.newHolders).toBe(0); // Alice was already a holder
    expect(h.holderCount).toBe(1);
    expect(h.positiveBalances.get(ALICE)).toBe(100n); // Net balance untouched
    expect(a.transferCount).toBe(1);
    expect(a.uniqueSenders).toBe(1);
    expect(a.uniqueReceivers).toBe(1);
    expect(a.activeHolders).toBe(1);
  });

  // Scenario 12: Multiple transfers by same address on same day
  it('12. deduplicates multiple transfers by the same address on the same day', () => {
    const prior: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 1000n }),
    ];
    const day: MetricTransfer[] = [
      makeTransfer({ from: ALICE, to: BOB, amount: 10n }),
      makeTransfer({ from: ALICE, to: BOB, amount: 20n }),
      makeTransfer({ from: ALICE, to: BOB, amount: 30n }),
      makeTransfer({ from: BOB, to: ALICE, amount: 5n }),
    ];

    const a = calculateActivityMetrics(day);
    const h = calculateHolderMetrics(prior, day);

    expect(a.transferCount).toBe(4);
    expect(a.uniqueSenders).toBe(2); // ALICE, BOB
    expect(a.uniqueReceivers).toBe(2); // BOB, ALICE
    expect(a.activeHolders).toBe(2);
    expect(h.newHolders).toBe(1); // BOB counted as new holder exactly once
  });

  // Scenario 13: Empty-data day
  it('13. handles empty-data days cleanly with 0 activity and preserved historical balances', () => {
    const prior: MetricTransfer[] = [
      makeTransfer({ from: ZERO_ADDRESS, to: ALICE, amount: 500n }),
      makeTransfer({ from: ZERO_ADDRESS, to: BOB, amount: 500n }),
    ];
    const day: MetricTransfer[] = []; // No transfers today

    const m = computeDailyMetricsForTransfers(TOKEN_A, '2026-09-22', prior, day);

    expect(m.transferCount).toBe(0);
    expect(m.activeHolders).toBe(0);
    expect(m.uniqueSenders).toBe(0);
    expect(m.uniqueReceivers).toBe(0);
    expect(m.newHolders).toBe(0);
    expect(m.holderCount).toBe(2); // Historical holders ALICE and BOB preserved
    expect(m.top1Concentration).toBe(0.5);

    // If completely empty history (no prior transfers either):
    const empty = computeDailyMetricsForTransfers(TOKEN_A, '2026-09-22', [], []);
    expect(empty.holderCount).toBe(0);
    expect(empty.top1Concentration).toBeNull();
    expect(empty.top5Concentration).toBeNull();
    expect(empty.top10Concentration).toBeNull();
  });

  // Scenario 14: Upsert / Idempotency
  it('14. upserts daily metrics idempotently using ON CONFLICT DO UPDATE', async () => {
    const recordedQueries: Array<{ text: string; values?: unknown[] | undefined }> = [];
    const mockQueryable = {
      async query(text: string, values?: unknown[]) {
        recordedQueries.push({ text, values });
        return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    const row: DailyMetrics = {
      tokenAddress: TOKEN_A,
      date: '2026-09-22',
      holderCount: 50,
      newHolders: 5,
      activeHolders: 12,
      transferCount: 30,
      uniqueSenders: 8,
      uniqueReceivers: 10,
      top1Concentration: 0.35,
      top5Concentration: 0.75,
      top10Concentration: 0.9,
    };

    // First upsert
    const c1 = await upsertDailyMetrics(mockQueryable, [row]);
    expect(c1).toBe(1);
    expect(recordedQueries[0]?.text).toContain('ON CONFLICT (token_address, date) DO UPDATE SET');

    // Second upsert (same row, simulating rerun)
    const c2 = await upsertDailyMetrics(mockQueryable, [row]);
    expect(c2).toBe(1);
    expect(recordedQueries.length).toBe(2);
    // Both queries target the exact same conflict target
    expect(recordedQueries[1]?.text).toBe(recordedQueries[0]?.text);
  });

  // Scenario 15: UTC date boundary
  it('15. strictly respects UTC date boundaries for transfer attribution', () => {
    const { start: dayStart, end: dayEnd } = getUtcDayBounds('2026-09-22');

    expect(dayStart.toISOString()).toBe('2026-09-22T00:00:00.000Z');
    expect(dayEnd.toISOString()).toBe('2026-09-22T23:59:59.999Z');

    const justBefore = new Date('2026-09-21T23:59:59.999Z');
    const exactlyAtStart = new Date('2026-09-22T00:00:00.000Z');
    const exactlyAtEnd = new Date('2026-09-22T23:59:59.999Z');
    const justAfter = new Date('2026-09-23T00:00:00.000Z');

    expect(justBefore.getTime() < dayStart.getTime()).toBe(true);
    expect(exactlyAtStart.getTime() >= dayStart.getTime() && exactlyAtStart.getTime() <= dayEnd.getTime()).toBe(true);
    expect(exactlyAtEnd.getTime() >= dayStart.getTime() && exactlyAtEnd.getTime() <= dayEnd.getTime()).toBe(true);
    expect(justAfter.getTime() > dayEnd.getTime()).toBe(true);
  });

  // Edge cases: large token supply and ratio precision
  it('handles tokens with arbitrary supplies without floating point overflow', () => {
    // 1 quadrillion tokens with 18 decimals = 10^33 wei
    const quadrillion = 1_000_000_000_000_000n * 10n ** 18n;
    const topHolder = (quadrillion * 42n) / 100n; // 42%

    const r = formatRatio(topHolder, quadrillion);
    expect(r).toBe(0.42);
  });

  // Date validator tests
  it('validates calendar date strings strictly', () => {
    expect(validateDateString('2026-09-22').valid).toBe(true);
    expect(validateDateString('2026-02-29').valid).toBe(false); // 2026 is not a leap year
    expect(validateDateString('2026-13-01').valid).toBe(false); // invalid month
    expect(validateDateString('2026-09-32').valid).toBe(false); // invalid day
    expect(validateDateString('invalid-date').valid).toBe(false);
  });
});
