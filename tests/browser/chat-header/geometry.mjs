// Geometry for the chat header: measure() runs inside the page (serialized, so it must stay self-contained), overlap() in Node.

// One entry per [data-case] pane: the header row (CommandWindow's @container div), its title column, line 1 parts (lock,
// name, status badge), line 2's GM span, the icon group and which optional controls rendered.
export function measure() {
  const R = (b) => ({ x: +b.left.toFixed(2), y: +b.top.toFixed(2), r: +b.right.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) });
  const r = (el) => el ? R(el.getBoundingClientRect()) : null;
  return [...document.querySelectorAll('[data-case]')].map((pane) => {
    const header = pane.firstElementChild?.firstElementChild;
    const [title, icons] = header ? header.children : [];
    const line1 = title?.children[0], line2 = title?.children[1];
    const badge = line1?.lastElementChild;
    const cs = header && getComputedStyle(header);
    return { key: pane.dataset.case, w: +pane.dataset.w, pane: r(pane), header: r(header),
      padL: parseFloat(cs?.paddingLeft), padR: parseFloat(cs?.paddingRight), scrollW: header?.scrollWidth, clientW: header?.clientWidth,
      title: r(title), name: r(line1?.querySelector('span.truncate')), lock: r(line1?.querySelector('svg')), badge: r(badge), badgeText: badge?.textContent,
      gm: r(line2?.querySelector(':scope > span.shrink-0')), gmText: line2?.querySelector(':scope > span.shrink-0')?.textContent, icons: r(icons),
      github: !!icons?.querySelector('a[href*="github"]'), stop: [...(icons?.querySelectorAll('button') || [])].some((x) => x.textContent.trim() === 'Stop') };
  });
}

// Horizontal px of a that lies under b when their boxes also intersect vertically, else 0 (the gap is reported separately).
export function overlap(a, b) {
  if (!a || !b || Math.min(a.b, b.b) - Math.max(a.y, b.y) <= 0) return 0;
  return Math.max(0, +(Math.min(a.r, b.r) - Math.max(a.x, b.x)).toFixed(2));
}
