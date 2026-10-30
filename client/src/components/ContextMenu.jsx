import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { cx, Kbd } from './ui.jsx';

const useMenu = create((set) => ({ menu: null, open: (menu) => set({ menu }), close: () => set({ menu: null }) }));

/** openContextMenu(event, [{ label, icon, onClick, danger, disabled, shortcut } | '-']) */
export function openContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().open({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuHost() {
  const { menu, close } = useMenu();
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 8), y: Math.min(menu.y, innerHeight - r.height - 8) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const off = () => close();
    const key = (e) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', off);
    window.addEventListener('blur', off);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('blur', off); window.removeEventListener('keydown', key); };
  }, [menu, close]);
  if (!menu) return null;
  return createPortal(
    <div ref={ref} onMouseDown={(e) => e.stopPropagation()} className="fixed z-[60] min-w-48 py-1 rounded-xl border border-line bg-raised shadow-af-lg animate-af-in" style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.items.filter(Boolean).map((it, i) => it === '-' ? <div key={i} className="my-1 h-px bg-line" /> : (
        <button key={i} role="menuitem" disabled={it.disabled} onClick={() => { close(); it.onClick?.(); }}
          className={cx('w-[calc(100%-8px)] mx-1 flex items-center gap-2.5 h-7 px-2 rounded-md text-[0.8rem] text-left disabled:opacity-40', it.danger ? 'text-bad hover:bg-bad-soft' : 'text-fg hover:bg-accent-soft')}>
          {it.icon ? <it.icon size={14} className={it.danger ? '' : 'text-muted'} /> : <span className="w-3.5" />}
          <span className="flex-1">{it.label}</span>
          {it.shortcut && <Kbd>{it.shortcut}</Kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
