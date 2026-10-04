/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 5B.0 — Attestation endpoint security gate tests.
 *
 * The attestation service is replaced with a spy so these tests can prove that rejected
 * requests never reach the signer (no transaction can be submitted), while authorized
 * requests do. verifyAssessment stays real to prove GET /verify is unaffected by the gate.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import type { Queryable } from '../src/database.js';
import type { CanonicalAssessmentPayload } from '../src/assessment/types.js';
import {
  computeAssessmentHash,
  computeAssessmentId,
  serializeCanonicalAssessment,
} from '../src/assessment/canonical.js';

const attestSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/attestation/attestation-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/attestation/attestation-service.js')>();
  return { ...actual, attestAssessment: attestSpy };
});

// Imported after vi.mock so the server uses the spy.
const { createApiServer } = await import('../src/api/server.js');
const {
  authorizeAttestationRequest,
  readAttestationGateConfig,
  MIN_ATTESTATION_SECRET_LENGTH,
} = await import('../src/api/attestation-auth.js');

const SECRET = 'phase5b0-gate-secret-abcdefghijklmnopqrstuvwxyz';
const DUMMY_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204db7e716b78ac5c78273082fe39cfbe85';
const DUMMY_CONTRACT = '0x1234567890123456789012345678901234567890';

const payload: CanonicalAssessmentPayload = {
  schema_version: '1.0',
  methodology_version: 'health-v1',
  token_address: '0x245bfe8c6c2429f6a7743d53377ae39b98500459',
  assessment_date: '2026-10-03',
  health_score: 34,
  momentum: 4.5,
  status: 'EARLY',
  holder_health: 0,
  transfer_activity: 52.61,
  address_activity: 54.14,
  concentration_score: 0.1,
  consistency_score: 100,
  data_window_days: 7,
};
const ASSESSMENT_ID = computeAssessmentId(
  payload.schema_version,
  payload.methodology_version,
  payload.token_address,
  payload.assessment_date,
);
const ASSESSMENT_HASH = computeAssessmentHash(serializeCanonicalAssessment(payload));

const dbQueries: string[] = [];
const mockDb: Queryable = {
  async query(sql: string): Promise<any> {
    dbQueries.push(sql);
    if (/FROM market_assessments/i.test(sql)) {
      return {
        rows: [{
          token_address: payload.token_address,
          assessment_date: payload.assessment_date,
          health_score: String(payload.health_score),
          status: payload.status,
          momentum: String(payload.momentum),
          holder_health: String(payload.holder_health),
          transfer_activity: String(payload.transfer_activity),
          address_activity: String(payload.address_activity),
          concentration_score: String(payload.concentration_score),
          consistency_score: String(payload.consistency_score),
          data_window_days: payload.data_window_days,
          assessment_id: ASSESSMENT_ID,
          schema_version: payload.schema_version,
          methodology_version: payload.methodology_version,
          assessment_hash: ASSESSMENT_HASH,
        }],
      };
    }
    return { rows: [] };
  },
};

const ENV_KEYS = [
  'ATTESTATION_ENABLED',
  'ATTESTATION_API_SECRET',
  'ATTESTER_PRIVATE_KEY',
  'ATTESTATION_CONTRACT_ADDRESS',
] as const;

