import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Maximize2, Minimize2 } from 'lucide-react';
import { cx, IconButton } from './ui.jsx';

const SIZES = { sm: 'w-[min(440px,94vw)]', md: 'w-[min(620px,94vw)]', lg: 'w-[min(920px,95vw)] h-[min(720px,90vh)]', xl: 'w-[min(1280px,96vw)] h-[min(860px,92vh)]', full: 'w-[97vw] h-[94vh]' };

// Open modals as { node, onClose } refs. The top one is the backdrop that comes last in the document: every
// backdrop is a fixed z-50 child of <body>, so DOM order is the paint order, whatever order the effects ran in
// (a parent and child opening in one commit run the child's effect first, and React also places its portal first).
const stack = [];
const topModal = () => stack.reduce((a, b) => (a.node.current && b.node.current && a.node.current.compareDocumentPosition(b.node.current) & Node.DOCUMENT_POSITION_PRECEDING ? a : b));
// Bubble phase on purpose: editors, the terminal and inputs inside the dialog see Esc first, and App's
// capture-phase shortcuts (Ctrl+K, Alt+digit) run before us untouched.
const onStackKey = (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.stopPropagation();
  e.preventDefault();
  topModal().onClose.current?.();
};

/** Dialog that can be "spread" to fill the viewport. */
export function Modal({ open, onClose, title, icon: Icon, subtitle, size = 'md', actions, footer, children, bodyClass, spreadable = size === 'lg' || size === 'xl' }) {
  const [spread, setSpread] = useState(false);
  const node = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { node, onClose: onCloseRef };
    stack.push(entry);
    if (stack.length === 1) window.addEventListener('keydown', onStackKey);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (!stack.length) window.removeEventListener('keydown', onStackKey);
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div ref={node} className="fixed inset-0 z-50 flex items-center justify-center p-3 animate-af-fade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px] pointer-events-none" />
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('relative flex flex-col bg-panel border border-line rounded-2xl shadow-af-lg overflow-hidden animate-af-in max-h-[94vh]', spread ? 'w-[98vw] h-[96vh]' : SIZES[size])}>
        {title && (
          <div className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
            {Icon && <span className="size-7 rounded-lg bg-accent-soft text-accent flex items-center justify-center"><Icon size={15} /></span>}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{title}</div>
              {subtitle && <div className="text-[0.7rem] text-subtle truncate -mt-0.5">{subtitle}</div>}
            </div>
            {actions}
            {spreadable && <IconButton icon={spread ? Minimize2 : Maximize2} label={spread ? 'Restore' : 'Spread'} onClick={() => setSpread(!spread)} />}
            <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
          </div>
        )}
        <div className={cx('flex-1 min-h-0 overflow-auto', bodyClass ?? 'p-4')}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line shrink-0 bg-sunken/40">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ open, title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <button className="h-8 px-3 rounded-lg text-[0.82rem] text-muted hover:bg-hover" onClick={onClose}>Cancel</button>
        <button autoFocus disabled={busy} className={cx('h-8 px-3 rounded-lg text-[0.82rem] font-medium', danger ? 'bg-bad text-white hover:brightness-110' : 'grad-accent text-accent-fg')}
          onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</button>
      </>}>
      <div className="text-[0.85rem] text-muted leading-relaxed">{body}</div>
    </Modal>
  );
}
