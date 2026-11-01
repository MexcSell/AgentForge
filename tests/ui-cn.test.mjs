// ui.jsx class merging (client/src/components/ui.jsx): components merge with `cn` (tailwind-merge over clsx, caller className last).
// Baseline: a second virtual copy of ui.jsx with `cn` rewritten to plain clsx — without a className both must render the same
// class sets. Rendering is server-side (react-dom/server), so no jsdom is needed.
// AF_UI_SOURCE=<file> loads that file instead of the real ui.jsx (for mutant runs from outside the repo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const req = createRequire(`${ROOT}/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const h = React.createElement;

const DIR = `${ROOT}/client/src/components`;
const CN_ANCHOR = 'const cn = (...args) => twMerge(clsx(...args));';

let server, N, B;

before(async () => {
  const src = readFileSync(process.env.AF_UI_SOURCE || `${DIR}/ui.jsx`, 'utf8');
  if (src.split(CN_ANCHOR).length !== 2) throw new Error(`ui-cn baseline: expected exactly one "${CN_ANCHOR}" line in ui.jsx — update the test if cn was renamed or changed`);
  const virt = { [`${DIR}/ui.cn-test.jsx`]: src, [`${DIR}/ui.clsx-test.jsx`]: src.replace(CN_ANCHOR, 'const cn = clsx;') };
  const { createServer } = await import(pathToFileURL(req.resolve('vite')).href);
  server = await createServer({
    configFile: `${ROOT}/vite.config.js`,
    root: `${ROOT}/client`,
    logLevel: 'error',
    appType: 'custom',
    // Vite 8 still binds the HMR WebSocket (port 24678) unless ws:false; the parallel node --test files clashed on it.
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    plugins: [{
      name: 'ui-cn-virtual', enforce: 'pre',
      resolveId: (id) => (virt[`${ROOT}/client${id}`] ? `${ROOT}/client${id}` : null),
      load: (id) => virt[id.split('?')[0]],
    }],
  });
  N = await server.ssrLoadModule('/src/components/ui.cn-test.jsx');
  B = await server.ssrLoadModule('/src/components/ui.clsx-test.jsx');
});

after(async () => { await server?.close(); });

const html = (el) => renderToStaticMarkup(el);
const classLists = (s) => [...s.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/).filter(Boolean));
const sortedSets = (s) => classLists(s).map((c) => [...c].sort().join(' '));
const rootClasses = (el) => classLists(html(el))[0];
const Icon = (p) => h('svg', { 'data-icon': 1, width: p.size });
const has = (c, list) => list.every((x) => c.includes(x));
const lacks = (c, list) => list.every((x) => !c.includes(x));
const show = (c) => `[${c.join(' ')}]`;

const TONES = ['neutral', 'accent', 'ok', 'warn', 'bad', 'info'];
const toneColor = (tone) => `text-${tone === 'neutral' ? 'muted' : tone}`;

// --- 1. no className: same class set per element as the clsx baseline
const cases = [];
for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'outline']) for (const size of ['sm', 'md', 'lg']) for (const loading of [false, true])
  cases.push([`Button ${variant} ${size} loading=${loading}`, (M) => h(M.Button, { variant, size, loading, icon: Icon }, 'x')]);
for (const size of ['sm', 'md', 'lg']) for (const active of [false, true]) for (const tone of [undefined, 'danger'])
  for (const extra of [{}, { badge: 3 }, { badge: 120 }, { dot: 'warn' }, { dot: 'zzz' }])
    cases.push([`IconButton ${size} active=${active} tone=${tone} ${JSON.stringify(extra)}`, (M) => h(M.IconButton, { icon: Icon, label: 'L', size, active, tone, ...extra })]);
for (const tone of [...TONES, 'nope']) cases.push([`Badge ${tone}`, (M) => h(M.Badge, { tone, icon: Icon }, 'b')]);
cases.push(['Badge default', (M) => h(M.Badge, null, 'b')]);
for (const p of [{}, { icon: Icon }, { right: 'r' }, { icon: Icon, right: 'r' }]) cases.push([`Input ${Object.keys(p).join('+') || 'plain'}`, (M) => h(M.Input, p)]);
cases.push(['Textarea', (M) => h(M.Textarea)], ['Select', (M) => h(M.Select, null, h('option', null, 'a'))]);
for (const p of [{ checked: true, label: 'x' }, { checked: false }]) cases.push([`Toggle ${JSON.stringify(p)}`, (M) => h(M.Toggle, { onChange() {}, ...p })]);
for (const status of ['online', 'working', 'busy', 'degraded', 'down', 'idle', 'whatever', undefined]) cases.push([`StatusDot ${status}`, (M) => h(M.StatusDot, { status })]);
for (const tone of ['accent', 'ok', 'warn', 'bad', 'series', 'zzz']) for (const striped of [false, true])
  cases.push([`Progress ${tone} striped=${striped}`, (M) => h(M.Progress, { value: 40, tone, striped })]);
