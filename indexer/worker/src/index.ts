import { httpServerHandler } from 'cloudflare:node';
import pg from 'pg';
import { createApiServer, getAssessment, getTokenMetrics, getTokenMomentum, listTokens } from '../../src/api/server.js';
import type { Queryable } from '../../src/database.js';

interface WorkerEnv {
  HYPERDRIVE: { connectionString: string };
}

const INTERNAL_ROUTE_KEY = 8672;
let nextRouteKey = INTERNAL_ROUTE_KEY;

type HttpHandler = ReturnType<typeof httpServerHandler>;
type WorkerRequest = Parameters<NonNullable<HttpHandler['fetch']>>[0];
type WorkerContext = Parameters<NonNullable<HttpHandler['fetch']>>[2];

function createReadOnlyDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  });

  // The public Worker surface is read-only. Keep this guard at the database
  // boundary as a second line of defense against future write routes.
  const database: Queryable = {
    async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
      if (!/^\s*SELECT\b/i.test(text)) throw new Error('Worker database adapter allows SELECT statements only');
      return pool.query<R>(text, values as unknown[] | undefined);
    },
  };

  return { pool, database };
}

function createRequestHandler(connectionString: string) {
  const { pool, database } = createReadOnlyDatabase(connectionString);
  const server = createApiServer(database);
  nextRouteKey = nextRouteKey >= 32000 ? INTERNAL_ROUTE_KEY : nextRouteKey + 1;
  server.listen(nextRouteKey);
  return { pool, server, handler: httpServerHandler({ port: nextRouteKey }) };
}

export default {
  async fetch(request: WorkerRequest, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    const requestUrl = request.method === 'GET' ? new URL(request.url) : null;
    if (requestUrl?.pathname === '/health') {
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (requestUrl?.pathname === '/v1/tokens') {
      process.env['ATTESTATION_ENABLED'] = 'false';
      delete process.env['ATTESTATION_API_SECRET'];
      delete process.env['ATTESTER_PRIVATE_KEY'];

      const { pool, database } = createReadOnlyDatabase(env.HYPERDRIVE.connectionString);
      try {
        const result = await listTokens(database, requestUrl);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } catch {
        return new Response('{"error":"Internal Server Error"}', {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } finally {
        await pool.end();
      }
    }

    const assessmentMatch = requestUrl && /^\/v1\/tokens\/([^/]+)\/assessment\/?$/.exec(requestUrl.pathname);
    if (requestUrl && assessmentMatch) {
      process.env['ATTESTATION_ENABLED'] = 'false';
      delete process.env['ATTESTATION_API_SECRET'];
      delete process.env['ATTESTER_PRIVATE_KEY'];

      const { pool, database } = createReadOnlyDatabase(env.HYPERDRIVE.connectionString);
      try {
        const result = await getAssessment(database, assessmentMatch[1]!, requestUrl);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } catch {
        return new Response('{"error":"Internal Server Error"}', {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } finally {
        await pool.end();
      }
    }

    const metricsMatch = requestUrl && /^\/v1\/tokens\/([^/]+)\/metrics\/?$/.exec(requestUrl.pathname);
    if (requestUrl && metricsMatch) {
      process.env['ATTESTATION_ENABLED'] = 'false';
      delete process.env['ATTESTATION_API_SECRET'];
      delete process.env['ATTESTER_PRIVATE_KEY'];

      const { pool, database } = createReadOnlyDatabase(env.HYPERDRIVE.connectionString);
      try {
        const result = await getTokenMetrics(database, metricsMatch[1]!, requestUrl);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } catch {
        return new Response('{"error":"Internal Server Error"}', {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } finally {
        await pool.end();
      }
    }

    const momentumMatch = requestUrl && /^\/v1\/tokens\/([^/]+)\/momentum\/?$/.exec(requestUrl.pathname);
    if (requestUrl && momentumMatch) {
      process.env['ATTESTATION_ENABLED'] = 'false';
      delete process.env['ATTESTATION_API_SECRET'];
      delete process.env['ATTESTER_PRIVATE_KEY'];

      const { pool, database } = createReadOnlyDatabase(env.HYPERDRIVE.connectionString);
      try {
        const result = await getTokenMomentum(database, momentumMatch[1]!, requestUrl);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } catch {
        return new Response('{"error":"Internal Server Error"}', {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } finally {
        await pool.end();
      }
    }

    // The adapter is deliberately read-only even if deployment variables are
    // changed later. The original route remains reachable and returns the same
    // disabled response, before any DB lookup or signer code can run.
    process.env['ATTESTATION_ENABLED'] = 'false';
    delete process.env['ATTESTATION_API_SECRET'];
    delete process.env['ATTESTER_PRIVATE_KEY'];

    const { pool, server, handler } = createRequestHandler(env.HYPERDRIVE.connectionString);
    try {
      const fetchHandler = handler.fetch;
      if (!fetchHandler) throw new Error('Cloudflare Node HTTP handler is unavailable');
      return await fetchHandler(request, env, ctx);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await pool.end();
    }
  },
};
