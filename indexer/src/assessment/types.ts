/**
 * Types and interfaces for Phase 2B — Market Health Score V1 & Momentum Assessment.
 * Deterministic assessment layer on top of daily_metrics.
 */

export type MarketStatus =
  | 'EARLY'
  | 'BUILDING'
  | 'DEVELOPING'
  | 'MATURE'
  | 'READY'
  | 'INSUFFICIENT_DATA';

export interface AssessmentComponents {
  readonly holderHealth: number;
  readonly transferActivity: number;
  readonly addressActivity: number;
  readonly concentrationScore: number;
  readonly consistencyScore: number;
}

export interface MarketAssessment {
  readonly tokenAddress: string;
  readonly assessmentDate: string; // YYYY-MM-DD
  readonly healthScore: number | null;
  readonly status: MarketStatus;
  readonly momentum: number | null;
  readonly components: AssessmentComponents | null;
  readonly dataWindowDays: number;
  readonly reason: string | null;
}

export interface DailyObservation {
  readonly date: string;
  readonly holderCount: number;
  readonly newHolders: number;
  readonly activeHolders: number;
  readonly transferCount: number;
  readonly top1Concentration: number | null;
  readonly top5Concentration: number | null;
  readonly top10Concentration: number | null;
}