cases.push(['Spinner', (M) => h(M.Spinner)], ['Spinner 20', (M) => h(M.Spinner, { size: 20 })]);
const tabs = [{ id: 'a', label: 'A', icon: Icon, count: 2 }, { id: 'b', label: 'B', count: 0 }, { id: 'c', label: 'C' }];
for (const size of ['sm', 'md']) cases.push([`Tabs ${size}`, (M) => h(M.Tabs, { tabs, value: 'a', size, onChange() {} })]);
for (const [used, limit] of [[5, 10], [85, 100], [120, 100], [1, 0]]) cases.push([`Meter ${used}/${limit}`, (M) => h(M.Meter, { label: 'L', used, limit, icon: Icon })]);
const agent = { id: 'a', name: 'Pixel', role: 'frontend' };
for (const status of [undefined, 'idle', 'working', 'failed']) cases.push([`AgentAvatar ${status}`, (M) => h(M.AgentAvatar, { agent: { ...agent, status }, size: 24 })]);
cases.push(['AgentAvatar role', (M) => h(M.AgentAvatar, { role: 'qa', status: 'running' })]);
cases.push(['Empty', (M) => h(M.Empty, { icon: Icon, title: 't', action: 'a' }, 'c')]);
cases.push(['PanelHeader', (M) => h(M.PanelHeader, { icon: Icon, title: 'T', count: 3 }, 'kids')], ['PanelHeader bare', (M) => h(M.PanelHeader, { title: 'T' })]);

test('without className, cn renders the same class sets as plain clsx', () => {
  for (const [name, mk] of cases) {
    const base = sortedSets(html(mk(B))), got = sortedSets(html(mk(N)));
    assert.ok(base.length > 0, `${name}: rendered no classes`);
    assert.deepEqual(got, base, `${name}\n  clsx ${JSON.stringify(base)}\n  cn   ${JSON.stringify(got)}`);
  }
});

// --- 2. caller className overrides conflicting base utilities
test('IconButton className overrides position and size', () => {
  let c = rootClasses(h(N.IconButton, { icon: Icon, label: 'L', className: 'absolute' }));
  assert.ok(has(c, ['absolute']) && lacks(c, ['relative']), `IconButton 'absolute' should drop 'relative': ${show(c)}`);
  c = rootClasses(h(N.IconButton, { icon: Icon, label: 'L', size: 'sm', className: 'size-4' }));
  assert.ok(has(c, ['size-4']) && lacks(c, ['size-6']), `IconButton sm 'size-4' should drop 'size-6': ${show(c)}`);
});

test('Badge className overrides height, padding, font size and color', () => {
  let c = rootClasses(h(N.Badge, { className: 'h-4 px-1 text-[0.6rem]' }, 'b'));
  assert.ok(has(c, ['h-4', 'px-1', 'text-[0.6rem]']) && lacks(c, ['h-5', 'px-1.5', 'text-[0.7rem]']), `Badge 'h-4 px-1 text-[0.6rem]': ${show(c)}`);
  for (const tone of TONES) {
    const color = toneColor(tone);
    c = rootClasses(h(N.Badge, { tone, className: 'text-[0.6rem]' }, 'b'));
    assert.ok(has(c, [color, 'text-[0.6rem]']) && lacks(c, ['text-[0.7rem]']), `Badge ${tone} with only a font-size override should keep ${color}: ${show(c)}`);
    for (const cls of ['text-fg text-xs', 'text-xs text-fg']) {
      c = rootClasses(h(N.Badge, { tone, className: cls }, 'b'));
      assert.ok(has(c, ['text-fg', 'text-xs']) && lacks(c, [color, 'text-[0.7rem]']), `Badge ${tone} '${cls}' should replace ${color} and text-[0.7rem]: ${show(c)}`);
    }
  }
});

