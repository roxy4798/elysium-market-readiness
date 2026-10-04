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
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
  }

  const health = await request('/health');
  const v1Health = await request('/v1/health');
  assert.equal(health.status, v1Health.status);
  assert.equal(await health.clone().text(), await v1Health.clone().text());
  for (const header of ['content-type', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) {
    assert.equal(health.headers.get(header), v1Health.headers.get(header), `/health ${header} matches the existing health route`);
  }

  const postHealth = await request('/health', { method: 'POST' });
  assert.equal(postHealth.status, 200);
  assert.deepEqual(await postHealth.json(), { status: 'ok' });
  assert.equal(postHealth.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(postHealth.headers.get('access-control-allow-origin'), '*');
  assert.equal(postHealth.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(postHealth.headers.get('access-control-allow-headers'), 'Content-Type');

  const healthOptions = await request('/health', { method: 'OPTIONS' });
  assert.equal(healthOptions.status, 204);
  assert.equal(await healthOptions.text(), '');
  assert.equal(healthOptions.headers.get('access-control-allow-origin'), '*');
  assert.equal(healthOptions.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(healthOptions.headers.get('access-control-allow-headers'), 'Content-Type');

  const overview = (await expectJson(`/v1/tokens/${token}/overview`)).body;
  assert.equal(overview.token.address.toLowerCase(), token);
  assert.equal(overview.latest_assessment.assessment_id, assessmentId);
  assert.equal(overview.attestation.attested, true);
  assert.equal(overview.attestation.data_matches, true);

  const defaultListing = (await expectJson('/v1/tokens')).body;
  assert.equal(defaultListing.page, 1);
  assert.equal(defaultListing.limit, 25);
  assert.ok(Number.isInteger(defaultListing.total));

  const listed = (await expectJson('/v1/tokens?page=1&limit=100')).body;
  assert.equal(listed.page, 1);
  assert.equal(listed.limit, 100);
  assert.equal(listed.total, defaultListing.total);
  assert.deepEqual(listed.tokens.map((item) => item.address), [...listed.tokens.map((item) => item.address)].sort());
  assert.deepEqual(defaultListing.tokens, listed.tokens.slice(0, 25));
  assert.ok(listed.tokens.some((item) => item.address.toLowerCase() === token));
  const elys = listed.tokens.find((item) => item.address.toLowerCase() === token);
  assert.deepEqual({ health_score: elys.health_score, momentum: elys.momentum, status: elys.status }, {
    health_score: 34,
    momentum: 4.5,
    status: 'EARLY',
  });
  const insufficient = listed.tokens.find((item) => item.status === 'INSUFFICIENT_DATA');
  assert.ok(insufficient);
  assert.equal(insufficient.health_score, null);
  assert.equal(insufficient.momentum, null);

  const secondPage = (await expectJson('/v1/tokens?page=2&limit=4')).body;
  assert.deepEqual(secondPage.tokens, listed.tokens.slice(4, 8));
  const emptyPage = (await expectJson('/v1/tokens?page=100&limit=4')).body;
  assert.deepEqual(emptyPage.tokens, []);
  assert.equal(emptyPage.total, listed.total);
  const invalidPage = await request('/v1/tokens?page=0');
  assert.equal(invalidPage.status, 400);
  assert.deepEqual(await invalidPage.json(), { error: 'Invalid page or limit' });
  assert.equal(invalidPage.headers.get('access-control-allow-origin'), '*');
  const invalidLimit = await request('/v1/tokens?limit=abc');
  assert.equal(invalidLimit.status, 400);
  assert.deepEqual(await invalidLimit.json(), { error: 'Invalid page or limit' });
  const tokenOptions = await request('/v1/tokens', { method: 'OPTIONS' });
  assert.equal(tokenOptions.status, 204);
  assert.equal(await tokenOptions.text(), '');
  assert.equal(tokenOptions.headers.get('access-control-allow-origin'), '*');
  assert.equal(tokenOptions.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(tokenOptions.headers.get('access-control-allow-headers'), 'Content-Type');
  const tokenPost = await request('/v1/tokens', { method: 'POST' });
  assert.equal(tokenPost.status, 404);
  assert.deepEqual(await tokenPost.json(), { error: 'Endpoint not found' });

  const history = (await expectJson(`/v1/tokens/${token}/assessments`)).body;
  assert.ok(history.assessments.some((row) => row.assessment_id === assessmentId));
  const metrics = (await expectJson(`/v1/tokens/${token}/metrics`)).body;
  assert.ok(Array.isArray(metrics.metrics));
  assert.equal(metrics.page, 1);
  assert.equal(metrics.limit, 25);
  assert.equal(metrics.total, 8);
  assert.deepEqual(metrics.metrics.map((row) => row.date), [...metrics.metrics.map((row) => row.date)].sort());
  const elysMetricsResponse = await request(`/v1/tokens/${token}/metrics`);
  assert.equal(elysMetricsResponse.status, 200);
  assert.equal(elysMetricsResponse.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(elysMetricsResponse.headers.get('access-control-allow-origin'), '*');
  assert.equal(elysMetricsResponse.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(elysMetricsResponse.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.deepEqual(await elysMetricsResponse.json(), metrics);

  const otherMetrics = await expectJson('/v1/tokens/0x002f7468433336a92d31826743a6c0c6aa8b5b81/metrics');
  assert.ok(otherMetrics.body.metrics.length > 0);
  assert.equal(otherMetrics.body.page, 1);
  assert.equal(otherMetrics.body.limit, 25);

  const noMetrics = await expectJson(`/v1/tokens/${token}/metrics?from=2099-01-01&to=2099-01-02`);
  assert.deepEqual(noMetrics.body, { metrics: [], page: 1, limit: 25, total: 0 });
  const filteredMetrics = await expectJson(`/v1/tokens/${token}/metrics?from=2026-10-01&to=2026-10-03&page=1&limit=1`);
  assert.deepEqual(filteredMetrics.body, { metrics: [metrics.metrics.find((row) => row.date === '2026-10-01')], page: 1, limit: 1, total: 3 });
  const maxMetrics = await expectJson(`/v1/tokens/${token}/metrics?page=1&limit=100`);
  assert.equal(maxMetrics.body.limit, 100);
  assert.deepEqual(maxMetrics.body.metrics, metrics.metrics);
  const boundaryMetrics = await expectJson(`/v1/tokens/${token}/metrics?page=100&limit=100`);
  assert.deepEqual(boundaryMetrics.body, { metrics: [], page: 100, limit: 100, total: 8 });
  const overLimitMetrics = await expectJson(`/v1/tokens/${token}/metrics?limit=101`);
  assert.equal(overLimitMetrics.body.limit, 100);
  assert.equal(overLimitMetrics.body.total, 8);
  for (const query of ['page=0', 'limit=0', 'page=999999999999999999999999', 'from=bad', 'from=2026-10-04&to=2026-10-01']) {
    const invalidMetrics = await request(`/v1/tokens/${token}/metrics?${query}`);
    assert.equal(invalidMetrics.status, 400, `metrics query ${query}`);
    assert.deepEqual(await invalidMetrics.json(), { error: 'Invalid page, limit, or date filter' });
    assert.equal(invalidMetrics.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(invalidMetrics.headers.get('access-control-allow-origin'), '*');
  }
  const invalidMetricsAddress = await request('/v1/tokens/not-an-address/metrics');
  assert.equal(invalidMetricsAddress.status, 400);
  assert.deepEqual(await invalidMetricsAddress.json(), { error: 'Invalid Ethereum address format' });
  assert.equal(invalidMetricsAddress.headers.get('access-control-allow-origin'), '*');
  const unknownMetricsToken = await request('/v1/tokens/0x0000000000000000000000000000000000000001/metrics');
  assert.equal(unknownMetricsToken.status, 404);
  assert.deepEqual(await unknownMetricsToken.json(), { error: 'Token not found' });
  assert.equal(unknownMetricsToken.headers.get('access-control-allow-origin'), '*');
  const metricsOptions = await request(`/v1/tokens/${token}/metrics`, { method: 'OPTIONS' });
  assert.equal(metricsOptions.status, 204);
  assert.equal(await metricsOptions.text(), '');
  assert.equal(metricsOptions.headers.get('access-control-allow-origin'), '*');
  assert.equal(metricsOptions.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(metricsOptions.headers.get('access-control-allow-headers'), 'Content-Type');
  const metricsPost = await request(`/v1/tokens/${token}/metrics`, { method: 'POST' });
  assert.equal(metricsPost.status, 404);
  assert.deepEqual(await metricsPost.json(), { error: 'Endpoint not found' });
  const momentumResponse = await expectJson(`/v1/tokens/${token}/momentum`);
  const momentum = momentumResponse.body;
  assert.deepEqual(momentum, { momentum: [{ date: '2026-10-03', value: 4.5 }], page: 1, limit: 25, total: 1 });
  assert.equal(momentumResponse.response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(momentumResponse.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(momentumResponse.response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(momentumResponse.response.headers.get('access-control-allow-headers'), 'Content-Type');

  const insufficientMomentum = await expectJson('/v1/tokens/0x002f7468433336a92d31826743a6c0c6aa8b5b81/momentum');
  assert.deepEqual(insufficientMomentum.body, { momentum: [{ date: '2026-10-03', value: null }], page: 1, limit: 25, total: 1 });
  const noMomentum = await expectJson(`/v1/tokens/${token}/momentum?from=2099-01-01&to=2099-01-02`);
  assert.deepEqual(noMomentum.body, { momentum: [], page: 1, limit: 25, total: 0 });
  const filteredMomentum = await expectJson(`/v1/tokens/${token}/momentum?from=2026-10-01&to=2026-10-03&page=1&limit=1`);
  assert.deepEqual(filteredMomentum.body, { momentum: [{ date: '2026-10-03', value: 4.5 }], page: 1, limit: 1, total: 1 });
  const maxMomentum = await expectJson(`/v1/tokens/${token}/momentum?page=1&limit=100`);
  assert.deepEqual(maxMomentum.body, { ...momentum, limit: 100 });
  const boundaryMomentum = await expectJson(`/v1/tokens/${token}/momentum?page=100&limit=100`);
  assert.deepEqual(boundaryMomentum.body, { momentum: [], page: 100, limit: 100, total: 1 });
  const overLimitMomentum = await expectJson(`/v1/tokens/${token}/momentum?limit=101`);
  assert.deepEqual(overLimitMomentum.body, { ...momentum, limit: 100 });
  for (const query of ['page=0', 'limit=0', 'page=999999999999999999999999', 'from=bad', 'from=2026-10-04&to=2026-10-01']) {
    const invalidMomentum = await request(`/v1/tokens/${token}/momentum?${query}`);
    assert.equal(invalidMomentum.status, 400, `momentum query ${query}`);
    assert.deepEqual(await invalidMomentum.json(), { error: 'Invalid page, limit, or date filter' });
    assert.equal(invalidMomentum.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(invalidMomentum.headers.get('access-control-allow-origin'), '*');
    assert.equal(invalidMomentum.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(invalidMomentum.headers.get('access-control-allow-headers'), 'Content-Type');
  }
  const invalidMomentumAddress = await request('/v1/tokens/not-an-address/momentum');
  assert.equal(invalidMomentumAddress.status, 400);
  assert.deepEqual(await invalidMomentumAddress.json(), { error: 'Invalid Ethereum address format' });
  assert.equal(invalidMomentumAddress.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(invalidMomentumAddress.headers.get('access-control-allow-origin'), '*');
  const unknownMomentumToken = await request('/v1/tokens/0x0000000000000000000000000000000000000001/momentum');
  assert.equal(unknownMomentumToken.status, 404);
  assert.deepEqual(await unknownMomentumToken.json(), { error: 'Token not found' });
  assert.equal(unknownMomentumToken.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(unknownMomentumToken.headers.get('access-control-allow-origin'), '*');
  const momentumOptions = await request(`/v1/tokens/${token}/momentum`, { method: 'OPTIONS' });
  assert.equal(momentumOptions.status, 204);
  assert.equal(await momentumOptions.text(), '');
  assert.equal(momentumOptions.headers.get('access-control-allow-origin'), '*');
  assert.equal(momentumOptions.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(momentumOptions.headers.get('access-control-allow-headers'), 'Content-Type');
  const momentumPost = await request(`/v1/tokens/${token}/momentum`, { method: 'POST' });
  assert.equal(momentumPost.status, 404);
  assert.deepEqual(await momentumPost.json(), { error: 'Endpoint not found' });
  assert.equal(momentumPost.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(momentumPost.headers.get('access-control-allow-origin'), '*');
  const momentumHead = await request(`/v1/tokens/${token}/momentum`, { method: 'HEAD' });
  assert.equal(momentumHead.status, 405);
  assert.equal(await momentumHead.text(), '');
  assert.equal(momentumHead.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(momentumHead.headers.get('access-control-allow-origin'), '*');

  const assessment = (await expectJson(`/v1/tokens/${token}/assessment?date=2026-10-03`)).body;
  assert.deepEqual(assessment, {
    assessment_id: assessmentId,
    schema_version: '1.0',
    methodology_version: 'health-v1',
    token: { address: token, symbol: 'ELYS' },
    assessment_date: '2026-10-03',
    health_score: 34,
    momentum: 4.5,
    status: 'EARLY',
    components: {
      holder_health: 0,
      transfer_activity: 52.61,
      address_activity: 54.14,
      concentration_score: 0.1,
      consistency_score: 100,
    },
    data_window_days: 7,
    assessment_hash: '180f144a819cdcd22d9244feef524dc7f75a80f73505410b9e2efba78d05193c',
  });
  assert.deepEqual({ id: assessment.assessment_id, hash: assessment.assessment_hash, health: assessment.health_score, momentum: assessment.momentum, status: assessment.status }, {
    id: assessmentId,
    hash: '180f144a819cdcd22d9244feef524dc7f75a80f73505410b9e2efba78d05193c',
    health: 34,
    momentum: 4.5,
    status: 'EARLY',
  });

  const invalidAssessmentAddress = await request('/v1/tokens/not-an-address/assessment?date=2026-10-03');
  assert.equal(invalidAssessmentAddress.status, 400);
  assert.deepEqual(await invalidAssessmentAddress.json(), { error: 'Invalid Ethereum address format: not-an-address' });
  const invalidAssessmentDate = await request(`/v1/tokens/${token}/assessment?date=bad`);
  assert.equal(invalidAssessmentDate.status, 400);
  assert.deepEqual(await invalidAssessmentDate.json(), { error: 'Invalid date format "bad". Expected YYYY-MM-DD.' });
  const unknownAssessmentToken = await request('/v1/tokens/0x0000000000000000000000000000000000000001/assessment?date=2026-10-03');
  assert.equal(unknownAssessmentToken.status, 404);
  assert.deepEqual(await unknownAssessmentToken.json(), { error: 'Token 0x0000000000000000000000000000000000000001 not found' });

  const insufficientToken = '0x002f7468433336a92d31826743a6c0c6aa8b5b81';
  const insufficientAssessment = await request(`/v1/tokens/${insufficientToken}/assessment?date=2026-10-03`);
  assert.equal(insufficientAssessment.status, 422);
  assert.deepEqual(await insufficientAssessment.json(), {
    error: 'INSUFFICIENT_DATA',
    reason: 'INSUFFICIENT_HISTORICAL_WINDOW',
    data_window_days: 0,
    token: { address: insufficientToken, symbol: 'ETT' },
    assessment_date: '2026-10-03',
  });

  const assessmentOptions = await request(`/v1/tokens/${token}/assessment?date=2026-10-03`, { method: 'OPTIONS' });
  assert.equal(assessmentOptions.status, 204);
  assert.equal(await assessmentOptions.text(), '');
  assert.equal(assessmentOptions.headers.get('access-control-allow-origin'), '*');
  assert.equal(assessmentOptions.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(assessmentOptions.headers.get('access-control-allow-headers'), 'Content-Type');
  const assessmentPost = await expectJson(`/v1/tokens/${token}/assessment?date=2026-10-03`, 200, { method: 'POST' });
  assert.deepEqual(assessmentPost.body, assessment);

  const missingAssessment = await request(`/v1/tokens/${token}/assessment?date=2026-10-04`);
  assert.equal(missingAssessment.status, 404);
  assert.equal((await missingAssessment.json()).error, 'ASSESSMENT_NOT_FOUND');

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
  assert.deepEqual(await methodRejected.json(), { error: 'Method Not Allowed' });
  assert.equal(methodRejected.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(methodRejected.headers.get('access-control-allow-origin'), '*');
  assert.equal(methodRejected.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(methodRejected.headers.get('access-control-allow-headers'), 'Content-Type');

  const headHealth = await request('/health', { method: 'HEAD' });
  assert.equal(headHealth.status, 405);
  assert.equal(await headHealth.text(), '');
  assert.equal(headHealth.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headHealth.headers.get('access-control-allow-origin'), '*');

  const countsAfter = await rowCounts();
  assert.deepEqual(countsAfter, countsBefore, 'Worker requests must not modify application tables');
  console.log(`Worker local workerd wall-time sample (ms; includes I/O; not billing CPU): ${JSON.stringify(timings)}`);
});
