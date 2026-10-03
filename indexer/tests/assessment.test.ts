/**
 * Deterministic unit tests for Phase 2B — Health Score V1 & Market Momentum.
 * Covers all 20 required audit scenarios.
 */
import { describe, expect, it } from 'vitest';
import {
  assessToken,
  calculateAddressActivity,
  calculateConcentrationScore,
  calculateConsistencyScore,
  calculateHealthScore,
  calculateHolderHealth,
  calculateMedian,
  calculateMomentum,
  calculateTransferActivity,
  classifyStatus,
  interpolate,
  normalizeDimensionMomentum,
  upsertMarketAssessment,
} from '../src/assessment/assessment-engine.js';
import type { DailyObservation, MarketAssessment } from '../src/assessment/types.js';

const TOKEN_A = '0x1111111111111111111111111111111111111111';

function makeObservation(overrides: Partial<DailyObservation> = {}): DailyObservation {
  return {
    date: '2026-09-20',
    holderCount: 100,
    newHolders: 10,
    activeHolders: 20,
    transferCount: 50,
    top1Concentration: 0.3,
    top5Concentration: 0.6,
    top10Concentration: 0.8,
    ...overrides,
  };
}

describe('Phase 2B — Market Health Score V1 & Momentum Assessment', () => {
  // Test 1: holder growth anchors
  it('1. matches exact holder growth anchor points: 0%->0, 5%->25, 10%->50, 20%->75, 30%+->100', () => {
    const prev = 100;
    expect(calculateHolderHealth(0, prev)).toBe(0);
    expect(calculateHolderHealth(5, prev)).toBe(25);
    expect(calculateHolderHealth(10, prev)).toBe(50);
    expect(calculateHolderHealth(20, prev)).toBe(75);
    expect(calculateHolderHealth(30, prev)).toBe(100);
    expect(calculateHolderHealth(50, prev)).toBe(100); // capped at 100
  });

  // Test 2: holder growth interpolation
  it('2. performs linear interpolation between holder growth anchors', () => {
    const prev = 100;
    // Between 0% (0) and 5% (25): 2.5% should be 12.5
    expect(calculateHolderHealth(2.5, prev)).toBeCloseTo(12.5, 4);
    // Between 5% (25) and 10% (50): 7.5% should be 37.5
    expect(calculateHolderHealth(7.5, prev)).toBeCloseTo(37.5, 4);
    // Between 10% (50) and 20% (75): 15% should be 62.5
    expect(calculateHolderHealth(15, prev)).toBeCloseTo(62.5, 4);
    // Between 20% (75) and 30% (100): 25% should be 87.5
    expect(calculateHolderHealth(25, prev)).toBeCloseTo(87.5, 4);
  });

  // Test 3: transfer activity anchors
  it('3. matches exact transfer activity anchors: 0.0x->0, 0.5x->25, 1.0x->50, 2.0x->75, 3.0x+->100', () => {
    const median = 100;
    expect(calculateTransferActivity(0, median)).toBe(0);
    expect(calculateTransferActivity(50, median)).toBe(25);
    expect(calculateTransferActivity(100, median)).toBe(50);
    expect(calculateTransferActivity(200, median)).toBe(75);
    expect(calculateTransferActivity(300, median)).toBe(100);
    expect(calculateTransferActivity(500, median)).toBe(100); // capped at 100
  });

  // Test 4: transfer activity interpolation
  it('4. performs linear interpolation between transfer activity anchors', () => {
    const median = 100;
    // 0.25x -> halfway between 0 and 25 = 12.5
    expect(calculateTransferActivity(25, median)).toBeCloseTo(12.5, 4);
    // 0.75x -> halfway between 25 and 50 = 37.5
    expect(calculateTransferActivity(75, median)).toBeCloseTo(37.5, 4);
    // 1.5x -> halfway between 50 and 75 = 62.5
    expect(calculateTransferActivity(150, median)).toBeCloseTo(62.5, 4);
    // 2.5x -> halfway between 75 and 100 = 87.5
    expect(calculateTransferActivity(250, median)).toBeCloseTo(87.5, 4);
  });

  // Test 5: address activity anchors
  it('5. matches exact address activity anchors and clamps at 100', () => {
    const median = 50;
    expect(calculateAddressActivity(0, median)).toBe(0);
    expect(calculateAddressActivity(25, median)).toBe(25);
    expect(calculateAddressActivity(50, median)).toBe(50);
    expect(calculateAddressActivity(100, median)).toBe(75);
    expect(calculateAddressActivity(150, median)).toBe(100);
    expect(calculateAddressActivity(200, median)).toBe(100);
  });

  // Test 6: concentration calculation
  it('6. calculates concentration score as 100 * (1 - (0.50*top1 + 0.30*top5 + 0.20*top10))', () => {
    // Risk = 0.50*0.4 + 0.30*0.7 + 0.20*0.9 = 0.20 + 0.21 + 0.18 = 0.59
    // Score = 100 * (1 - 0.59) = 41.0
    const score = calculateConcentrationScore(0.4, 0.7, 0.9);
    expect(score).toBeCloseTo(41.0, 4);
  });

  // Test 7: concentration clamp
  it('7. clamps concentration score strictly to [0, 100]', () => {
    // Maximum concentration: 100% in top1 (1.0, 1.0, 1.0) -> Risk = 1.0 -> Score = 0
    expect(calculateConcentrationScore(1.0, 1.0, 1.0)).toBe(0);
    // Theoretical minimum: 0% concentration -> Risk = 0 -> Score = 100
    expect(calculateConcentrationScore(0.0, 0.0, 0.0)).toBe(100);
    // Out-of-bounds input clamped:
    expect(calculateConcentrationScore(1.5, 1.5, 1.5)).toBe(0);
  });

  // Test 8: consistency 0/7
  it('8. calculates consistency score 0/7 active days as 0.0', () => {
    const prior7: DailyObservation[] = Array.from({ length: 7 }, (_, i) =>
      makeObservation({ date: `2026-09-0${i + 1}`, transferCount: 0 }),
    );
    expect(calculateConsistencyScore(prior7)).toBe(0);
  });

  // Test 9: consistency 7/7
  it('9. calculates consistency score 7/7 active days as 100.0', () => {
    const prior7: DailyObservation[] = Array.from({ length: 7 }, (_, i) =>
      makeObservation({ date: `2026-09-0${i + 1}`, transferCount: 10 }),
    );
    expect(calculateConsistencyScore(prior7)).toBe(100);
  });

  // Test 10: insufficient historical data
  it('10. returns INSUFFICIENT_DATA and null scores when fewer than 7 historical observations exist', () => {
    // Only 4 prior days
    const prior4: DailyObservation[] = Array.from({ length: 4 }, (_, i) =>
      makeObservation({ date: `2026-09-0${i + 1}` }),
    );
    const today = makeObservation({ date: '2026-09-05' });

    const assessment = assessToken(TOKEN_A, '2026-09-05', [...prior4, today]);
    expect(assessment.status).toBe('INSUFFICIENT_DATA');
    expect(assessment.healthScore).toBeNull();
    expect(assessment.momentum).toBeNull();
    expect(assessment.components).toBeNull();
    expect(assessment.reason).toBe('INSUFFICIENT_HISTORICAL_WINDOW');
    expect(assessment.dataWindowDays).toBe(4);
  });

  // Test 11: status boundaries
  it('11. strictly respects status boundaries: 0-39 EARLY, 40-59 BUILDING, 60-74 DEVELOPING, 75-89 MATURE, 90-100 READY', () => {
    expect(classifyStatus(0)).toBe('EARLY');
    expect(classifyStatus(39)).toBe('EARLY');
    expect(classifyStatus(59)).toBe('BUILDING');
    expect(classifyStatus(74)).toBe('DEVELOPING');
    expect(classifyStatus(89)).toBe('MATURE');
    expect(classifyStatus(100)).toBe('READY');
  });

  // Test 12: exact 40 = BUILDING
  it('12. classifies exact score 40 as BUILDING', () => {
    expect(classifyStatus(40)).toBe('BUILDING');
  });

  // Test 13: exact 60 = DEVELOPING
  it('13. classifies exact score 60 as DEVELOPING', () => {
    expect(classifyStatus(60)).toBe('DEVELOPING');
  });

  // Test 14: exact 75 = MATURE
  it('14. classifies exact score 75 as MATURE', () => {
    expect(classifyStatus(75)).toBe('MATURE');
  });

  // Test 15: exact 90 = READY
  it('15. classifies exact score 90 as READY', () => {
    expect(classifyStatus(90)).toBe('READY');
  });

  // Test 16: historical lookahead prevention
  it('16. strictly prevents future data from leaking into past assessment calculations', () => {
    const prior7: DailyObservation[] = [
      makeObservation({ date: '2026-09-10', transferCount: 10 }),
      makeObservation({ date: '2026-09-11', transferCount: 10 }),
      makeObservation({ date: '2026-09-12', transferCount: 10 }),
      makeObservation({ date: '2026-09-13', transferCount: 10 }),
      makeObservation({ date: '2026-09-14', transferCount: 10 }),
      makeObservation({ date: '2026-09-15', transferCount: 10 }),
      makeObservation({ date: '2026-09-16', transferCount: 10 }),
    ];
    const today = makeObservation({ date: '2026-09-17', transferCount: 10 });
    // Future observation that must be completely ignored
    const future = makeObservation({ date: '2026-09-18', transferCount: 1000000 });

    const assessWithoutFuture = assessToken(TOKEN_A, '2026-09-17', [...prior7, today]);
    const assessWithFuture = assessToken(TOKEN_A, '2026-09-17', [...prior7, today, future]);

    expect(assessWithFuture.healthScore).toEqual(assessWithoutFuture.healthScore);
    expect(assessWithFuture.components).toEqual(assessWithoutFuture.components);
    expect(assessWithFuture.momentum).toEqual(assessWithoutFuture.momentum);
  });

  // Test 17: idempotent assessment generation
  it('17. upserts assessments idempotently using ON CONFLICT DO UPDATE', async () => {
    const recordedQueries: Array<{ text: string; values?: unknown[] | undefined }> = [];
    const mockQueryable = {
      async query(text: string, values?: unknown[]) {
        recordedQueries.push({ text, values });
        return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      },
    };

    const assessment: MarketAssessment = {
      tokenAddress: TOKEN_A,
      assessmentDate: '2026-09-22',
      healthScore: 66.5,
      status: 'DEVELOPING',
      momentum: 42.0,
      components: {
        holderHealth: 70,
        transferActivity: 80,
        addressActivity: 65,
        concentrationScore: 40,
        consistencyScore: 90,
      },
      dataWindowDays: 7,
      reason: null,
    };

    // First upsert
    await upsertMarketAssessment(mockQueryable, assessment);
    // Second upsert (rerun)
    await upsertMarketAssessment(mockQueryable, assessment);

    expect(recordedQueries.length).toBe(2);
    expect(recordedQueries[0]?.text).toContain('ON CONFLICT (token_address, assessment_date) DO UPDATE SET');
    expect(recordedQueries[1]?.text).toBe(recordedQueries[0]?.text);
  });

  // Test 18: momentum negative
  it('18. returns negative momentum when current activity drops significantly below 7d baseline', () => {
    const prior7: DailyObservation[] = Array.from({ length: 7 }, (_, i) =>
      makeObservation({
        date: `2026-09-0${i + 1}`,
        transferCount: 100,
        activeHolders: 50,
        newHolders: 10,
      }),
    );
    // Current day activity collapsed to 0
    const today = makeObservation({
      date: '2026-09-08',
      transferCount: 0,
      activeHolders: 0,
      newHolders: 0,
    });

    const m = calculateMomentum(today, prior7);
    expect(m).toBe(-100);
    expect(m).toBeLessThan(0);
  });

  // Test 19: momentum neutral
  it('19. returns neutral momentum (0.0) when current activity exactly matches 7d baseline', () => {
    const prior7: DailyObservation[] = Array.from({ length: 7 }, (_, i) =>
      makeObservation({
        date: `2026-09-0${i + 1}`,
        transferCount: 100,
        activeHolders: 50,
        newHolders: 10,
      }),
    );
    // Current day activity exactly matches median
    const today = makeObservation({
      date: '2026-09-08',
      transferCount: 100,
      activeHolders: 50,
      newHolders: 10,
    });

    const m = calculateMomentum(today, prior7);
    expect(m).toBe(0);
  });

  // Test 20: momentum positive
  it('20. returns positive momentum when current activity surges above 7d baseline', () => {
    const prior7: DailyObservation[] = Array.from({ length: 7 }, (_, i) =>
      makeObservation({
        date: `2026-09-0${i + 1}`,
        transferCount: 50,
        activeHolders: 20,
        newHolders: 5,
      }),
    );
    // Current day activity surges (triples or more)
    const today = makeObservation({
      date: '2026-09-08',
      transferCount: 150,
      activeHolders: 60,
      newHolders: 15,
    });

    const m = calculateMomentum(today, prior7);
    expect(m).toBe(100);
    expect(m).toBeGreaterThan(0);
  });

  // Component weights verification
  it('verifies exact 25/25/20/20/10 component weighting', () => {
    const components = {
      holderHealth: 100,
      transferActivity: 0,
      addressActivity: 0,
      concentrationScore: 0,
      consistencyScore: 0,
    };
    expect(calculateHealthScore(components)).toBe(25);

    const comp2 = { ...components, holderHealth: 0, transferActivity: 100 };
    expect(calculateHealthScore(comp2)).toBe(25);

    const comp3 = { ...components, holderHealth: 0, addressActivity: 100 };
    expect(calculateHealthScore(comp3)).toBe(20);

    const comp4 = { ...components, holderHealth: 0, concentrationScore: 100 };
    expect(calculateHealthScore(comp4)).toBe(20);

    const comp5 = { ...components, holderHealth: 0, consistencyScore: 100 };
    expect(calculateHealthScore(comp5)).toBe(10);
  });
});
