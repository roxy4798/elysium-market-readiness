/**
 * Onchain holder concentration metrics:
 * - top1_concentration = top 1 holder balance / total tracked positive balance
 * - top5_concentration = sum of top 5 holder balances / total tracked positive balance
 * - top10_concentration = sum of top 10 holder balances / total tracked positive balance
 *
 * Values are stored as decimal ratios between 0 and 1 (e.g. 0.25 = 25%).
 * Calculated strictly using BigInt arithmetic to prevent IEEE 754 precision loss.
 */
import type { ConcentrationMetrics } from './types.js';

/**
 * Calculates decimal ratio as a float between 0 and 1, rounded to specified decimal places.
 * Uses integer math with scaling to maintain 100% precision with arbitrary token supplies.
 */
export function formatRatio(numerator: bigint, denominator: bigint, scale = 6): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  if (numerator >= denominator) return 1;

  const factor = 10n ** BigInt(scale);
  // Scale by 10 for rounding the last digit (half-up)
  const scaled = (numerator * factor * 10n) / denominator;
  const rounded = (scaled + 5n) / 10n;
  return Number(rounded) / Number(factor);
}

export function calculateConcentration(
  balances: ReadonlyMap<string, bigint> | readonly bigint[],
): ConcentrationMetrics {
  const values: bigint[] = [];

  if (Array.isArray(balances)) {
    for (const bal of balances) {
      if (bal > 0n) values.push(bal);
    }
  } else {
    for (const bal of balances.values()) {
      if (bal > 0n) values.push(bal);
    }
  }

  if (values.length === 0) {
    return {
      top1Concentration: null,
      top5Concentration: null,
      top10Concentration: null,
    };
  }

  // Sort descending by balance
  values.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  let total = 0n;
  for (const v of values) total += v;

  if (total <= 0n) {
    return {
      top1Concentration: null,
      top5Concentration: null,
      top10Concentration: null,
    };
  }

  const top1Sum = values[0] ?? 0n;

  let top5Sum = 0n;
  const top5Limit = Math.min(5, values.length);
  for (let i = 0; i < top5Limit; i++) top5Sum += values[i] ?? 0n;

  let top10Sum = 0n;
  const top10Limit = Math.min(10, values.length);
  for (let i = 0; i < top10Limit; i++) top10Sum += values[i] ?? 0n;

  return {
    top1Concentration: formatRatio(top1Sum, total),
    top5Concentration: formatRatio(top5Sum, total),
    top10Concentration: formatRatio(top10Sum, total),
  };
}
