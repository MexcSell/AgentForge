// Geometry for the Org cards: measure() runs inside the page (serialized, so it must stay self-contained), check() runs in Node.

// One entry per pane: card boxes, name-row parts, text ink (Range rects, so truncated text is clipped to its box later),
// the Release button's box, computed position and an elementFromPoint hit test at its centre.
export function measure() {
  const R = (b) => ({ x: +b.left.toFixed(2), y: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) });
  const r = (el) => el ? R(el.getBoundingClientRect()) : null;
  const ink = (el) => { if (!el) return null; const rg = document.createRange(); rg.selectNodeContents(el); return R(rg.getBoundingClientRect()); };
  const TIERS = /^(Executive|Management|Specialist|Verification|Evolution)$/;
  return [...document.querySelectorAll('[data-pane]')].map((v) => ({ w: +v.dataset.w, pane: r(v), cards: [...v.querySelectorAll('[aria-label="Team hierarchy"] button[data-agent]')].map((c) => {
    const li = c.closest('li'); const rel = [...li.children].find((x) => x.tagName === 'DIV')?.querySelector(':scope > [data-release]') || null;
    const col = c.querySelector(':scope > span > span.flex-1');
    const nameRow = col.children[0]; const nameEl = nameRow.children[0];
    const badges = [...nameRow.parentElement.querySelectorAll('span')].filter((b) => /^(GM|L\d+)$/.test(b.textContent) && b.className.includes('inline-flex'));
    const tierEl = [...col.children].find((x) => x !== nameRow && x.getAttribute('role') !== 'progressbar' && TIERS.test(x.textContent.trim()))
      || [...col.querySelectorAll('span')].find((x) => TIERS.test(x.textContent.trim()) && !x.className.includes('inline-flex')) || null;
    const hit = rel && (() => { const k = rel.getBoundingClientRect(); const e = document.elementFromPoint(k.left + k.width / 2, k.top + k.height / 2); return !!e && rel.contains(e); })();
    // Where the Release should be: 16px left of the card's right edge, on the name row's centre line.
    const cornerHit = rel && (() => { const k = c.getBoundingClientRect(), n = nameRow.getBoundingClientRect(); const e = document.elementFromPoint(k.right - 16, (n.top + n.bottom) / 2); return !!e && rel.contains(e); })();
    const cs = rel && getComputedStyle(rel);
    return { agent: c.dataset.agent, name: nameEl.textContent, card: r(c), nameRow: r(nameRow), nameBox: r(nameEl), nameInk: ink(nameEl),
      badges: badges.map((x) => ({ t: x.textContent, ...r(x), fs: getComputedStyle(x).fontSize, visible: x.getBoundingClientRect().width > 0 })),
      tier: r(tierEl), tierInk: ink(tierEl), xp: r(col.querySelector('[role=progressbar]')), bottom: r(c.children[1]),
      release: r(rel), relPos: cs?.position, relHit: hit, relCornerHit: cornerHit, relAria: rel?.getAttribute('aria-disabled') };
  }) }));
}

const ov = (a, b) => a && b ? Math.min(a.r, b.r) - Math.max(a.x, b.x) > 0.01 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 0.01 : false;
const inside = (a, o, eps = 0.01) => a.x >= o.x - eps && a.r <= o.r + eps && a.y >= o.y - eps && a.b <= o.b + eps;
const cy = (b) => (b.y + b.b) / 2;
const box = (b) => b ? `[x ${b.x}..${b.r}, y ${b.y}..${b.b}]` : 'none';

