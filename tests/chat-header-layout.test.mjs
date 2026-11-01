// Real-browser width budget for the project chat header (client/src/views/projects/CommandWindow.jsx) at a 25% chat pane:
// 243px (1024px viewport) and 307px (1280px), plus 467px (1920px, above the @md compaction) as a control. Builds
// tests/browser/chat-header with Vite into a temp dir (never client/dist) and measures it in chrome-headless-shell over CDP.
//
// Each case must keep the header row inside its pane. The status badge and line 2's GM span must not run under the icon
// group, except for the known 243px defects in KNOWN: those stay pinned (measured px + 0.5) and each gets a todo entry
// with the measured px, so they show in every run. A case that stops overlapping fails here too: move it out of KNOWN then.
// Browser lookup and skipping work as in tests/org-card-layout.test.mjs. Run just the browser tests: `npm run test:browser`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './browser/cdp.mjs';
import { build, serve } from './browser/build-serve.mjs';
import { measure, overlap } from './browser/chat-header/geometry.mjs';

const FIXTURE = fileURLToPath(new URL('./browser/chat-header', import.meta.url));
const TOL = 0.5;
const CASES = [];
for (const w of [243, 307, 467]) for (const gh of ['gh', '-']) for (const state of ['idle', 'running', 'queued'])
  for (const lock of ['lock', '-']) for (const name of ['short', 'long']) CASES.push([w, gh, state, lock, name].join(':'));
// Overlap under the icon group in px, Chromium 156, 2026-11-01: [badge, line-2 GM span], keyed by width:github:state:lock.
// Only the 243px pane overflows its title column; the project name length makes no difference there.
const KNOWN = {
  '243:gh:idle:lock': [14.75, 26.87], '243:gh:idle:-': [0, 26.87],
  '243:gh:running:lock': [49.88, 53], '243:gh:running:-': [43, 53],
  '243:gh:queued:lock': [48.88, 53], '243:gh:queued:-': [42, 53],
  '243:-:running:lock': [34.25, 27.37], '243:-:running:-': [14, 27.37],
  '243:-:queued:lock': [33.25, 27.37], '243:-:queued:-': [13, 27.37],
};
const known = (key) => KNOWN[key.split(':').slice(0, 4).join(':')];

const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });

test('Project chat header keeps its width budget in a real browser at 243, 307 and 467px', { timeout: 180_000 }, async (t) => {
  const bin = findChrome();
  if (!bin) {
    t.skip(process.env.AF_CHROME_BIN ? `AF_CHROME_BIN=${process.env.AF_CHROME_BIN} does not exist`
      : 'no chrome-headless-shell found: set AF_CHROME_BIN or run `npx playwright install chromium-headless-shell`');
    return;
  }
  const base = await serve(await build(FIXTURE, cleanup, 'af-chat-header-dist-'), cleanup);
  const userDataDir = mkdtempSync(join(tmpdir(), 'af-chat-header-chrome-'));
  cleanup.push(() => rmSync(userDataDir, { recursive: true, force: true }));
  const b = await launch(bin, { userDataDir });
  cleanup.push(() => b.close()); // runs before the dir removal (reverse order)

  await b.send('Page.navigate', { url: `${base}/index.html#${CASES.join(',')}` });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    ready = await b.ev((n) => document.querySelectorAll('[data-case] > div > .\\@container:first-child').length === n && document.fonts.status === 'loaded', CASES.length)
      .catch(() => false);
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  await b.ev(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
  assert.deepEqual(b.logs.map((x) => x.exception?.description || x.text), [], 'page threw');
  assert.ok(ready, `expected ${CASES.length} chat headers`);
  const requests = await b.ev(() => window.__requests);
  assert.deepEqual(requests.filter((x) => !/^GET \/api\/projects\/[^/]+\/preview$/.test(x)), [], 'only the preview GETs reach the fetch stub');

  const panes = await b.ev(measure);
  assert.deepEqual(panes.map((p) => p.key), CASES, 'one header per case');
  for (const p of panes) {
    const [, gh, state, lock] = p.key.split(':');
    const pin = known(p.key);
    const badge = overlap(p.badge, p.icons), gm = overlap(p.gm, p.icons);
    const px = `badge ${badge}px, line 2 ${gm}px under the icons (title column ${p.title.w}px)`;
    await t.test(p.key, () => {
      assert.equal(p.badgeText, { idle: 'idle', running: 'running', queued: 'queued' }[state], 'status badge text');
      assert.equal(p.stop, state !== 'idle', 'Stop shows iff the topic is busy');
      assert.equal(p.github, gh === 'gh', 'GitHub link');
      assert.equal(!!p.lock, lock === 'lock', 'lock icon');
      assert.equal(p.gmText, 'GM Lumen', 'line 2 GM span');
      // (a) the row never overflows: no scroll width, icon group inside the padding box, header inside the pane.
      assert.ok(p.scrollW <= p.clientW, `header scrollWidth ${p.scrollW} > clientWidth ${p.clientW}`);
      assert.ok(p.header.x >= p.pane.x - TOL && p.header.r <= p.pane.r + TOL, `header [${p.header.x}..${p.header.r}] outside pane [${p.pane.x}..${p.pane.r}]`);
      assert.ok(p.icons.r <= p.header.r - p.padR + TOL, `icon group ends at ${p.icons.r}, padding box at ${p.header.r - p.padR}`);
      assert.ok(p.title.x >= p.header.x + p.padL - TOL && p.title.w >= 0, `title column [${p.title.x}, w ${p.title.w}]`);
      // (b) badge and GM span against the icon group: zero, or the pinned known defect.
      for (const [what, got, max] of [['badge', badge, pin?.[0] || 0], ['line 2 GM span', gm, pin?.[1] || 0]]) {
        if (!max) assert.ok(got <= TOL, `${what} runs ${got}px under the icon group (expected none)`);
        else assert.ok(got > TOL && got <= max + TOL, `${what} overlap ${got}px, pinned at ${max}px (fixed? move the case out of KNOWN)`);
      }
      if (pin) t.diagnostic(`${p.key}: known overlap — ${px}`);
    });
    // A marker only (the pin above is the assertion), so the reporter lists every known overlap with its measured px.
    if (pin) await t.test(`${p.key} badge/line 2 clear of the icons`, { todo: `known defect: ${px}` }, () => {});
  }
});
