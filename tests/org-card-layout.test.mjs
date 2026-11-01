// Real-browser layout check for the Org cards (client/src/views/projects/AgentOrg.jsx via AgentRail), at pane widths 243 and 307px.
// jsdom has no layout, so it can't see class-override clashes such as IconButton's base `relative` beating the Release
// button's `absolute`. This builds tests/browser/org-card with Vite into a temp dir (never client/dist), serves it from an
// in-process server and measures it in chrome-headless-shell over raw CDP.
//
// Browser: set AF_CHROME_BIN=/path/to/chrome-headless-shell, or install Playwright's shell into ~/.cache/ms-playwright with
// `npx playwright install chromium-headless-shell`. Without one the test is skipped. Run just this file: `npm run test:browser`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './browser/cdp.mjs';
import { measure, check } from './browser/org-card/geometry.mjs';

const FIXTURE = fileURLToPath(new URL('./browser/org-card', import.meta.url));
const WIDTHS = [243, 307];
const AGENTS = 7;
const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });

async function build() {
  const outDir = mkdtempSync(join(tmpdir(), 'af-org-card-dist-'));
  cleanup.push(() => rmSync(outDir, { recursive: true, force: true }));
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  await build({ configFile: false, root: FIXTURE, base: './', plugins: [react(), tailwindcss()], logLevel: 'error',
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 5000 } });
  return outDir;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
async function serve(dir) {
  const srv = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
    try { res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(readFileSync(join(dir, path))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

test('Org cards keep their layout in a real browser at 243 and 307px', { timeout: 180_000 }, async (t) => {
  const bin = findChrome();
  if (!bin) {
    t.skip(process.env.AF_CHROME_BIN ? `AF_CHROME_BIN=${process.env.AF_CHROME_BIN} does not exist`
      : 'no chrome-headless-shell found: set AF_CHROME_BIN or run `npx playwright install chromium-headless-shell`');
    return;
  }
  const base = await serve(await build());
  const userDataDir = mkdtempSync(join(tmpdir(), 'af-org-card-chrome-'));
  cleanup.push(() => rmSync(userDataDir, { recursive: true, force: true }));
  const b = await launch(bin, { userDataDir });
  cleanup.push(() => b.close()); // runs before the dir removal (reverse order)

  await b.send('Page.navigate', { url: `${base}/index.html#${WIDTHS.join(',')}` });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    ready = await b.ev((n) => document.querySelectorAll('[data-pane] [aria-label="Team hierarchy"] button[data-agent]').length === n
      && document.fonts.status === 'loaded', AGENTS * WIDTHS.length).catch(() => false);
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  await b.ev(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
  assert.deepEqual(b.logs.map((x) => x.exception?.description || x.text), [], 'page threw');
  assert.ok(ready, `expected ${AGENTS} org cards in each of ${WIDTHS.length} panes`);

  const panes = await b.ev(measure);
  assert.deepEqual(panes.map((p) => [p.w, p.cards.length]), WIDTHS.map((w) => [w, AGENTS]), 'panes/cards rendered');
  const { passed, failed } = check(panes);
  t.diagnostic(`${passed} geometry checks passed`);
  assert.ok(failed.length === 0, `${failed.length} of ${passed + failed.length} org-card geometry checks failed:\n  ${failed.join('\n  ')}`);
});
