/**
 * Deterministic Canonical Assessment Serialization, Identity & Hashing for Phase 3A.
 */
import { createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import type { CanonicalAssessmentPayload, MarketAssessment } from './types.js';

export const CURRENT_SCHEMA_VERSION = '1.0';
export const CURRENT_METHODOLOGY_VERSION = 'health-v1';

export const CANONICAL_FIELD_ORDER = [
  'schema_version',
  'methodology_version',
  'token_address',
  'assessment_date',
  'health_score',
  'momentum',
  'status',
  'holder_health',
  'transfer_activity',
  'address_activity',
  'concentration_score',
  'consistency_score',
  'data_window_days',
] as const;

/**
 * Computes deterministic assessment ID:
 * assessment_id = keccak256(schema_version:methodology_version:token_address:assessment_date)
 * Address is normalized to lowercase before hashing.
 */
export function computeAssessmentId(
  schemaVersion: string,
  methodologyVersion: string,
  tokenAddress: string,
  assessmentDate: string,
): `0x${string}` {
  const normalizedAddress = tokenAddress.toLowerCase();
  const identityString = `${schemaVersion}:${methodologyVersion}:${normalizedAddress}:${assessmentDate}`;
  return keccak256(toHex(identityString));
}

/**
 * Builds canonical payload from a valid MarketAssessment.
 * Throws an error if the assessment has insufficient data or missing scores.
 */
export function buildCanonicalPayload(
  assessment: MarketAssessment,
  schemaVersion: '1.0' = CURRENT_SCHEMA_VERSION,
  methodologyVersion: 'health-v1' = CURRENT_METHODOLOGY_VERSION,
): CanonicalAssessmentPayload {
  if (
    assessment.healthScore === null ||
    assessment.momentum === null ||
    assessment.components === null ||
    assessment.status === 'INSUFFICIENT_DATA'
  ) {
    throw new Error('Cannot construct canonical assessment payload for INSUFFICIENT_DATA');
  }

  return {
    schema_version: schemaVersion,
    methodology_version: methodologyVersion,
    token_address: assessment.tokenAddress.toLowerCase(),
    assessment_date: assessment.assessmentDate,
    health_score: assessment.healthScore,
    momentum: assessment.momentum,
    status: assessment.status,
    holder_health: assessment.components.holderHealth,
    transfer_activity: assessment.components.transferActivity,
    address_activity: assessment.components.addressActivity,
    concentration_score: assessment.components.concentrationScore,
    consistency_score: assessment.components.consistencyScore,
    data_window_days: assessment.dataWindowDays,
  };
}

/**
 * Deterministically serializes a canonical assessment payload into a JSON string.
 * Strictly adheres to CANONICAL_FIELD_ORDER and fixed 2-decimal precision for numeric scores.
 * Does NOT rely on JavaScript object key iteration order.
 */
export function serializeCanonicalAssessment(payload: CanonicalAssessmentPayload): string {
  const parts = [
    `"schema_version":${JSON.stringify(payload.schema_version)}`,
    `"methodology_version":${JSON.stringify(payload.methodology_version)}`,
    `"token_address":${JSON.stringify(payload.token_address.toLowerCase())}`,
    `"assessment_date":${JSON.stringify(payload.assessment_date)}`,
    `"health_score":${payload.health_score.toFixed(2)}`,
    `"momentum":${payload.momentum.toFixed(2)}`,
    `"status":${JSON.stringify(payload.status)}`,
    `"holder_health":${payload.holder_health.toFixed(2)}`,
    `"transfer_activity":${payload.transfer_activity.toFixed(2)}`,
    `"address_activity":${payload.address_activity.toFixed(2)}`,
    `"concentration_score":${payload.concentration_score.toFixed(2)}`,
    `"consistency_score":${payload.consistency_score.toFixed(2)}`,
    `"data_window_days":${Math.round(payload.data_window_days)}`,
  ];

  return `{${parts.join(',')}}`;
}

/**
 * Calculates SHA-256 hash of canonical serialized assessment.
 * Returns lowercase hex string (64 characters).
 */
export function computeAssessmentHash(serializedCanonical: string): string {
  return createHash('sha256').update(serializedCanonical, 'utf8').digest('hex').toLowerCase();
}

/**
 * Verifies a stored canonical assessment against its identity ID and hash.
 */
export function verifyCanonicalAssessment(
  payload: CanonicalAssessmentPayload,
  storedAssessmentId: string,
  storedAssessmentHash: string,
): {
  valid: boolean;
  computedId: string;
  computedHash: string;
  idMatches: boolean;
  hashMatches: boolean;
} {
  const computedId = computeAssessmentId(
    payload.schema_version,
    payload.methodology_version,
    payload.token_address,
    payload.assessment_date,
  );
  const serialized = serializeCanonicalAssessment(payload);
  const computedHash = computeAssessmentHash(serialized);

  const idMatches = computedId.toLowerCase() === storedAssessmentId.toLowerCase();
  const hashMatches = computedHash.toLowerCase() === storedAssessmentHash.toLowerCase();

  return {
    valid: idMatches && hashMatches,
    computedId,
    computedHash,
    idMatches,
    hashMatches,
  };
}
