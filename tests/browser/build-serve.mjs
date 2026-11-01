// Shared by the browser layout tests: build a fixture with Vite into a temp dir (never client/dist) and serve it from an
// in-process static server. Both register their teardown on the caller's `cleanup` list (run in reverse order in after()).
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

export async function build(root, cleanup, prefix = 'af-browser-dist-') {
  const outDir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(outDir, { recursive: true, force: true }));
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  await build({ configFile: false, root, base: './', plugins: [react(), tailwindcss()], logLevel: 'error',
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 5000 } });
  return outDir;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
export async function serve(dir, cleanup) {
  const srv = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
    try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(readFileSync(join(dir, path))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return `http://127.0.0.1:${srv.address().port}`;
}
