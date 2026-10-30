import { create } from 'zustand';
import { api } from '../../lib/api.js';
import { toast } from '../../lib/toast.js';

// Shared refresh tick so every pane reloads after a mutation.
export const useFs = create((set) => ({ tick: 0, bump: () => set((s) => ({ tick: s.tick + 1 })) }));

export const DRAG_TYPE = 'application/x-agentforge-paths';

export const join = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
export const parentOf = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
export const baseName = (p) => p.replace(/\/$/, '').split('/').pop();

export async function transfer(sources, dest, mode) {
  const { results } = await api.post('/api/fs/transfer', { sources, dest, mode });
  const failed = results.filter((r) => r.error);
  if (failed.length) toast.error(`${failed.length} item(s) failed`, failed.map((f) => `${baseName(f.src)}: ${f.error}`).join('\n'));
  const ok = results.filter((r) => r.target).length;
  if (ok) toast.success(`${mode === 'move' ? 'Moved' : 'Copied'} ${ok} item${ok > 1 ? 's' : ''}`);
  useFs.getState().bump();
}

export async function removePaths(paths) {
  const { results } = await api.post('/api/fs/delete', { paths });
  const failed = results.filter((r) => r.error);
  if (failed.length) toast.error('Some items were not deleted', failed.map((f) => `${baseName(f.path)}: ${f.error}`).join('\n'));
  useFs.getState().bump();
}

export async function uploadTo(dir, files) {
  if (!files.length) return;
  const { saved } = await api.upload(`/api/fs/upload?dir=${encodeURIComponent(dir)}`, files);
  toast.success(`Uploaded ${saved.length} file${saved.length > 1 ? 's' : ''}`);
  useFs.getState().bump();
}
