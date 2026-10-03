import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm(new URL('./dist/styles.css', import.meta.url), { force: true });
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
await cp(new URL('./styles.css', import.meta.url), new URL('./dist/styles.css', import.meta.url));
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
await writeFile(new URL('./dist/index.html', import.meta.url), html.replace('./dist/main.js', './main.js'));
console.log('Dashboard production assets written to dashboard/dist');
