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

export interface CanonicalAssessmentPayload {
  readonly schema_version: '1.0';
  readonly methodology_version: 'health-v1';
  readonly token_address: string;
  readonly assessment_date: string;
  readonly health_score: number;
  readonly momentum: number;
  readonly status: MarketStatus;
  readonly holder_health: number;
  readonly transfer_activity: number;
  readonly address_activity: number;
  readonly concentration_score: number;
  readonly consistency_score: number;
  readonly data_window_days: number;
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
  readonly assessmentId?: string | null;
  readonly schemaVersion?: string | null;
  readonly methodologyVersion?: string | null;
  readonly assessmentHash?: string | null;
  readonly canonicalPayload?: CanonicalAssessmentPayload | null;
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
