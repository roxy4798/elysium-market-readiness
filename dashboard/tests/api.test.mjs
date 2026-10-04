import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distHtml = resolve(dashboardDir, 'dist/index.html');

function setMetaContent(content) {
  globalThis.document = {
    querySelector(selector) {
      assert.equal(selector, 'meta[name="elysium-api-base"]');
      return content === undefined ? null : { content };
    },
  };
}

test('API base defaults to production Worker and normalizes configured URLs', async () => {
  setMetaContent(undefined);
  const { normalizeApiBase, DEFAULT_PRODUCTION_API_BASE } = await import(`../dist/api.js?default=${Date.now()}`);
  assert.equal(normalizeApiBase(undefined), 'https://elysium-market-readiness-api.elysium-market-readiness-indexer.workers.dev');
  assert.equal(normalizeApiBase(undefined), DEFAULT_PRODUCTION_API_BASE);
  assert.equal(normalizeApiBase('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeApiBase('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeApiBase('https://api.example.com/v1///'), 'https://api.example.com/v1');
  assert.throws(() => normalizeApiBase('https://user:password@example.com'), /public HTTP\(S\)/);
});

test('production build embeds API_BASE_URL and API requests use the normalized URL', async () => {
  const configured = 'https://api.example.com/root///';
  execFileSync(process.execPath, ['build.mjs'], {
    cwd: dashboardDir,
    env: { ...process.env, API_BASE_URL: configured },
    stdio: 'pipe',
  });
  const html = await readFile(distHtml, 'utf8');
  assert.match(html, /content="https:\/\/api\.example\.com\/root"/);
  const base = html.match(/<meta name="elysium-api-base" content="([^"]*)"/)[1];
  setMetaContent(base);
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(url);
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { api } = await import(`../dist/api.js?production=${Date.now()}`);
    await api.health();
    assert.deepEqual(requested, ['https://api.example.com/root/health']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('production build defaults to production Worker when API_BASE_URL is unset', async () => {
  const env = { ...process.env };
  delete env.API_BASE_URL;
  execFileSync(process.execPath, ['build.mjs'], { cwd: dashboardDir, env, stdio: 'pipe' });
  const html = await readFile(distHtml, 'utf8');
  assert.match(html, /content="https:\/\/elysium-market-readiness-api\.elysium-market-readiness-indexer\.workers\.dev"/);
});
