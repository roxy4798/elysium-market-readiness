/**
 * Phase 5B.0 — Attestation endpoint security gate.
 *
 * Protects POST /v1/assessments/:assessmentId/attest from unauthorized public
 * invocation. The gate is evaluated server-side before any database lookup or
 * attestation-service call, so a rejected request can never reach the signer.
 *
 * Configuration (environment):
 *   ATTESTATION_ENABLED     "true" to allow attestation. Anything else (including unset) = disabled.
 *   ATTESTATION_API_SECRET  Shared server-side bearer secret. Minimum 32 characters.
 *
 * The secret and ATTESTER_PRIVATE_KEY are never echoed in responses or logs.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const MIN_ATTESTATION_SECRET_LENGTH = 32;

export interface AttestationGateConfig {
  enabled: boolean;
  /** Configured bearer secret, or null when unset/blank. */
  secret: string | null;
}

export type AttestationGateResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 503;
      /** Stable machine-readable code returned to the client. */
      code:
        | 'ATTESTATION_DISABLED'
        | 'ATTESTATION_AUTH_NOT_CONFIGURED'
        | 'ATTESTATION_AUTH_REQUIRED'
        | 'ATTESTATION_AUTH_INVALID';
      /** Safe, secret-free message returned to the client. */
      message: string;
    };

/**
 * Reads gate configuration. Attestation is disabled unless ATTESTATION_ENABLED is exactly "true"
 * (case-insensitive, surrounding whitespace ignored).
 */
export function readAttestationGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): AttestationGateConfig {
  const enabled = (env['ATTESTATION_ENABLED'] ?? '').trim().toLowerCase() === 'true';
  const rawSecret = env['ATTESTATION_API_SECRET'];
  const secret = rawSecret && rawSecret.trim() !== '' ? rawSecret.trim() : null;
  return { enabled, secret };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison independent of input lengths. */
function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Decides whether an attestation request may proceed.
 * Order: disabled → server misconfiguration (fail closed) → missing auth → invalid auth.
 */
export function authorizeAttestationRequest(
  req: IncomingMessage,
  config: AttestationGateConfig = readAttestationGateConfig(),
): AttestationGateResult {
  if (!config.enabled) {
    return {
      ok: false,
      status: 403,
      code: 'ATTESTATION_DISABLED',
      message: 'Attestation is disabled on this server',
    };
  }

  if (!config.secret || config.secret.length < MIN_ATTESTATION_SECRET_LENGTH) {
    return {
      ok: false,
      status: 503,
      code: 'ATTESTATION_AUTH_NOT_CONFIGURED',
      message: 'Attestation authentication is not configured on this server',
    };
  }

  const provided = extractBearerToken(req);
  if (provided === null) {
    return {
      ok: false,
      status: 401,
      code: 'ATTESTATION_AUTH_REQUIRED',
      message: 'Missing attestation credentials',
    };
  }

  if (!secretsMatch(provided, config.secret)) {
    return {
      ok: false,
      status: 403,
      code: 'ATTESTATION_AUTH_INVALID',
      message: 'Invalid attestation credentials',
    };
  }

  return { ok: true };
}
