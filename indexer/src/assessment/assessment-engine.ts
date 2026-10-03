/**
 * Market Assessment Coordinator for Phase 2B.
 * Interacts with daily_metrics in PostgreSQL and manages idempotent market_assessments persistence.
 */
import type { Queryable } from '../database.js';
import { loadTokens } from '../metrics/daily-metrics.js';
import {
  calculateAddressActivity,
  calculateConcentrationScore,
  calculateConsistencyScore,
  calculateHealthScore,
  calculateHolderHealth,
  calculateMedian,
  calculateMomentum,
  calculateTransferActivity,
  classifyStatus,
  MIN_HISTORICAL_WINDOW_DAYS,
} from './scoring.js';
import {
  buildCanonicalPayload,
  computeAssessmentHash,
  computeAssessmentId,
  serializeCanonicalAssessment,
} from './canonical.js';
import type { DailyObservation, MarketAssessment } from './types.js';

export * from './types.js';
export * from './scoring.js';
export * from './canonical.js';

/**
 * Pure evaluation function: computes a Market Assessment from daily observations.
 * Strictly prevents historical lookahead leakage by filtering observations strictly before assessmentDate.
 */
export function assessToken(
  tokenAddress: string,
  assessmentDate: string,
  allObservations: readonly DailyObservation[],
): MarketAssessment {
  // Enforce no-lookahead: split strictly into prior observations and assessment date observation
  const prior = allObservations
    .filter((o) => o.date < assessmentDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const current = allObservations.find((o) => o.date === assessmentDate) ?? null;

  // Check minimum 7 completed daily observations prior to assessmentDate
  if (prior.length < MIN_HISTORICAL_WINDOW_DAYS) {
    return {
      tokenAddress: tokenAddress.toLowerCase(),
      assessmentDate,
      healthScore: null,
      status: 'INSUFFICIENT_DATA',
      momentum: null,
      components: null,
      dataWindowDays: prior.length,
      reason: 'INSUFFICIENT_HISTORICAL_WINDOW',
    };
  }

  // Exactly the 7 most recent completed observations immediately preceding assessmentDate
  const prior7 = prior.slice(-7);
  const previousDay = prior7[prior7.length - 1]!;

  // If there are no daily metrics recorded for assessmentDate, assume preserved balances and 0 activity
  const today: DailyObservation = current ?? {
    date: assessmentDate,
    holderCount: previousDay.holderCount,
    newHolders: 0,
    activeHolders: 0,
    transferCount: 0,
    top1Concentration: previousDay.top1Concentration,
    top5Concentration: previousDay.top5Concentration,
    top10Concentration: previousDay.top10Concentration,
  };

  const holderHealth = calculateHolderHealth(today.newHolders, previousDay.holderCount);
  if (holderHealth === null) {
    return {
      tokenAddress: tokenAddress.toLowerCase(),
      assessmentDate,
      healthScore: null,
      status: 'INSUFFICIENT_DATA',
      momentum: null,
      components: null,
      dataWindowDays: prior7.length,
      reason: 'UNAVAILABLE_HOLDER_BASELINE',
    };
  }

  const medianTransfers = calculateMedian(prior7.map((o) => o.transferCount));
  const transferActivity = calculateTransferActivity(today.transferCount, medianTransfers);

  const medianActive = calculateMedian(prior7.map((o) => o.activeHolders));
  const addressActivity = calculateAddressActivity(today.activeHolders, medianActive);

  const concentrationScore = calculateConcentrationScore(
    today.top1Concentration,
    today.top5Concentration,
    today.top10Concentration,
  );

  const consistencyScore = calculateConsistencyScore(prior7);

  const components = {
    holderHealth,
    transferActivity,
    addressActivity,
    concentrationScore,
    consistencyScore,
  };

  const healthScore = calculateHealthScore(components);
  const status = classifyStatus(healthScore);
  const momentum = calculateMomentum(today, prior7);

  const baseAssessment = {
    tokenAddress: tokenAddress.toLowerCase(),
    assessmentDate,
    healthScore,
    status,
    momentum,
    components,
    dataWindowDays: prior7.length,
    reason: null,
  };

  const canonicalPayload = buildCanonicalPayload(baseAssessment);
  const assessmentId = computeAssessmentId(
    canonicalPayload.schema_version,
    canonicalPayload.methodology_version,
    canonicalPayload.token_address,
    canonicalPayload.assessment_date,
  );
  const serialized = serializeCanonicalAssessment(canonicalPayload);
  const assessmentHash = computeAssessmentHash(serialized);

  return {
    ...baseAssessment,
    assessmentId,
    schemaVersion: canonicalPayload.schema_version,
    methodologyVersion: canonicalPayload.methodology_version,
    assessmentHash,
    canonicalPayload,
  };
}

/**
 * Loads daily observations for a specific token up to the specified date.
 */
export async function loadObservationsForToken(
  q: Queryable,
  tokenAddress: string,
  upToDateInclusive: string,
): Promise<DailyObservation[]> {
  const res = await q.query<{
    date: Date | string;
    holder_count: number;
    new_holders: number;
    active_holders: number;
    transfer_count: number;
    top1_concentration: string | null;
    top5_concentration: string | null;
    top10_concentration: string | null;
  }>(
    `SELECT
       date::text as date,
       holder_count,
       new_holders,
       active_holders,
       transfer_count,
       top1_concentration,
       top5_concentration,
       top10_concentration
     FROM daily_metrics
     WHERE token_address = LOWER($1)
       AND date <= $2::date
     ORDER BY date ASC`,
    [tokenAddress, upToDateInclusive],
  );

  return res.rows.map((r) => {
    const dateStr = typeof r.date === 'string' ? r.date.slice(0, 10) : (r.date as Date).toISOString().slice(0, 10);
    return {
      date: dateStr,
      holderCount: Number(r.holder_count),
      newHolders: Number(r.new_holders),
      activeHolders: Number(r.active_holders),
      transferCount: Number(r.transfer_count),
      top1Concentration: r.top1_concentration !== null ? Number(r.top1_concentration) : null,
      top5Concentration: r.top5_concentration !== null ? Number(r.top5_concentration) : null,
      top10Concentration: r.top10_concentration !== null ? Number(r.top10_concentration) : null,
    };
  });
}

/**
 * Idempotently upserts an assessment row into the market_assessments table.
 */
export async function upsertMarketAssessment(
  q: Queryable,
  a: MarketAssessment,
): Promise<void> {
  await q.query(
    `INSERT INTO market_assessments (
       token_address,
       assessment_date,
       health_score,
       status,
       momentum,
       holder_health,
       transfer_activity,
       address_activity,
       concentration_score,
       consistency_score,
       data_window_days,
       reason,
       assessment_id,
       schema_version,
       methodology_version,
       assessment_hash,
       updated_at
     )
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
     ON CONFLICT (token_address, assessment_date) DO UPDATE SET
       health_score = EXCLUDED.health_score,
       status = EXCLUDED.status,
       momentum = EXCLUDED.momentum,
       holder_health = EXCLUDED.holder_health,
       transfer_activity = EXCLUDED.transfer_activity,
       address_activity = EXCLUDED.address_activity,
       concentration_score = EXCLUDED.concentration_score,
       consistency_score = EXCLUDED.consistency_score,
       data_window_days = EXCLUDED.data_window_days,
       reason = EXCLUDED.reason,
       assessment_id = EXCLUDED.assessment_id,
       schema_version = EXCLUDED.schema_version,
       methodology_version = EXCLUDED.methodology_version,
       assessment_hash = EXCLUDED.assessment_hash,
       updated_at = NOW()`,
    [
      a.tokenAddress,
      a.assessmentDate,
      a.healthScore !== null ? a.healthScore : null,
      a.status,
      a.momentum !== null ? a.momentum : null,
      a.components?.holderHealth ?? null,
      a.components?.transferActivity ?? null,
      a.components?.addressActivity ?? null,
      a.components?.concentrationScore ?? null,
      a.components?.consistencyScore ?? null,
      a.dataWindowDays,
      a.reason,
      a.assessmentId ?? null,
      a.schemaVersion ?? null,
      a.methodologyVersion ?? null,
      a.assessmentHash ?? null,
    ],
  );
}

/**
 * Runs assessment for all tokens (or filtered token) for a specific date and persists results.
 */
export async function runAssessmentsForDate(
  q: Queryable,
  date: string,
  tokenFilter?: string,
): Promise<MarketAssessment[]> {
  const tokens = await loadTokens(q, tokenFilter);
  const results: MarketAssessment[] = [];

  for (const token of tokens) {
    const observations = await loadObservationsForToken(q, token.address, date);
    const assessment = assessToken(token.address, date, observations);
    await upsertMarketAssessment(q, assessment);
    results.push(assessment);
  }

  return results;
}
