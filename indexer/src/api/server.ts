/**
 * Phase 3A — Verification & REST API Server.
 * Lightweight, production-quality HTTP server using node:http.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAddress } from 'viem';
import type { Queryable } from '../database.js';
import { validateDateString } from '../metrics/daily-metrics.js';
import {
  CURRENT_METHODOLOGY_VERSION,
  CURRENT_SCHEMA_VERSION,
} from '../assessment/canonical.js';
import {
  attestAssessment,
  verifyAssessment,
  AssessmentInsufficientDataError,
  AssessmentNotFoundError,
  AttestationConfigError,
  AttestationConflictError,
  CanonicalVerificationError,
} from '../attestation/attestation-service.js';
import { logger } from '../logger.js';
import { ELYSIUM_TESTNET_CHAIN_ID } from '../config.js';
import { authorizeAttestationRequest } from './attestation-auth.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function pagination(url: URL): { page: number; limit: number; offset: number } | null {
  const rawPage = url.searchParams.get('page') ?? '1';
  const rawLimit = url.searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE);
  if (!/^\d+$/.test(rawPage) || !/^\d+$/.test(rawLimit)) return null;
  const page = Number(rawPage);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) return null;
  const boundedLimit = Math.min(limit, MAX_PAGE_SIZE);
  const offset = (page - 1) * boundedLimit;
  if (!Number.isSafeInteger(offset)) return null;
  return { page, limit: boundedLimit, offset };
}

function dateFilters(url: URL): { from: string | null; to: string | null } | null {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  for (const date of [from, to]) {
    if (date !== null && !validateDateString(date).valid) return null;
  }
  if (from && to && from > to) return null;
  return { from, to };
}

function canonicalAssessment(row: Record<string, unknown>) {
  return {
    assessment_id: row.assessment_id,
    schema_version: row.schema_version ?? CURRENT_SCHEMA_VERSION,
    methodology_version: row.methodology_version ?? CURRENT_METHODOLOGY_VERSION,
    token: { address: row.token_address, symbol: row.symbol ?? row.name ?? row.token_address },
    assessment_date: row.assessment_date,
    health_score: row.health_score === null ? null : Number(row.health_score),
    momentum: row.momentum === null ? null : Number(row.momentum),
    status: row.status,
    components: {
      holder_health: row.holder_health === null ? null : Number(row.holder_health),
      transfer_activity: row.transfer_activity === null ? null : Number(row.transfer_activity),
      address_activity: row.address_activity === null ? null : Number(row.address_activity),
      concentration_score: row.concentration_score === null ? null : Number(row.concentration_score),
      consistency_score: row.consistency_score === null ? null : Number(row.consistency_score),
    },
    data_window_days: Number(row.data_window_days),
    assessment_hash: row.assessment_hash,
  };
}

export interface ServerOptions {
  port?: number;
  host?: string;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

/**
 * Handles incoming HTTP requests for Phase 3A & 3B API.
 */
