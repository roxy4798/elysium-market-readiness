import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const port = Number(process.env['DASHBOARD_PORT'] ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) && path !== root && path !== resolve(root, 'index.html')) throw new Error('invalid path');
    try { if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html'); }
    catch { path = resolve(root, 'index.html'); }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Dashboard preview: http://localhost:${port}`));
