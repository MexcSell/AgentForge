// The device fingerprint sent with sign-up and login (server/services/auth.js hashes and matches it). Only
// characteristics of the computer and browser, never an IP or other network address, and never the window size, so
// resizing the browser does not change it. The server tolerates a few soft changes (monitor, language, timezone).

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
