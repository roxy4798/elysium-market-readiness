/**
 * Phase 3A — Verification & REST API Server.
 * Lightweight, production-quality HTTP server using node:http.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAddress } from 'viem';
import type { Queryable } from '../database.js';
import { validateDateString } from '../metrics/daily-metrics.js';
import {
  assessToken,
  loadObservationsForToken,
  upsertMarketAssessment,
} from '../assessment/assessment-engine.js';
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
  CanonicalVerificationError,
} from '../attestation/attestation-service.js';
import { logger } from '../logger.js';

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

      // If not yet evaluated, evaluate on-demand and store
      if (storedRes.rows.length === 0) {
        const obs = await loadObservationsForToken(pool, tokenAddress, assessmentDate);
        const computed = assessToken(tokenAddress, assessmentDate, obs);
        await upsertMarketAssessment(pool, computed);

        // Re-read row
        storedRes = await pool.query(
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
      }

      if (storedRes.rows.length === 0) {
        sendError(res, 404, `Assessment for ${tokenAddress} on ${assessmentDate} not found`);
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
