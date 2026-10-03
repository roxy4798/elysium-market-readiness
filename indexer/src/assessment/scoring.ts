/**
 * Pure scoring and assessment logic for Phase 2B.
 * Deterministic mathematical mappings for Health Score V1 and Market Momentum.
 */
import type { AssessmentComponents, DailyObservation, MarketStatus } from './types.js';

export const MIN_HISTORICAL_WINDOW_DAYS = 7;

/**
 * Piecewise linear interpolation across monotonically increasing anchor points: [[x0, y0], [x1, y1], ...].
 * Clamps output between min(y) and max(y).
 */
export function interpolate(
  x: number,
  anchors: ReadonlyArray<readonly [number, number]>,
): number {
  if (anchors.length === 0) return 0;
  if (x <= anchors[0]![0]) return anchors[0]![1];
  const last = anchors[anchors.length - 1]!;
  if (x >= last[0]) return last[1];

  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i]!;
    const [x1, y1] = anchors[i + 1]!;
    if (x >= x0 && x <= x1) {
      if (x1 === x0) return y0;
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }

  return last[1];
}

/**
 * Calculates Holder Health (0–100):
 * Ratio = new_holders / previous_holder_count.
 * Anchors:
 *   0%   -> 0
 *   5%   -> 25
 *   10%  -> 50
 *   20%  -> 75
 *   30%+ -> 100
 */
export const HOLDER_HEALTH_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0],
  [0.05, 25],
  [0.10, 50],
  [0.20, 75],
  [0.30, 100],
];

export function calculateHolderHealth(
  newHolders: number,
  previousHolderCount: number | null,
): number | null {
  if (previousHolderCount === null || previousHolderCount <= 0) {
    return null; // Baseline unavailable
  }

  const growth = Math.max(0, newHolders / previousHolderCount);
  const score = interpolate(growth, HOLDER_HEALTH_ANCHORS);
  return Math.min(100, Math.max(0, score));
}

/**
 * Calculates median of an array of numbers.
 */
export function calculateMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Activity ratio anchors used for both Transfer Activity and Address Activity:
 *   0.0x -> 0
 *   0.5x -> 25
 *   1.0x -> 50
 *   2.0x -> 75
 *   3.0x+ -> 100
 */
export const ACTIVITY_RATIO_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0],
  [0.5, 25],
  [1.0, 50],
  [2.0, 75],
  [3.0, 100],
];

/**
 * Calculates Transfer Activity score (0–100):
 * Ratio = today_transfer_count / median_7d_transfer_count.
 */
export function calculateTransferActivity(
  todayTransfers: number,
  median7dTransfers: number,
): number {
  if (median7dTransfers <= 0) {
    return todayTransfers > 0 ? 100 : 50;
  }
  const ratio = Math.max(0, todayTransfers / median7dTransfers);
  return Math.min(100, Math.max(0, interpolate(ratio, ACTIVITY_RATIO_ANCHORS)));
}

/**
 * Calculates Address Activity score (0–100):
 * Ratio = today_active_holders / median_7d_active_holders.
 */
export function calculateAddressActivity(
  todayActiveHolders: number,
  median7dActiveHolders: number,
): number {
  if (median7dActiveHolders <= 0) {
    return todayActiveHolders > 0 ? 100 : 50;
  }
  const ratio = Math.max(0, todayActiveHolders / median7dActiveHolders);
  return Math.min(100, Math.max(0, interpolate(ratio, ACTIVITY_RATIO_ANCHORS)));
}

/**
 * Calculates Onchain Holder Concentration score (0–100):
 * Risk = 0.50 * top1 + 0.30 * top5 + 0.20 * top10
 * Score = 100 * (1 - Risk), clamped to [0, 100].
 */
