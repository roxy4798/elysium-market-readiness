/**
 * Data structures and types for Phase 2A Daily Raw Market Metrics.
 * Deterministic onchain metrics derived from indexed ERC-20 transfers.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface MetricTransfer {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly blockTimestamp: Date;
  readonly blockNumber: bigint;
  readonly txHash?: string;
  readonly logIndex?: number;
}

export interface ActivityMetrics {
  readonly transferCount: number;
  readonly uniqueSenders: number;
  readonly uniqueReceivers: number;
  readonly activeHolders: number;
}

export interface HolderMetrics {
  readonly holderCount: number;
  readonly newHolders: number;
  readonly positiveBalances: Map<string, bigint>;
}

export interface ConcentrationMetrics {
  readonly top1Concentration: number | null;
  readonly top5Concentration: number | null;
  readonly top10Concentration: number | null;
}

export interface DailyMetrics {
  readonly tokenAddress: string;
  readonly date: string; // ISO calendar date YYYY-MM-DD (UTC)
  readonly holderCount: number;
  readonly newHolders: number;
  readonly activeHolders: number;
  readonly transferCount: number;
  readonly uniqueSenders: number;
  readonly uniqueReceivers: number;
  readonly top1Concentration: number | null;
  readonly top5Concentration: number | null;
  readonly top10Concentration: number | null;
}

export interface TokenInfo {
  readonly address: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
}
