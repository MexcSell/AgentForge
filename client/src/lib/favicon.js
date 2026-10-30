// The browser-tab icon reflects live service status and unread notifications.
const COLORS = { online: '#22c55e', busy: '#3b82f6', degraded: '#f59e0b', restarting: '#f59e0b', down: '#ef4444', offline: '#6b7280' };
let last = '';

export function updateFavicon(status, unread, working) {
  const key = `${status}|${unread}|${working}`;
  if (key === last) return;
  last = key;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, '#818cf8');
  grad.addColorStop(1, '#6d28d9');
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(2, 2, 60, 60, 16);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 5.5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(18, 46); g.lineTo(30, 18); g.lineTo(42, 46);
  g.moveTo(22.5, 37); g.lineTo(37.5, 37);
  g.stroke();
  // status dot (bottom-right)
  g.fillStyle = '#0b0b0f';
  g.beginPath(); g.arc(50, 50, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = COLORS[status] || COLORS.offline;
  g.beginPath(); g.arc(50, 50, 9.5, 0, Math.PI * 2); g.fill();
  // unread badge (top-right)
  if (unread > 0) {
    const label = unread > 99 ? '99+' : String(unread);
    g.fillStyle = '#ef4444';
    const w = Math.max(26, 12 + label.length * 11);
    g.beginPath(); g.roundRect(64 - w, 0, w, 26, 13); g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 19px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 64 - w / 2, 14);
  }
  let link = document.getElementById('favicon');
  if (!link) {
    link = document.createElement('link');
    link.id = 'favicon';
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = c.toDataURL('image/png');
  const prefix = unread ? `(${unread}) ` : '';
  const state = status === 'online' ? '' : ` · ${status}`;
  document.title = `${prefix}AgentForge${working ? ` · ${working} running` : ''}${state}`;
}