test('Button, Progress, Spinner and StatusDot overrides keep unrelated base classes', () => {
  let c = rootClasses(h(N.Button, { variant: 'ghost', className: 'h-6 px-2' }, 'x'));
  assert.ok(has(c, ['h-6', 'px-2', 'text-[0.82rem]']) && lacks(c, ['h-8', 'px-3']), `Button ghost 'h-6 px-2': ${show(c)}`);
  const p = classLists(html(h(N.Progress, { value: 5, striped: true, className: 'h-1 bg-ok' })));
  assert.ok(has(p[0], ['h-1', 'bg-ok']) && lacks(p[0], ['h-1.5', 'bg-hover']), `Progress track 'h-1 bg-ok': ${show(p[0])}`);
  assert.ok(p[1]?.includes('af-stripes'), `Progress bar should keep af-stripes: ${show(p[1] || [])}`);
  c = rootClasses(h(N.Spinner, { className: 'text-muted' }));
  assert.ok(has(c, ['text-muted', 'animate-spin']) && lacks(c, ['text-accent']), `Spinner 'text-muted': ${show(c)}`);
  c = rootClasses(h(N.StatusDot, { status: 'down', className: 'size-1.5' }));
  assert.ok(has(c, ['size-1.5', 'bg-bad']) && lacks(c, ['size-2']), `StatusDot 'size-1.5': ${show(c)}`);
});

// --- 3. theme tokens, arbitrary values and palette colors replace the base color (and font size stays separate)
test('theme tokens and arbitrary colors replace the base color', () => {
  for (const [cls, gone] of [['text-white', 'text-muted'], ['bg-zinc-900', 'bg-hover'], ['border-transparent', 'border-line'],
    ['bg-accent/40', 'bg-hover'], ['text-current', 'text-muted'], ['bg-[var(--x)]', 'bg-hover']]) {
    const c = rootClasses(h(N.Badge, { className: cls }, 'b'));
    assert.ok(has(c, [cls, 'text-[0.7rem]']) && lacks(c, [gone]), `Badge '${cls}' should replace ${gone} and keep text-[0.7rem]: ${show(c)}`);
  }
});

// --- 4. project utilities that look like tailwind groups are never dropped
test('custom utilities are kept next to similar-looking utilities', () => {
  for (const [custom, other] of [['tabular', 'font-mono'], ['af-stripes', 'bg-ok'], ['shadow-af', 'shadow-sm'], ['text-grad', 'text-fg'], ['rounded-af', 'rounded-md'],
    ['grad-accent', 'bg-raised'], ['mono', 'font-sans'], ['animate-af-in', 'animate-spin'], ['row-h', 'h-8'], ['shadow-af-lg', 'shadow-af']]) {
    const c = rootClasses(h(N.Badge, { className: `${custom} ${other}` }, 'b'));
    assert.ok(has(c, [custom, other]), `Badge '${custom} ${other}' should keep both: ${show(c)}`);
  }
});

// --- 5. exports
test('cx stays plain clsx and cn is not exported', () => {
  const s = N.cx('a', 'h-4', 'h-5');
  assert.equal(s, 'a h-4 h-5', `cx should keep conflicting classes, got '${s}'`);
  assert.ok(!('cn' in N), 'cn should not be exported from ui.jsx');
});

// --- drift guard: every @theme color in styles.css must be a color for tailwind-merge (THEME_COLORS in ui.jsx)
test('every --color-* in the styles.css @theme block replaces a base text color', () => {
  const css = readFileSync(`${ROOT}/client/src/styles.css`, 'utf8');
  const block = css.match(/@theme[^{]*\{([^}]*)\}/);
  assert.ok(block, 'no @theme block found in client/src/styles.css');
  const names = [...block[1].matchAll(/--color-([\w-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(names.length >= 20, `expected the @theme color list, found ${JSON.stringify(names)}`);
  for (const name of names) {
    const tone = name === 'muted' ? 'accent' : 'neutral';
    const c = rootClasses(h(N.Badge, { tone, className: `text-${name}` }, 'b'));
    const gone = toneColor(tone);
    assert.ok(has(c, [`text-${name}`, 'text-[0.7rem]']) && lacks(c, [gone]),
      `text-${name} (--color-${name} in styles.css) should replace ${gone} — is '${name}' missing from THEME_COLORS in ui.jsx? ${show(c)}`);
  }
});