export function calculateConcentrationScore(
  top1: number | null,
  top5: number | null,
  top10: number | null,
): number {
  if (top1 === null && top5 === null && top10 === null) {
    return 0; // No holders or supply
  }

  const t1 = Math.min(1, Math.max(0, top1 ?? 1));
  const t5 = Math.min(1, Math.max(0, top5 ?? 1));
  const t10 = Math.min(1, Math.max(0, top10 ?? 1));

  const risk = 0.50 * t1 + 0.30 * t5 + 0.20 * t10;
  const score = 100 * (1 - risk);
  return Math.min(100, Math.max(0, score));
}

/**
 * Calculates Activity Consistency score (0–100):
 * Percentage of the previous 7 daily observations with transfer_count > 0.
 */
export function calculateConsistencyScore(
  prior7Observations: readonly DailyObservation[],
): number {
  if (prior7Observations.length === 0) return 0;
  let activeDays = 0;
  for (const obs of prior7Observations) {
    if (obs.transferCount > 0) activeDays++;
  }
  const score = (activeDays / prior7Observations.length) * 100;
  return Math.min(100, Math.max(0, score));
}

/**
 * Calculates Final Health Score (0–100):
 *   Holder Health        25%
 *   Transfer Activity    25%
 *   Address Activity     20%
 *   Holder Concentration 20%
 *   Activity Consistency 10%
 */
export function calculateHealthScore(components: AssessmentComponents): number {
  const score =
    components.holderHealth * 0.25 +
    components.transferActivity * 0.25 +
    components.addressActivity * 0.20 +
    components.concentrationScore * 0.20 +
    components.consistencyScore * 0.10;

  return Math.min(100, Math.max(0, score));
}

/**
 * Classifies Health Score into exact categorical Market Status:
 *   0–39   EARLY
 *   40–59  BUILDING
 *   60–74  DEVELOPING
 *   75–89  MATURE
 *   90–100 READY
 */
export function classifyStatus(healthScore: number): MarketStatus {
  // Using rounded integer comparison to strictly honor boundaries
  const rounded = Math.round(healthScore);
  if (rounded < 40) return 'EARLY';
  if (rounded < 60) return 'BUILDING';
  if (rounded < 75) return 'DEVELOPING';
  if (rounded < 90) return 'MATURE';
  return 'READY';
}

/**
 * Maps an activity ratio (current / 7d median) to normalized momentum [-100, +100]:
 *   0.0x -> -100
 *   0.5x -> -50
 *   1.0x -> 0
 *   2.0x -> +50
 *   3.0x+ -> +100
 */
export function normalizeDimensionMomentum(current: number, median: number): number {
  if (median <= 0) {
    return current > 0 ? 100 : 0;
  }
  const ratio = current / median;
  if (ratio <= 0) return -100;
  if (ratio <= 1.0) {
    // [0, 1] -> [-100, 0]
    return (ratio - 1.0) * 100;
  }
  if (ratio <= 3.0) {
    // (1, 3] -> (0, 100]
    return ((ratio - 1.0) / 2.0) * 100;
  }
  return 100;
}

/**
 * Calculates Market Momentum (-100 to +100):
 * Average relative activity change across 3 dimensions:
 * - transfer_count
 * - active_holders
 * - new_holders
 * Normalized to -100 (weakening) to +100 (strengthening).
 */
export function calculateMomentum(
  current: DailyObservation,
  prior7Observations: readonly DailyObservation[],
): number {
  const medianTransfers = calculateMedian(prior7Observations.map((o) => o.transferCount));
  const medianActive = calculateMedian(prior7Observations.map((o) => o.activeHolders));
  const medianNew = calculateMedian(prior7Observations.map((o) => o.newHolders));

  const momTransfers = normalizeDimensionMomentum(current.transferCount, medianTransfers);
  const momActive = normalizeDimensionMomentum(current.activeHolders, medianActive);
  const momNew = normalizeDimensionMomentum(current.newHolders, medianNew);

  const combined = (momTransfers + momActive + momNew) / 3;
  return Math.min(100, Math.max(-100, combined));
}
