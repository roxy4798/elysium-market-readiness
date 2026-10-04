import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexerDir = resolve(workerDir, '..');
const configPath = resolve(workerDir, 'wrangler.jsonc');
const wranglerCli = resolve(indexerDir, 'node_modules/wrangler/bin/wrangler.js');
const base = 'http://127.0.0.1:8799';
const token = '0x245bfe8c6c2429f6a7743d53377ae39b98500459';
const assessmentId = '0x2ffe882456f2f43d66ce8c4049d55bcacf80a1393afc2cd467a746cec4d18ef3';

try { process.loadEnvFile(resolve(indexerDir, '.env')); } catch { /* CI may inject the connection string directly. */ }
const databaseUrl = process.env['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE']
  ?? process.env['DATABASE_URL'];

test('Worker bridge preserves API routes, CORS, read-only behavior, and verification', {
  skip: !databaseUrl ? 'Set DATABASE_URL or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE for the local Hyperdrive binding.' : false,
}, async (t) => {
  assert.ok(existsSync(wranglerCli), 'Wrangler CLI is installed');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const rowCounts = async () => {
    const names = ['tokens', 'transfers', 'balances', 'daily_metrics', 'market_assessments', 'assessment_attestations'];
    const entries = await Promise.all(names.map(async (name) => {
      const result = await pool.query(`SELECT COUNT(*)::text AS count FROM ${name}`);
      return [name, Number(result.rows[0].count)];
    }));
    return Object.fromEntries(entries);
  };

  const childEnv = { ...process.env };
  for (const key of ['DATABASE_URL', 'ATTESTER_PRIVATE_KEY', 'ATTESTATION_API_SECRET', 'RPC_URL', 'ATTESTATION_CONTRACT_ADDRESS']) delete childEnv[key];
  delete childEnv['CLOUDFLARE_INCLUDE_PROCESS_ENV'];
  childEnv['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'] = databaseUrl;
  childEnv['ATTESTATION_ENABLED'] = 'false';
  childEnv['WRANGLER_SEND_METRICS'] = 'false';
  const wrangler = spawn(process.execPath, [wranglerCli, 'dev', '--config', configPath, '--ip', '127.0.0.1', '--port', '8799', '--log-level', 'error'], {
    cwd: workerDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let workerOutput = '';
  wrangler.stdout.setEncoding('utf8').on('data', (chunk) => { workerOutput += chunk; });
  wrangler.stderr.setEncoding('utf8').on('data', (chunk) => { workerOutput += chunk; });
  t.after(async () => {
    wrangler.kill();
    await new Promise((resolveDone) => wrangler.once('exit', resolveDone));
    await pool.end();
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler dev exited early: ${workerOutput}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) { ready = true; break; }
    } catch { /* workerd is still starting */ }
    await delay(500);
  }
  assert.ok(ready, `local Worker did not become ready: ${workerOutput}`);

  const countsBefore = await rowCounts();
  const timings = [];
  const request = async (path, init) => {
    const start = performance.now();
    const response = await fetch(`${base}${path}`, init);
    timings.push({ path, wallMs: Number((performance.now() - start).toFixed(2)) });
    return response;
  };
  const expectJson = async (path, status = 200, init) => {
    const response = await request(path, init);
    if (response.status !== status) await delay(300);
    assert.equal(response.status, status, `${path} status; body=${await response.clone().text()}; worker=${workerOutput}`);
    return { response, body: await response.json() };
  };

  for (const path of ['/health', '/v1/health']) {
    const { response, body } = await expectJson(path);
    assert.deepEqual(body, { status: 'ok' });
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }

  const overview = (await expectJson(`/v1/tokens/${token}/overview`)).body;
  assert.equal(overview.token.address.toLowerCase(), token);
  assert.equal(overview.latest_assessment.assessment_id, assessmentId);
  assert.equal(overview.attestation.attested, true);
  assert.equal(overview.attestation.data_matches, true);

  const listed = (await expectJson('/v1/tokens?page=1&limit=100')).body;
  assert.equal(listed.page, 1);
  assert.equal(listed.limit, 100);
  assert.ok(listed.tokens.some((item) => item.address.toLowerCase() === token));

  const history = (await expectJson(`/v1/tokens/${token}/assessments`)).body;
  assert.ok(history.assessments.some((row) => row.assessment_id === assessmentId));
  const metrics = (await expectJson(`/v1/tokens/${token}/metrics`)).body;
  assert.ok(Array.isArray(metrics.metrics));
  const momentum = (await expectJson(`/v1/tokens/${token}/momentum`)).body;
  assert.ok(Array.isArray(momentum.momentum));

  const assessment = (await expectJson(`/v1/tokens/${token}/assessment?date=2026-10-03`)).body;
  assert.deepEqual({ id: assessment.assessment_id, hash: assessment.assessment_hash, health: assessment.health_score, momentum: assessment.momentum, status: assessment.status }, {
    id: assessmentId,
    hash: '180f144a819cdcd22d9244feef524dc7f75a80f73505410b9e2efba78d05193c',
    health: 34,
    momentum: 4.5,
    status: 'EARLY',
  });

  const verification = (await expectJson(`/v1/assessments/${assessmentId}/verify`)).body;
  assert.deepEqual({ canonical_valid: verification.canonical_valid, onchain_attested: verification.onchain_attested, onchain_data_matches: verification.onchain_data_matches }, {
    canonical_valid: true,
    onchain_attested: true,
    onchain_data_matches: true,
  });

  const options = await request(`/v1/assessments/${assessmentId}/attest`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  assert.equal(options.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(options.headers.get('access-control-allow-headers'), 'Content-Type');

  const { response: denied, body: deniedBody } = await expectJson(`/v1/assessments/${assessmentId}/attest`, 403, {
    method: 'POST',
    headers: { Authorization: 'Bearer worker-adapter-must-not-enable-attestation' },
  });
  assert.equal(deniedBody.error, 'ATTESTATION_DISABLED');
  assert.equal(denied.headers.get('access-control-allow-origin'), '*');
  const methodRejected = await request('/health', { method: 'PUT' });
  assert.equal(methodRejected.status, 405);
  assert.equal(methodRejected.headers.get('access-control-allow-origin'), '*');

  const countsAfter = await rowCounts();
  assert.deepEqual(countsAfter, countsBefore, 'Worker requests must not modify application tables');
  console.log(`Worker local workerd wall-time sample (ms; includes I/O; not billing CPU): ${JSON.stringify(timings)}`);
});