export async function handleRequest(
  pool: Queryable,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  try {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    // Health check
    if (pathname === '/health' || pathname === '/v1/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Dashboard token discovery: one query obtains each token and its latest persisted assessment.
    if (pathname === '/v1/tokens' && req.method === 'GET') {
      const page = pagination(parsedUrl);
      if (!page) { sendError(res, 400, 'Invalid page or limit'); return; }
      const result = await pool.query<Record<string, unknown>>(
        `SELECT t.address, t.symbol, t.name, t.decimals, t.total_supply::text AS total_supply,
                a.assessment_date::text AS latest_assessment_date, a.health_score, a.momentum, a.status
         FROM tokens t
         LEFT JOIN LATERAL (
           SELECT assessment_date, health_score, momentum, status FROM market_assessments
           WHERE token_address = t.address ORDER BY assessment_date DESC LIMIT 1
         ) a ON TRUE
         ORDER BY t.address ASC LIMIT $1 OFFSET $2`, [page.limit, page.offset]);
      const count = await pool.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM tokens');
      sendJson(res, 200, { tokens: result.rows.map((r) => ({
        address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals,
        total_supply: r.total_supply, latest_assessment_date: r.latest_assessment_date,
        health_score: r.health_score === null ? null : Number(r.health_score),
        momentum: r.momentum === null ? null : Number(r.momentum), status: r.status,
      })), page: page.page, limit: page.limit, total: Number(count.rows[0]?.total ?? 0) });
      return;
    }

    const dashboardRoute = /^\/v1\/tokens\/([^/]+)\/(overview|assessments|metrics|momentum)\/?$/.exec(pathname);
    if (dashboardRoute && req.method === 'GET') {
      const rawAddress = dashboardRoute[1]!;
      if (!isAddress(rawAddress)) { sendError(res, 400, 'Invalid Ethereum address format'); return; }
      const address = rawAddress.toLowerCase();
      const route = dashboardRoute[2]!;
      const tokenResult = await pool.query<Record<string, unknown>>(
        'SELECT address, name, symbol, decimals, total_supply::text AS total_supply FROM tokens WHERE address = $1 LIMIT 1', [address]);
      if (!tokenResult.rows.length) { sendError(res, 404, 'Token not found'); return; }
      const token = tokenResult.rows[0]!;

      if (route === 'overview') {
        const assessmentResult = await pool.query<Record<string, unknown>>(
          `SELECT a.token_address, a.assessment_date::text AS assessment_date, a.health_score, a.momentum, a.status,
                  a.holder_health, a.transfer_activity, a.address_activity, a.concentration_score, a.consistency_score,
                  a.data_window_days, a.assessment_id, a.schema_version, a.methodology_version, a.assessment_hash,
                  t.name, t.symbol
           FROM market_assessments a JOIN tokens t ON t.address = a.token_address
           WHERE a.token_address = $1 ORDER BY a.assessment_date DESC LIMIT 1`, [address]);
        const metricResult = await pool.query<Record<string, unknown>>(
          `SELECT date::text AS date, holder_count, new_holders, active_holders, transfer_count,
                unique_senders, unique_receivers, top1_concentration, top5_concentration, top10_concentration
           FROM daily_metrics WHERE token_address = $1 ORDER BY date DESC LIMIT 1`, [address]);
        const assessment = assessmentResult.rows[0] ? canonicalAssessment({ ...assessmentResult.rows[0], token_address: address }) : null;
        const configuredContract = process.env['ATTESTATION_CONTRACT_ADDRESS'];
        const isConfigured = Boolean(configuredContract && isAddress(configuredContract));
        let attestation: Record<string, unknown> = { configured: isConfigured, attested: false, data_matches: false,
          contract_address: isConfigured ? configuredContract : null, chain_id: Number(process.env['CHAIN_ID'] ?? ELYSIUM_TESTNET_CHAIN_ID),
          transaction_hash: null, block_number: null };
        if (assessmentResult.rows[0]?.assessment_id) {
          const saved = await pool.query<Record<string, unknown>>(
            `SELECT contract_address, chain_id, transaction_hash, block_number FROM assessment_attestations WHERE LOWER(assessment_id)=LOWER($1) LIMIT 1`,
            [assessmentResult.rows[0].assessment_id]);
          if (saved.rows[0]) {
            attestation = { ...attestation, attested: true, contract_address: saved.rows[0].contract_address,
              chain_id: Number(saved.rows[0].chain_id), transaction_hash: saved.rows[0].transaction_hash, block_number: Number(saved.rows[0].block_number) };
            if (isConfigured) {
              try {
                const check = await verifyAssessment(pool, String(assessmentResult.rows[0].assessment_id));
                attestation.data_matches = check.onchain_attested ? check.onchain_data_matches : null;
                if (check.onchain_attested && !check.onchain_data_matches) attestation.mismatch = true;
              } catch { attestation.data_matches = null; }
            }
          }
        }
        sendJson(res, 200, { token, latest_assessment: assessment, latest_metrics: metricResult.rows[0] ?? null, attestation });
        return;
      }

      const page = pagination(parsedUrl);
      const dates = dateFilters(parsedUrl);
      if (!page || !dates) { sendError(res, 400, 'Invalid page, limit, or date filter'); return; }
      const table = route === 'assessments' || route === 'momentum' ? 'market_assessments' : 'daily_metrics';
      const totalResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ${table} WHERE token_address=$1 AND ($2::date IS NULL OR ${route === 'metrics' ? 'date' : 'assessment_date'} >= $2::date) AND ($3::date IS NULL OR ${route === 'metrics' ? 'date' : 'assessment_date'} <= $3::date)`, [address, dates.from, dates.to]);
      if (route === 'assessments') {
        const rows = await pool.query<Record<string, unknown>>(
          `SELECT a.token_address, a.assessment_date::text AS assessment_date, a.health_score, a.momentum, a.status,
                  a.holder_health, a.transfer_activity, a.address_activity, a.concentration_score, a.consistency_score,
                  a.data_window_days, a.assessment_id, a.schema_version, a.methodology_version, a.assessment_hash,
                  t.name, t.symbol
           FROM market_assessments a JOIN tokens t ON t.address=a.token_address
           WHERE a.token_address=$1 AND ($2::date IS NULL OR assessment_date >= $2::date) AND ($3::date IS NULL OR assessment_date <= $3::date)
           ORDER BY a.assessment_date DESC LIMIT $4 OFFSET $5`, [address, dates.from, dates.to, page.limit, page.offset]);
        sendJson(res, 200, { assessments: rows.rows.map(canonicalAssessment), page: page.page, limit: page.limit, total: Number(totalResult.rows[0]?.total ?? 0) });
      } else if (route === 'momentum') {
        const rows = await pool.query<{ date: string; value: string | null }>(
          `SELECT assessment_date::text AS date, momentum::text AS value FROM market_assessments
           WHERE token_address=$1 AND ($2::date IS NULL OR assessment_date >= $2::date) AND ($3::date IS NULL OR assessment_date <= $3::date)
           ORDER BY assessment_date ASC LIMIT $4 OFFSET $5`, [address, dates.from, dates.to, page.limit, page.offset]);
        sendJson(res, 200, { momentum: rows.rows.map((r) => ({ date: r.date, value: r.value === null ? null : Number(r.value) })), page: page.page, limit: page.limit, total: Number(totalResult.rows[0]?.total ?? 0) });
      } else {
        const rows = await pool.query<Record<string, unknown>>(
          `SELECT date::text AS date, holder_count, new_holders, active_holders, transfer_count, unique_senders, unique_receivers,
                  top1_concentration, top5_concentration, top10_concentration FROM daily_metrics
           WHERE token_address=$1 AND ($2::date IS NULL OR date >= $2::date) AND ($3::date IS NULL OR date <= $3::date)
           ORDER BY date ASC LIMIT $4 OFFSET $5`, [address, dates.from, dates.to, page.limit, page.offset]);
        sendJson(res, 200, { metrics: rows.rows, page: page.page, limit: page.limit, total: Number(totalResult.rows[0]?.total ?? 0) });
      }
      return;
    }

    // Route: GET /v1/tokens/:address/assessment?date=YYYY-MM-DD
    const tokenMatch = /^\/v1\/tokens\/([^/]+)\/assessment\/?$/.exec(pathname);
    if (tokenMatch) {
      const rawAddress = tokenMatch[1]!;
      if (!isAddress(rawAddress)) {
        sendError(res, 400, `Invalid Ethereum address format: ${rawAddress}`);
        return;
      }
      const tokenAddress = rawAddress.toLowerCase();

      const dateParam = parsedUrl.searchParams.get('date');
      if (!dateParam) {
        sendError(res, 400, 'Missing required query parameter "date" (format: YYYY-MM-DD)');
        return;
      }

      const dateValidation = validateDateString(dateParam);
      if (!dateValidation.valid) {
        sendError(res, 400, dateValidation.error ?? 'Invalid date format. Expected YYYY-MM-DD.');
        return;
      }
      const assessmentDate = dateValidation.normalized;

      // 1. Verify token exists
      const tokenRes = await pool.query<{ address: string; name: string | null; symbol: string | null }>(
        'SELECT address, name, symbol FROM tokens WHERE address = LOWER($1) LIMIT 1',
        [tokenAddress],
      );
      if (tokenRes.rows.length === 0) {
        sendError(res, 404, `Token ${tokenAddress} not found`);
        return;
      }
      const token = tokenRes.rows[0]!;

      // 2. Query market_assessments
      let storedRes = await pool.query<{
        token_address: string;
        assessment_date: Date | string;
        health_score: string | null;
        status: string;
        momentum: string | null;
        holder_health: string | null;
        transfer_activity: string | null;
        address_activity: string | null;
        concentration_score: string | null;
        consistency_score: string | null;
        data_window_days: number;
        reason: string | null;
        assessment_id: string | null;
        schema_version: string | null;
        methodology_version: string | null;
        assessment_hash: string | null;
      }>(
        `SELECT
           token_address,
           assessment_date::text as assessment_date,
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
           assessment_hash
         FROM market_assessments
         WHERE token_address = LOWER($1)
           AND assessment_date = $2::date
         LIMIT 1`,
        [tokenAddress, assessmentDate],
      );

      if (storedRes.rows.length === 0) {
        sendJson(res, 404, { error: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found' });
        return;
      }

      const row = storedRes.rows[0]!;

      // If insufficient data, return 422 Unprocessable Entity
      if (row.status === 'INSUFFICIENT_DATA') {
        sendJson(res, 422, {
          error: 'INSUFFICIENT_DATA',
          reason: row.reason ?? 'INSUFFICIENT_HISTORICAL_WINDOW',
          data_window_days: Number(row.data_window_days),
          token: {
            address: token.address,
            symbol: token.symbol ?? token.name ?? token.address,
          },
          assessment_date: assessmentDate,
        });
        return;
      }

      // If valid, return 200 with canonical fields and assessment hash
      const healthScoreNum = Number(row.health_score);
      const momentumNum = Number(row.momentum);

      sendJson(res, 200, {
        assessment_id: row.assessment_id,
        schema_version: row.schema_version ?? CURRENT_SCHEMA_VERSION,
        methodology_version: row.methodology_version ?? CURRENT_METHODOLOGY_VERSION,
        token: {
          address: token.address,
          symbol: token.symbol ?? token.name ?? token.address,
        },
        assessment_date: assessmentDate,
        health_score: healthScoreNum,
        momentum: momentumNum,
        status: row.status,
        components: {
          holder_health: Number(row.holder_health),
          transfer_activity: Number(row.transfer_activity),
          address_activity: Number(row.address_activity),
          concentration_score: Number(row.concentration_score),
          consistency_score: Number(row.consistency_score),
        },
        data_window_days: Number(row.data_window_days),
        assessment_hash: row.assessment_hash,
      });
      return;
    }

    // Route: POST /v1/assessments/:assessmentId/attest
    const attestMatch = /^\/v1\/assessments\/([^/]+)\/attest\/?$/.exec(pathname);
    if (attestMatch) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }

      // Security gate: evaluated before any lookup or signer access.
      const gate = authorizeAttestationRequest(req);
      if (!gate.ok) {
        logger.warn('attestation request rejected', { code: gate.code, status: gate.status });
        if (gate.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(res, gate.status, { error: gate.code, message: gate.message });
        return;
      }

      const rawAssessmentId = attestMatch[1]!;
      if (!/^0x[0-9a-fA-F]{64}$/.test(rawAssessmentId)) {
        sendError(res, 400, `Invalid assessment ID format: ${rawAssessmentId}`);
        return;
      }

      try {
        const result = await attestAssessment(pool, rawAssessmentId);
        sendJson(res, 200, result);
        return;
      } catch (err: unknown) {
        if (err instanceof AssessmentNotFoundError) {
          sendError(res, 404, err.message);
          return;
        }
        if (err instanceof AssessmentInsufficientDataError) {
          sendError(res, 422, err.message);
          return;
        }
        if (err instanceof CanonicalVerificationError) {
          sendError(res, 422, err.message);
          return;
        }
        if (err instanceof AttestationConflictError) {
          sendError(res, 409, err.message);
          return;
        }
        if (err instanceof AttestationConfigError) {
          sendError(res, 503, err.message);
          return;
        }
        logger.error('attestation failed', { error: err });
        sendError(res, 500, 'Attestation failed');
        return;
      }
    }

    // Route: GET /v1/assessments/:assessmentId/verify
    const verifyMatch = /^\/v1\/assessments\/([^/]+)\/verify\/?$/.exec(pathname);
    if (verifyMatch) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }

      const assessmentId = verifyMatch[1]!;

      // Validate assessmentId format (0x followed by 64 hex characters)
      if (!/^0x[0-9a-fA-F]{64}$/.test(assessmentId)) {
        sendError(res, 400, `Invalid assessment ID format: ${assessmentId}`);
        return;
      }

      try {
        const verification = await verifyAssessment(pool, assessmentId);
        sendJson(res, 200, verification);
        return;
      } catch (err: unknown) {
        if (err instanceof AssessmentNotFoundError) {
          sendError(res, 404, err.message);
          return;
        }
        logger.error('verification failed', { error: err });
        sendError(res, 500, 'Verification failed');
        return;
      }
    }

    sendError(res, 404, 'Endpoint not found');
  } catch (err: unknown) {
    logger.error('unexpected error handling api request', { error: err });
    sendError(res, 500, 'Internal Server Error');
  }
}

/**
 * Creates and starts the HTTP API server.
 */
export function createApiServer(pool: Queryable): Server {
  return createServer((req, res) => {
    void handleRequest(pool, req, res);
  });
}

/**
 * Starts the HTTP server on specified port.
 */
export async function startApiServer(
  pool: Queryable,
  options: ServerOptions = {},
): Promise<{ server: Server; port: number }> {
  const port = options.port ?? Number(process.env['PORT'] ?? 3000);
  const host = options.host ?? '0.0.0.0';

  const server = createApiServer(pool);

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      logger.info('api server listening', { port, host });
      resolve({ server, port });
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}
