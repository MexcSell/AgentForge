import { create } from 'zustand';

export const useToasts = create((set) => ({
  items: [],
  push: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ items: [...s.items.slice(-4), { id, ...t }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.duration || 4200);
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

const push = (kind) => (title, body, extra) => useToasts.getState().push({ kind, title, body, ...extra });
export const toast = { info: push('info'), success: push('success'), error: push('error'), warn: push('warn') };
