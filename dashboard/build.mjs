import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm(new URL('./dist/styles.css', import.meta.url), { force: true });
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
await cp(new URL('./styles.css', import.meta.url), new URL('./dist/styles.css', import.meta.url));
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const configuredBase = process.env['API_BASE_URL']?.trim() || 'http://localhost:3000';
let apiBase;
try {
  apiBase = new URL(configuredBase);
} catch {
  throw new Error('API_BASE_URL must be an absolute HTTP(S) URL.');
}
if (!['http:', 'https:'].includes(apiBase.protocol) || apiBase.username || apiBase.password || apiBase.search || apiBase.hash) {
  throw new Error('API_BASE_URL must be a public HTTP(S) base URL without credentials, query, or fragment.');
}
const normalizedBase = apiBase.href.replace(/\/+$/, '');
const safeBase = normalizedBase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const configuredHtml = html.replace('<meta name="elysium-api-base" content="" />', `<meta name="elysium-api-base" content="${safeBase}" />`);
await writeFile(new URL('./dist/index.html', import.meta.url), configuredHtml.replace('./dist/main.js', './main.js'));
console.log('Dashboard production assets written to dashboard/dist');