let server: Server;
let baseUrl = '';
let logged: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function attest(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/v1/assessments/${ASSESSMENT_ID}/attest`, { method: 'POST', headers });
}

function fakeReq(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createApiServer(mockDb);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  attestSpy.mockReset();
  attestSpy.mockResolvedValue({
    assessment_id: ASSESSMENT_ID,
    transaction_hash: '0x' + 'ab'.repeat(32),
    contract_address: DUMMY_CONTRACT,
    chain_id: 99801,
    block_number: 1,
    attester: '0xa8037A207be9e525798Fad10037aF982367d3419',
    assessment_hash: ASSESSMENT_HASH,
  });
  dbQueries.length = 0;
  logged = [];
  const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  // A signer and contract are configured in every test, so only the gate can stop a transaction.
  process.env['ATTESTER_PRIVATE_KEY'] = DUMMY_PRIVATE_KEY;
  process.env['ATTESTATION_CONTRACT_ADDRESS'] = DUMMY_CONTRACT;
  process.env['ATTESTATION_API_SECRET'] = SECRET;
  delete process.env['ATTESTATION_ENABLED'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase 5B.0 — gate configuration', () => {
  it('defaults to disabled when ATTESTATION_ENABLED is unset or not "true"', () => {
    expect(readAttestationGateConfig({}).enabled).toBe(false);
    for (const v of ['', 'false', '0', '1', 'yes', 'enabled', 'truee']) {
      expect(readAttestationGateConfig({ ATTESTATION_ENABLED: v }).enabled).toBe(false);
    }
    expect(readAttestationGateConfig({ ATTESTATION_ENABLED: 'true' }).enabled).toBe(true);
    expect(readAttestationGateConfig({ ATTESTATION_ENABLED: ' TRUE ' }).enabled).toBe(true);
  });

  it('treats a blank secret as unset', () => {
    expect(readAttestationGateConfig({ ATTESTATION_API_SECRET: '   ' }).secret).toBeNull();
  });

  it('fails closed when enabled without a sufficiently long secret', () => {
    const short = 'x'.repeat(MIN_ATTESTATION_SECRET_LENGTH - 1);
    for (const secret of [null, short]) {
      const r = authorizeAttestationRequest(fakeReq(`Bearer ${short}`), { enabled: true, secret });
      expect(r).toMatchObject({ ok: false, status: 503, code: 'ATTESTATION_AUTH_NOT_CONFIGURED' });
    }
  });

  it('accepts only an exact bearer match', () => {
    const cfg = { enabled: true, secret: SECRET };
    expect(authorizeAttestationRequest(fakeReq(`Bearer ${SECRET}`), cfg).ok).toBe(true);
    expect(authorizeAttestationRequest(fakeReq(`bearer ${SECRET}`), cfg).ok).toBe(true);
    expect(authorizeAttestationRequest(fakeReq(SECRET), cfg)).toMatchObject({ status: 401 });
    expect(authorizeAttestationRequest(fakeReq(`Basic ${SECRET}`), cfg)).toMatchObject({ status: 401 });
    expect(authorizeAttestationRequest(fakeReq(`Bearer ${SECRET}x`), cfg)).toMatchObject({ status: 403 });
    expect(authorizeAttestationRequest(fakeReq(`Bearer ${SECRET.slice(0, -1)}`), cfg)).toMatchObject({ status: 403 });
  });
});

describe('Phase 5B.0 — POST /v1/assessments/:id/attest gate', () => {
  it('refuses when attestation is disabled (default), even with valid credentials, and submits no transaction', async () => {
    const res = await attest({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'ATTESTATION_DISABLED',
      message: 'Attestation is disabled on this server',
    });
    expect(attestSpy).not.toHaveBeenCalled();
    expect(dbQueries).toHaveLength(0);
  });

  it('refuses when ATTESTATION_ENABLED=false explicitly', async () => {
    process.env['ATTESTATION_ENABLED'] = 'false';
    const res = await attest({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(403);
    expect(attestSpy).not.toHaveBeenCalled();
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 503 when enabled but no secret is configured', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    delete process.env['ATTESTATION_API_SECRET'];
    const res = await attest({ Authorization: 'Bearer anything-at-all-0123456789abcdef' });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toBe('ATTESTATION_AUTH_NOT_CONFIGURED');
    expect(attestSpy).not.toHaveBeenCalled();
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 401 with WWW-Authenticate when credentials are missing', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    const res = await attest();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json() as any).error).toBe('ATTESTATION_AUTH_REQUIRED');
    expect(attestSpy).not.toHaveBeenCalled();
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 403 when credentials are invalid', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    for (const token of ['wrong-secret', `${SECRET}-extra`, SECRET.toUpperCase()]) {
      const res = await attest({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(403);
      expect((await res.json() as any).error).toBe('ATTESTATION_AUTH_INVALID');
    }
    expect(attestSpy).not.toHaveBeenCalled();
    expect(dbQueries).toHaveLength(0);
  });

  it('does not reveal assessment existence or ID validity to unauthenticated callers', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    const res = await fetch(`${baseUrl}/v1/assessments/not-a-valid-id/attest`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(dbQueries).toHaveLength(0);
  });

  it('forwards an authorized request to the attestation service exactly once', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    const res = await attest({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(attestSpy).toHaveBeenCalledTimes(1);
    expect(attestSpy.mock.calls[0]![1]).toBe(ASSESSMENT_ID);
    expect((await res.json() as any).assessment_id).toBe(ASSESSMENT_ID);
  });

  it('never leaks the API secret or private key in responses or logs', async () => {
    const bodies: string[] = [];
    process.env['ATTESTATION_ENABLED'] = 'false';
    bodies.push(await (await attest({ Authorization: `Bearer ${SECRET}` })).text());
    process.env['ATTESTATION_ENABLED'] = 'true';
    bodies.push(await (await attest()).text());
    bodies.push(await (await attest({ Authorization: `Bearer ${SECRET.slice(0, -1)}` })).text());
    // Downstream failure path: service throws an error; the generic 500 must stay sanitized.
    attestSpy.mockRejectedValueOnce(new Error('signer exploded'));
    bodies.push(await (await attest({ Authorization: `Bearer ${SECRET}` })).text());

    const haystack = [...bodies, ...logged].join('\n');
    for (const secret of [SECRET, SECRET.slice(0, -1), DUMMY_PRIVATE_KEY, DUMMY_PRIVATE_KEY.slice(2)]) {
      expect(haystack).not.toContain(secret);
    }
    expect(logged.some((l) => l.includes('attestation request rejected'))).toBe(true);
  });
});

describe('Phase 5B.0 — verification remains public and unchanged', () => {
  it('GET /verify needs no credentials and still reports canonical validity', async () => {
    delete process.env['ATTESTATION_CONTRACT_ADDRESS'];
    const res = await fetch(`${baseUrl}/v1/assessments/${ASSESSMENT_ID}/verify`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      assessment_id: ASSESSMENT_ID,
      valid: true,
      canonical_valid: true,
      onchain_attested: false,
      onchain_data_matches: false,
      assessment_hash: ASSESSMENT_HASH,
      onchain: { configured: false },
    });
    expect(attestSpy).not.toHaveBeenCalled();
  });
});
