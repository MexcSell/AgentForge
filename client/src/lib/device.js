// This browser's device identity (server/services/auth.js). deviceCredential(): a random 256-bit secret created the
// first time it is needed and kept in localStorage; it is what signs the account in, and the server stores only its
// hash. info: what the administrator sees at approval (OS, browser, screen, a label), never trusted for sign-in.
// deviceFingerprint(): the legacy fingerprint, still sent with a password login so accounts created before device
// secrets can bind one. None of it holds an IP or other network address, or the window size.

export const DEVICE_KEY = 'agentforge.device';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The stored secret, or null when this browser has none yet (or no storage). */
export function storedDeviceSecret(storage = globalThis.localStorage) {
  try {
    const s = storage?.getItem(DEVICE_KEY);
    return s && /^[A-Za-z0-9_-]{43,128}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** This browser's secret, created and stored on first use. crypto.getRandomValues works on plain-http origins too. */
export function deviceSecret(storage = globalThis.localStorage, rand = globalThis.crypto) {
  const have = storedDeviceSecret(storage);
  if (have) return have;
  const secret = b64url(rand.getRandomValues(new Uint8Array(32)));
  try { storage.setItem(DEVICE_KEY, secret); } catch { /* private mode: lives for this page only */ }
  return secret;
}

const OSES = [[/Windows/i, 'Windows'], [/Android/i, 'Android'], [/iPhone|iPad|iPod/i, 'iOS'], [/CrOS/i, 'ChromeOS'], [/Mac OS X|Macintosh/i, 'macOS'], [/Linux/i, 'Linux']];
const BROWSERS = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari']];
const pick = (list, text) => list.find(([re]) => re.test(text))?.[1] || 'Unknown';

/** Descriptive info about this computer, shown to the administrator. label: "Chrome on Linux". */
export function deviceInfo(nav = globalThis.navigator || {}, scr = globalThis.screen) {
  const ua = String(nav.userAgent || '');
  const os = pick(OSES, ua);
  const browser = pick(BROWSERS, ua);
  return {
    label: `${browser} on ${os}`,
    os,
    browser,
    platform: String(nav.userAgentData?.platform || nav.platform || ''),
    userAgent: ua.slice(0, 400),
    screen: scr?.width ? `${scr.width}x${scr.height}` : '',
    language: String(nav.language || ''),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  };
}

/** What sign-up, device sign-in and password login send as `device`. */
export const deviceCredential = (nav, scr, storage) => ({ secret: deviceSecret(storage), info: deviceInfo(nav, scr) });

// FNV-1a, 32-bit: crypto.subtle is missing on plain-http origins other than localhost.
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function gpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return 'no-webgl';
  }
}

function canvasHash() {
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = '16px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(100, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('AgentForge ✓ 0123456789', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('AgentForge ✓ 0123456789', 4, 17);
    return fnv(c.toDataURL());
  } catch {
    return '';
  }
}

/** { platform, cores, memory, gpu, canvas, touch, screen, colorDepth, timezone, language } of this computer. */
export function deviceFingerprint(nav = globalThis.navigator || {}, scr = globalThis.screen) {
  // Screen size sorted, so rotating a display is no change.
  const [a, b] = [scr?.width || 0, scr?.height || 0].sort((x, y) => y - x);
  return {
    platform: nav.userAgentData?.platform || nav.platform || 'unknown',
    cores: nav.hardwareConcurrency || 0,
    memory: nav.deviceMemory || 0,
    gpu: gpu(),
    canvas: canvasHash(),
    touch: nav.maxTouchPoints || 0,
    screen: `${a}x${b}`,
    colorDepth: scr?.colorDepth || 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    language: nav.language || '',
  };
}
