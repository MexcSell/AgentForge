// Shared jsdom + Vite SSR harness for client component tests (run with `npm test`, i.e. `node --test`).
// Installs jsdom globals, then loads client modules through the repo's vite.config.js (React plugin, aliases)
// in middleware mode — nothing is built or written to dist.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const req = createRequire(`${ROOT}/package.json`);

// Must run before react-dom is first required: React feature-detects the DOM once at module load.
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:4800/', pretendToBeVisual: true });
  const w = dom.window;
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('window', w);
  for (const k of ['document', 'HTMLElement', 'Element', 'Node', 'Text', 'SVGElement', 'DocumentFragment', 'MutationObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'DOMRect',
    'localStorage', 'sessionStorage', 'location', 'HTMLInputElement', 'innerWidth', 'innerHeight']) {
    if (w[k] !== undefined) def(k, typeof w[k] === 'function' && /^[a-z]/.test(k) ? w[k].bind(w) : w[k]);
  }
  def('navigator', w.navigator);
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  def('ResizeObserver', ResizeObserver); w.ResizeObserver = ResizeObserver;
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  def('matchMedia', matchMedia); w.matchMedia = matchMedia;
  def('WebSocket', class { constructor() { this.readyState = 0; } send() {} close() {} });
  def('IS_REACT_ACT_ENVIRONMENT', true);
  w.HTMLElement.prototype.scrollIntoView = function () {};
  return w;
}

// stubs: { 'src/path/from/client.jsx': 'module source' } replaces heavy modules the test does not exercise.
export async function createLoader({ stubs = {} } = {}) {
  const { createServer } = await import(pathToFileURL(req.resolve('vite')).href);
  const byPath = Object.fromEntries(Object.entries(stubs).map(([k, v]) => [`${ROOT}/client/${k}`, v]));
  const server = await createServer({
    configFile: `${ROOT}/vite.config.js`,
    root: `${ROOT}/client`,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, watch: null, hmr: false },
    plugins: [{ name: 'test-stubs', enforce: 'pre', load: (id) => byPath[id.split('?')[0]] }],
  });
  return { load: (path) => server.ssrLoadModule(path), close: () => server.close() };
}

export const window = installDom();
export const React = req('react');
export const { createRoot } = req('react-dom/client');
