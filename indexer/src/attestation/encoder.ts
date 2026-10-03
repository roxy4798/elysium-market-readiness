/**
 * Deterministic Encoding and Conversion Utilities for Phase 3B Onchain Attestation.
 */
import { hexToString, isAddress, stringToHex, trim } from 'viem';
import type { CanonicalAssessmentPayload } from '../assessment/types.js';
import type { AttestationArgs } from './types.js';

/**
 * Converts a UTC calendar date string (YYYY-MM-DD) into a deterministic UTC midnight Unix timestamp in seconds.
 * Throws an error if the format is invalid or timezone-dependent.
 */
export function dateToUtcMidnightTimestamp(dateStr: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format "${dateStr}". Expected YYYY-MM-DD.`);
  }

  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid calendar date values in "${dateStr}".`);
  }

  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const sec = Math.floor(utcMs / 1000);

  if (sec <= 0) {
    throw new Error(`Date timestamp must be positive, got ${sec}`);
  }

  return BigInt(sec);
}

/**
 * Converts a UTC midnight Unix timestamp (seconds) back into a YYYY-MM-DD calendar date string.
 */
export function utcMidnightTimestampToDate(timestamp: bigint | number): string {
  const tsNum = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
  const d = new Date(tsNum * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Converts a methodology version string (e.g. "health-v1") into bytes32.
 * Pads with trailing zeros to exactly 32 bytes (same as Solidity `bytes32("health-v1")`).
 */
export function methodologyToBytes32(methodology: string): `0x${string}` {
  if (!methodology || methodology.trim() === '') {
    throw new Error('Methodology version cannot be empty');
  }
  const utf8Bytes = Buffer.from(methodology, 'utf8');
  if (utf8Bytes.length > 32) {
    throw new Error(`Methodology version exceeds 32 bytes (${utf8Bytes.length} bytes)`);
  }
  return stringToHex(methodology, { size: 32 });
}

/**
 * Decodes a bytes32 hex value back into a UTF-8 methodology version string.
 */
export function bytes32ToMethodology(bytes32Hex: `0x${string}`): string {
  const trimmed = trim(bytes32Hex, { dir: 'right' });
  return hexToString(trimmed);
}

/**
 * Converts an assessment SHA-256 hash into bytes32.
 * Preserves the exact 32 bytes without re-hashing.
 */
export function hashToBytes32(assessmentHash: string): `0x${string}` {
  const clean = assessmentHash.startsWith('0x') ? assessmentHash.slice(2) : assessmentHash;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`Invalid assessment hash: expected 64 hex characters, got "${assessmentHash}"`);
  }
  return `0x${clean.toLowerCase()}` as `0x${string}`;
}

/**
 * Converts an assessment ID into bytes32.
 * Preserves the Keccak-256 identifier.
 */
export function assessmentIdToBytes32(assessmentId: string): `0x${string}` {
  const clean = assessmentId.startsWith('0x') ? assessmentId.slice(2) : assessmentId;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`Invalid assessment ID: expected 64 hex characters, got "${assessmentId}"`);
  }
  return `0x${clean.toLowerCase()}` as `0x${string}`;
}

/**
 * Encodes a verified canonical assessment payload and identity values into AttestationArgs for smart contract calls.
 */
export function encodeAttestationArgs(
  payload: CanonicalAssessmentPayload,
  assessmentId: string,
  assessmentHash: string,
): AttestationArgs {
  if (!isAddress(payload.token_address)) {
    throw new Error(`Invalid token address in payload: "${payload.token_address}"`);
  }

  return {
    assessmentId: assessmentIdToBytes32(assessmentId),
    assessmentHash: hashToBytes32(assessmentHash),
    token: payload.token_address.toLowerCase() as `0x${string}`,
    assessmentDate: dateToUtcMidnightTimestamp(payload.assessment_date),
    methodologyVersion: methodologyToBytes32(payload.methodology_version),
  };
}
