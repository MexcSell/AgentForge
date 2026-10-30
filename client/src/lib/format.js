export function timeAgo(d) {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function compact(n) {
  n = Number(n || 0);
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (Math.abs(n) < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function bytes(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export const usd = (n) => `$${Number(n || 0).toFixed(Number(n) < 1 ? 3 : 2)}`;

export function clockTime(d) {
  return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(d) {
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const pct = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