// Returns { passed, failed: ['243px Pixel: release position absolute — got relative', ...] }.
export function check(panes, { gm = 'a1', busy = ['a3', 'a5'] } = {}) {
  let passed = 0; const failed = [];
  const ck = (w, who, label, ok, info = '') => { if (ok) passed++; else failed.push(`${w}px ${who}: ${label}${info ? ` — ${info}` : ''}`); };
  for (const { w, pane, cards } of panes) {
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      ck(w, `${cards[i].agent}/${cards[j].agent}`, 'cards disjoint', !ov(cards[i].card, cards[j].card), `${box(cards[i].card)} vs ${box(cards[j].card)}`);
    }
    for (const c of cards) {
      const n = `${c.agent} "${c.name.slice(0, 14)}"`; const isGm = c.agent === gm;
      ck(w, n, 'card inside pane', inside(c.card, { ...pane, b: Infinity }), `card ${box(c.card)} pane ${box(pane)}`);
      const L = c.badges.find((x) => x.t.startsWith('L')); const G = c.badges.find((x) => x.t === 'GM');
      ck(w, n, 'L badge present, visible, inside card', !!L && L.visible && inside(L, c.card), `L ${box(L)} card ${box(c.card)}`);
      ck(w, n, 'L badge on name row, after the name', !!L && Math.abs(cy(L) - cy(c.nameRow)) < 1.5 && L.x >= Math.min(c.nameInk.r, c.nameBox.r) - 0.01,
        L && `L.cy=${cy(L).toFixed(1)} row.cy=${cy(c.nameRow).toFixed(1)} L.x=${L.x} name.r=${Math.min(c.nameInk.r, c.nameBox.r)}`);
      ck(w, n, 'L badge smaller (h<18px, font<10.15px)', !!L && L.h < 18 && parseFloat(L.fs) < 10.15, L && `h=${L.h} fs=${L.fs}`);
      if (isGm) ck(w, n, 'GM badge visible on the name row, before L', !!G && G.visible && !!L && G.r <= L.x + 0.01 && Math.abs(cy(G) - cy(L)) < 1.5, `GM ${box(G)} L ${box(L)}`);
      const name = c.nameInk.r > c.nameBox.r ? { ...c.nameInk, r: c.nameBox.r } : c.nameInk;
      const parts = [['name', name], ['GM', G], ['L', L], ['tier', c.tierInk], ['xp', c.xp], ['bottom', c.bottom], ['release', c.release]].filter(([, b]) => b);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        ck(w, n, `${parts[i][0]}×${parts[j][0]} no overlap`, !ov(parts[i][1], parts[j][1]), `${box(parts[i][1])} vs ${box(parts[j][1])}`);
      }
      if (c.tier) ck(w, n, 'tier below name row', c.tier.y >= c.nameRow.b - 0.5, `tier.y=${c.tier.y} row.b=${c.nameRow.b}`);
      if (isGm) { ck(w, n, 'GM has no Release', !c.release, `release ${box(c.release)}`); continue; }
      ck(w, n, 'Release exists', !!c.release);
      if (!c.release) continue;
      const Rl = c.release, C = c.card;
      const contentR = Math.max(...[c.nameBox.r, L?.r, G?.r].filter(Boolean));
      ck(w, n, 'release position absolute', c.relPos === 'absolute', `computed position=${c.relPos}`);
      ck(w, n, 'release inside card', inside(Rl, C), `release ${box(Rl)} card ${box(C)}`);
      ck(w, n, 'release corner (≤8px from top/right edges)', C.r - Rl.r >= 0 && C.r - Rl.r <= 8 && Rl.y - C.y >= 0 && Rl.y - C.y <= 8,
        `dTop=${(Rl.y - C.y).toFixed(2)} dRight=${(C.r - Rl.r).toFixed(2)}`);
      ck(w, n, 'release centred on name row (±3px)', Math.abs(cy(Rl) - cy(c.nameRow)) < 3, `release.cy=${cy(Rl).toFixed(2)} row.cy=${cy(c.nameRow).toFixed(2)}`);
      ck(w, n, 'release hit-test (elementFromPoint at its centre)', c.relHit === true, `hit=${c.relHit}`);
      ck(w, n, 'release hit-test at the card corner (16px from the right, name-row centre)', c.relCornerHit === true, `hit=${c.relCornerHit}`);
      ck(w, n, 'gap name-row content → release ≥2px', Rl.x - contentR >= 2, `gap=${(Rl.x - contentR).toFixed(2)}`);
      ck(w, n, 'busy ⇔ aria-disabled', (c.relAria === 'true') === busy.includes(c.agent), `aria-disabled=${c.relAria}`);
    }
  }
  return { passed, failed };
}
