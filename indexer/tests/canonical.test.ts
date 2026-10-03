/**
 * Phase 3A — Canonical Assessment, Deterministic Identity, Hashing & Verification API Tests.
 * Covers all 20 required deterministic test cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Queryable } from '../src/database.js';
import {
  buildCanonicalPayload,
  computeAssessmentHash,
  computeAssessmentId,
  CURRENT_METHODOLOGY_VERSION,
  CURRENT_SCHEMA_VERSION,
  serializeCanonicalAssessment,
  verifyCanonicalAssessment,
} from '../src/assessment/canonical.js';
import type { CanonicalAssessmentPayload, DailyObservation, MarketAssessment } from '../src/assessment/types.js';
import { assessToken, upsertMarketAssessment } from '../src/assessment/assessment-engine.js';
import { createApiServer } from '../src/api/server.js';

const TOKEN_A = '0x7d29d8047b905000459c0e80c34a26ceedcb47b2';
const TOKEN_B = '0x548b43d400cbe3f85cb00f606486291206485036';

function samplePayload(overrides: Partial<CanonicalAssessmentPayload> = {}): CanonicalAssessmentPayload {
  return {
    schema_version: '1.0',
    methodology_version: 'health-v1',
    token_address: TOKEN_A.toLowerCase(),
    assessment_date: '2026-09-22',
    health_score: 66.5,
    momentum: 42.0,
    status: 'DEVELOPING',
    holder_health: 70.0,
    transfer_activity: 80.0,
    address_activity: 65.0,
    concentration_score: 40.0,
    consistency_score: 90.0,
    data_window_days: 7,
    ...overrides,
  };
}

describe('Phase 3A — Canonical Serialization & Identity (Tests 1–14)', () => {
  // 1. canonical serialization
  it('1. serializes canonical assessment payload to deterministic JSON string', () => {
    const payload = samplePayload();
    const serialized = serializeCanonicalAssessment(payload);
    expect(typeof serialized).toBe('string');
    expect(serialized.startsWith('{')).toBe(true);
    expect(serialized.endsWith('}')).toBe(true);

    // Verify it parses as valid JSON
    const parsed = JSON.parse(serialized);
    expect(parsed.schema_version).toBe('1.0');
    expect(parsed.methodology_version).toBe('health-v1');
    expect(parsed.token_address).toBe(TOKEN_A.toLowerCase());
    expect(parsed.health_score).toBe(66.5);
  });

  // 2. serialization field order
  it('2. enforces strict, fixed field order in canonical serialization', () => {
    const payload = samplePayload();
    const serialized = serializeCanonicalAssessment(payload);

    const expectedKeys = [
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
    ];

    let lastIndex = -1;
    for (const key of expectedKeys) {
      const idx = serialized.indexOf(`"${key}":`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  // 3. fixed numeric precision
  it('3. formats scores with fixed decimal precision (2 decimal places) and integer window', () => {
    const payload = samplePayload({
      health_score: 66.5,
      momentum: 42,
      holder_health: 70.123456,
      data_window_days: 7.0,
    });
    const serialized = serializeCanonicalAssessment(payload);

    expect(serialized).toContain('"health_score":66.50');
    expect(serialized).toContain('"momentum":42.00');
    expect(serialized).toContain('"holder_health":70.12');
    expect(serialized).toContain('"data_window_days":7');
  });

  // 4. same input -> same assessment ID
  it('4. produces identical assessment ID for identical canonical identity inputs', () => {
    const id1 = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-22');
    const id2 = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-22');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // 5. same input -> same hash
  it('5. produces identical SHA-256 hash for identical canonical payload', () => {
    const payload1 = samplePayload();
    const payload2 = samplePayload();
    const hash1 = computeAssessmentHash(serializeCanonicalAssessment(payload1));
    const hash2 = computeAssessmentHash(serializeCanonicalAssessment(payload2));
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // 6. changed token -> changed ID
  it('6. generates different assessment ID when token address changes', () => {
    const idA = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-22');
    const idB = computeAssessmentId('1.0', 'health-v1', TOKEN_B, '2026-09-22');
    expect(idA).not.toBe(idB);
  });

  // 7. changed date -> changed ID
  it('7. generates different assessment ID when assessment date changes', () => {
    const id1 = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-22');
    const id2 = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-23');
    expect(id1).not.toBe(id2);
  });

  // 8. changed methodology version -> changed ID
  it('8. generates different assessment ID when methodology version changes', () => {
    const idV1 = computeAssessmentId('1.0', 'health-v1', TOKEN_A, '2026-09-22');
    const idV2 = computeAssessmentId('1.0', 'health-v2', TOKEN_A, '2026-09-22');
    expect(idV1).not.toBe(idV2);
  });

  // 9. changed score -> changed hash
  it('9. generates different SHA-256 hash when any score component changes', () => {
    const base = samplePayload({ health_score: 66.5 });
    const changed = samplePayload({ health_score: 66.6 });

    const hashBase = computeAssessmentHash(serializeCanonicalAssessment(base));
    const hashChanged = computeAssessmentHash(serializeCanonicalAssessment(changed));
    expect(hashBase).not.toBe(hashChanged);
  });

  // 10. address normalization
  it('10. normalizes mixed-case or uppercase address so assessment ID is case-insensitive', () => {
    const mixed = '0x7D29D8047B905000459c0e80c34a26ceedcb47b2';
    const lower = mixed.toLowerCase();

    const idMixed = computeAssessmentId('1.0', 'health-v1', mixed, '2026-09-22');
    const idLower = computeAssessmentId('1.0', 'health-v1', lower, '2026-09-22');
    expect(idMixed).toBe(idLower);

    const payloadMixed = samplePayload({ token_address: mixed });
    const payloadLower = samplePayload({ token_address: lower });
    expect(serializeCanonicalAssessment(payloadMixed)).toBe(serializeCanonicalAssessment(payloadLower));
  });

  // 11. verification success
  it('11. verifies untampered assessment payload successfully against stored ID and hash', () => {
    const payload = samplePayload();
    const id = computeAssessmentId(payload.schema_version, payload.methodology_version, payload.token_address, payload.assessment_date);
    const hash = computeAssessmentHash(serializeCanonicalAssessment(payload));

    const result = verifyCanonicalAssessment(payload, id, hash);
    expect(result.valid).toBe(true);
    expect(result.idMatches).toBe(true);
    expect(result.hashMatches).toBe(true);
  });

  // 12. verification detects tampered score
  it('12. detects tampered score component and reports valid=false', () => {
    const legitimate = samplePayload({ health_score: 66.5 });
    const id = computeAssessmentId(legitimate.schema_version, legitimate.methodology_version, legitimate.token_address, legitimate.assessment_date);
    const hash = computeAssessmentHash(serializeCanonicalAssessment(legitimate));

    // Attacker modifies health_score to 95.0
    const tampered = { ...legitimate, health_score: 95.0 };
    const result = verifyCanonicalAssessment(tampered, id, hash);

    expect(result.valid).toBe(false);
    expect(result.idMatches).toBe(true); // Identity unchanged
    expect(result.hashMatches).toBe(false); // Hash mismatch detected!
  });

  // 13. verification detects tampered hash
  it('13. detects tampered assessment hash and reports valid=false', () => {
    const payload = samplePayload();
    const id = computeAssessmentId(payload.schema_version, payload.methodology_version, payload.token_address, payload.assessment_date);
    const tamperedHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    const result = verifyCanonicalAssessment(payload, id, tamperedHash);
    expect(result.valid).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  // 14. repeated assessment generation is idempotent
  it('14. ensures repeated assessment generation is 100% deterministic and idempotent', () => {
    const observations: DailyObservation[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      holderCount: 100 + i,
      newHolders: 5,
      activeHolders: 20,
      transferCount: 50,
      top1Concentration: 0.3,
      top5Concentration: 0.6,
      top10Concentration: 0.8,
    }));

    const a1 = assessToken(TOKEN_A, '2026-09-08', observations);
    const a2 = assessToken(TOKEN_A, '2026-09-08', observations);

    expect(a1.assessmentId).toBeDefined();
    expect(a1.assessmentHash).toBeDefined();
    expect(a1.assessmentId).toBe(a2.assessmentId);
    expect(a1.assessmentHash).toBe(a2.assessmentHash);
    expect(a1.healthScore).toBe(a2.healthScore);
    expect(a1.momentum).toBe(a2.momentum);
  });
});

describe('Phase 3A — REST API Endpoints (Tests 15–20)', () => {
  let server: Server;
  let baseUrl: string;

  // In-memory test database backing the API
  const tokenTable = new Map<string, { address: string; name: string; symbol: string }>();
  const assessmentTable = new Map<string, any>();
  const dailyMetricsTable: Array<{
    token_address: string;
    date: string;
    holder_count: number;
    new_holders: number;
    active_holders: number;
    transfer_count: number;
    top1_concentration: string | null;
    top5_concentration: string | null;
    top10_concentration: string | null;
  }> = [];

  const mockDb: Queryable = {
    async query(sql: string, params: any[] = []): Promise<any> {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      // SELECT address, name, symbol FROM tokens WHERE address = LOWER($1)
      if (normalizedSql.includes('FROM tokens WHERE address = LOWER($1)')) {
        const addr = String(params[0]).toLowerCase();
        const tok = tokenTable.get(addr);
        return { rows: tok ? [tok] : [] };
      }

      // SELECT ... FROM market_assessments WHERE token_address = LOWER($1) AND assessment_date = $2::date
      if (normalizedSql.includes('FROM market_assessments WHERE token_address = LOWER($1) AND assessment_date = $2::date')) {
        const addr = String(params[0]).toLowerCase();
        const date = String(params[1]).slice(0, 10);
        const a = assessmentTable.get(`${addr}:${date}`);
        return { rows: a ? [a] : [] };
      }

      // SELECT ... FROM market_assessments WHERE LOWER(assessment_id) = LOWER($1)
      if (normalizedSql.includes('FROM market_assessments WHERE LOWER(assessment_id) = LOWER($1)')) {
        const id = String(params[0]).toLowerCase();
        for (const a of assessmentTable.values()) {
          if (a.assessment_id && a.assessment_id.toLowerCase() === id) {
            return { rows: [a] };
          }
        }
        return { rows: [] };
      }

      // SELECT ... FROM daily_metrics WHERE token_address = LOWER($1) AND date <= $2::date
      if (normalizedSql.includes('FROM daily_metrics WHERE token_address = LOWER($1)')) {
        const addr = String(params[0]).toLowerCase();
        const date = String(params[1]).slice(0, 10);
        const rows = dailyMetricsTable
          .filter((m) => m.token_address === addr && m.date <= date)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return { rows };
      }

      // INSERT INTO market_assessments
      if (normalizedSql.startsWith('INSERT INTO market_assessments')) {
        const addr = String(params[0]).toLowerCase();
        const date = String(params[1]).slice(0, 10);
        const record = {
          token_address: addr,
          assessment_date: date,
          health_score: params[2],
          status: params[3],
          momentum: params[4],
          holder_health: params[5],
          transfer_activity: params[6],
          address_activity: params[7],
          concentration_score: params[8],
          consistency_score: params[9],
          data_window_days: params[10],
          reason: params[11],
          assessment_id: params[12],
          schema_version: params[13],
          methodology_version: params[14],
          assessment_hash: params[15],
        };
        assessmentTable.set(`${addr}:${date}`, record);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };

  beforeAll(async () => {
    // Seed Token A with 8 days history
    tokenTable.set(TOKEN_A.toLowerCase(), { address: TOKEN_A.toLowerCase(), name: 'USDC', symbol: 'USDC' });
    for (let i = 1; i <= 8; i++) {
      dailyMetricsTable.push({
        token_address: TOKEN_A.toLowerCase(),
        date: `2026-09-0${i}`,
        holder_count: 100 + i,
        new_holders: 5,
        active_holders: 20,
        transfer_count: 50,
        top1_concentration: '0.30',
        top5_concentration: '0.60',
        top10_concentration: '0.80',
      });
    }

    // Seed Token B with only 3 days history (insufficient data)
    tokenTable.set(TOKEN_B.toLowerCase(), { address: TOKEN_B.toLowerCase(), name: 'EBT', symbol: 'EBT' });
    for (let i = 1; i <= 3; i++) {
      dailyMetricsTable.push({
        token_address: TOKEN_B.toLowerCase(),
        date: `2026-09-0${i}`,
        holder_count: 10,
        new_holders: 1,
        active_holders: 2,
        transfer_count: 3,
        top1_concentration: '0.50',
        top5_concentration: '0.80',
        top10_concentration: '1.00',
      });
    }

    server = createApiServer(mockDb);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // 15. invalid Ethereum address
  it('15. returns HTTP 400 when requesting with invalid Ethereum address', async () => {
    const res = await fetch(`${baseUrl}/v1/tokens/invalid-address/assessment?date=2026-09-08`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Invalid Ethereum address format');
  });

  // 16. invalid date
  it('16. returns HTTP 400 when requesting with invalid date format', async () => {
    const res = await fetch(`${baseUrl}/v1/tokens/${TOKEN_A}/assessment?date=not-a-date`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Invalid date');
  });

  // 17. insufficient-data response
  it('17. returns HTTP 422 when token has insufficient historical data (< 7 days)', async () => {
    const res = await fetch(`${baseUrl}/v1/tokens/${TOKEN_B}/assessment?date=2026-09-03`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error).toBe('INSUFFICIENT_DATA');
    expect(body.reason).toBe('INSUFFICIENT_HISTORICAL_WINDOW');
    expect(body.data_window_days).toBeLessThan(7);
  });

  // 18. API successful assessment response
  it('18. returns HTTP 200 with complete canonical assessment schema for valid token', async () => {
    const res = await fetch(`${baseUrl}/v1/tokens/${TOKEN_A}/assessment?date=2026-09-08`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.assessment_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.schema_version).toBe('1.0');
    expect(body.methodology_version).toBe('health-v1');
    expect(body.token.address).toBe(TOKEN_A.toLowerCase());
    expect(body.token.symbol).toBe('USDC');
    expect(body.assessment_date).toBe('2026-09-08');
    expect(typeof body.health_score).toBe('number');
    expect(typeof body.momentum).toBe('number');
    expect(typeof body.status).toBe('string');
    expect(body.components.holder_health).toBeDefined();
    expect(body.components.transfer_activity).toBeDefined();
    expect(body.components.address_activity).toBeDefined();
    expect(body.components.concentration_score).toBeDefined();
    expect(body.components.consistency_score).toBeDefined();
    expect(body.data_window_days).toBe(7);
    expect(body.assessment_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // 19. API 404
  it('19. returns HTTP 404 when requested token does not exist in registry', async () => {
    const nonExistent = '0x0000000000000000000000000000000000000001';
    const res = await fetch(`${baseUrl}/v1/tokens/${nonExistent}/assessment?date=2026-09-08`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toContain('not found');
  });

  // 20. API verification response
  it('20. verifies assessment by ID via GET /v1/assessments/:id/verify returning valid=true', async () => {
    // First, obtain valid assessment
    const assessRes = await fetch(`${baseUrl}/v1/tokens/${TOKEN_A}/assessment?date=2026-09-08`);
    expect(assessRes.status).toBe(200);
    const assessBody = (await assessRes.json()) as any;
    const assessmentId = assessBody.assessment_id;

    // Verify it via verification endpoint
    const verifyRes = await fetch(`${baseUrl}/v1/assessments/${assessmentId}/verify`);
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as any;

    expect(verifyBody.assessment_id).toBe(assessmentId);
    expect(verifyBody.valid).toBe(true);
    expect(verifyBody.assessment_hash).toBe(assessBody.assessment_hash);
    expect(verifyBody.methodology_version).toBe('health-v1');
  });
});
