import { useEffect, useState } from 'react';
import { GitBranch, GitCommit, CloudUpload, RefreshCw, CircleCheck, CircleX, CircleDashed, ChevronDown, ChevronRight, Lock, Save, Terminal } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { timeAgo, dateTime } from '../lib/format.js';
import { GithubMark } from '../lib/icons.jsx';
import { cx, Badge, Button, Input, Field, Toggle, Spinner } from '../components/ui.jsx';

const STATUS = { pushed: ['ok', CircleCheck], committed: ['info', GitCommit], noop: ['neutral', CircleDashed], error: ['bad', CircleX] };

function ProjectRow({ p }) {
  const [url, setUrl] = useState(p.github_url || '');
  const [busy, setBusy] = useState(false);
  const dirty = url !== (p.github_url || '');
  const g = p.git || {};
  return (
    <tr className="border-t border-line align-middle">
      <td className="py-2.5 pl-4 pr-3">
        <div className="flex items-center gap-2 font-medium text-[0.84rem]">{p.protected && <Lock size={12} className="text-accent" />}{p.name}</div>
        <div className="text-[0.68rem] text-subtle mono truncate max-w-72">{p.path}</div>
      </td>
      <td className="pr-3 min-w-72">
        <div className="flex gap-1.5">
          <Input value={url} placeholder="https://github.com/owner/repo.git" onChange={(e) => setUrl(e.target.value)} className="flex-1 mono" />
          {dirty && <Button size="sm" icon={Save} onClick={async () => { await api.patch(`/api/projects/${p.id}`, { github_url: url }); toast.success('GitHub URL saved'); }}>Save</Button>}
        </div>
      </td>
      <td className="pr-3 text-xs whitespace-nowrap">
        {g.isRepo ? <span className="flex items-center gap-1.5"><GitBranch size={12} className="text-subtle" />{g.branch}{g.changes > 0 && <Badge tone="warn">{g.changes} changed</Badge>}</span> : <span className="text-subtle">not a repo yet</span>}
        {g.lastCommit && <div className="text-[0.68rem] text-subtle mt-0.5 truncate max-w-56" title={g.lastCommit.subject}><span className="mono">{g.lastCommit.hash}</span> {g.lastCommit.subject}</div>}
      </td>
      <td className="pr-3 text-xs text-subtle whitespace-nowrap">{p.last_synced_at ? timeAgo(p.last_synced_at) + ' ago' : '—'}</td>
      <td className="pr-3"><Toggle checked={p.auto_sync} onChange={(v) => api.patch(`/api/projects/${p.id}`, { auto_sync: v })} /></td>
      <td className="pr-4 text-right">
        <Button size="sm" icon={CloudUpload} loading={busy} disabled={!p.github_url && !g.isRepo && !url}
          onClick={async () => { setBusy(true); try { const r = await api.post(`/api/projects/${p.id}/sync`); toast[r.status === 'error' ? 'error' : 'success'](`${p.name}: ${r.message}`); } finally { setBusy(false); } }}>Sync now</Button>
      </td>
    </tr>
  );
}

export default function GitHub() {
  const tick = useStore((s) => s.syncTick);
  const projects = useStore((s) => s.projects);
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [openLog, setOpenLog] = useState(null);
  const load = () => api.get('/api/github').then((d) => { setData(d); setCfg((c) => c || d.settings); });
  useEffect(() => { load(); }, [tick, projects]);
  if (!data) return <div className="h-full flex items-center justify-center"><Spinner /></div>;
  const saveCfg = async () => { await api.put('/api/settings/github', cfg); toast.success('GitHub settings saved'); load(); };
  return (
    <div className="h-full overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-[1400px]">
        <div className="flex items-center gap-3">
          <GithubMark size={20} />
          <div>
            <div className="font-semibold text-[0.95rem]">GitHub</div>
            <div className="text-xs text-muted">After every completed mission the project is committed and pushed. Only source code is uploaded: dependencies, builds, data, secrets and large binaries are ignored.</div>
          </div>
          <Button className="ml-auto" variant="ghost" icon={RefreshCw} onClick={load}>Refresh</Button>
        </div>

        <section className="rounded-[var(--af-radius)] border border-line bg-panel p-4 grid gap-4 md:grid-cols-[1fr_1fr_160px_auto] items-end">
          <Field label="git config user.name"><Input className="mono" value={cfg.userName} onChange={(e) => setCfg({ ...cfg, userName: e.target.value })} /></Field>
          <Field label="git config user.email"><Input className="mono" value={cfg.userEmail} onChange={(e) => setCfg({ ...cfg, userEmail: e.target.value })} /></Field>
          <Field label="Branch"><Input className="mono" value={cfg.branch} onChange={(e) => setCfg({ ...cfg, branch: e.target.value })} /></Field>
          <div className="flex items-center gap-4 h-8">
            <Toggle checked={cfg.autoSync} onChange={(v) => setCfg({ ...cfg, autoSync: v })} label="Auto-upload" />
            <Button variant="primary" icon={Save} onClick={saveCfg}>Save</Button>
          </div>
        </section>

        <section className="rounded-[var(--af-radius)] border border-line bg-panel overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-[0.68rem] uppercase tracking-wider text-subtle">
              <tr><th className="font-medium py-2.5 pl-4">Project</th><th className="font-medium">GitHub URL</th><th className="font-medium">Repository</th><th className="font-medium">Last sync</th><th className="font-medium">Auto</th><th /></tr>
            </thead>
            <tbody>{data.projects.map((p) => <ProjectRow key={p.id} p={p} />)}</tbody>
          </table>
        </section>

        <div className="grid gap-4 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-[var(--af-radius)] border border-line bg-panel">
            <div className="h-9 px-4 flex items-center border-b border-line text-[0.72rem] font-semibold uppercase tracking-wider text-muted">Sync log</div>
            {!data.logs.length && <div className="p-4 text-xs text-subtle">No syncs yet.</div>}
            {data.logs.map((l) => {
              const [tone, Icon] = STATUS[l.status] || STATUS.noop;
              const open = openLog === l.id;
              return (
                <div key={l.id} className="border-b last:border-0 border-line">
                  <button onClick={() => setOpenLog(open ? null : l.id)} className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-hover">
                    {open ? <ChevronDown size={12} className="text-subtle" /> : <ChevronRight size={12} className="text-subtle" />}
                    <Icon size={14} className={cx(tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'info' && 'text-info', tone === 'neutral' && 'text-subtle')} />
                    <span className="text-[0.82rem] font-medium">{l.project_name}</span>
                    <span className="text-xs text-muted truncate flex-1">{l.message}</span>
                    {l.commit && <span className="mono text-xs text-subtle">{l.commit}</span>}
                    <Badge tone={tone}>{l.status}</Badge>
                    <span className="text-[0.68rem] text-subtle w-14 text-right" title={dateTime(l.created_at)}>{timeAgo(l.created_at)}</span>
                  </button>
                  {open && <pre className="mx-4 mb-3 p-3 rounded-lg bg-sunken border border-line text-[0.7rem] mono whitespace-pre-wrap max-h-72 overflow-auto">{l.output || '(no output)'}</pre>}
                </div>
              );
            })}
          </section>
          <section className="lg:col-span-2 rounded-[var(--af-radius)] border border-line bg-panel">
            <div className="h-9 px-4 flex items-center gap-2 border-b border-line text-[0.72rem] font-semibold uppercase tracking-wider text-muted"><Terminal size={12} />What a sync runs</div>
            <pre className="p-4 text-[0.72rem] mono leading-relaxed text-muted whitespace-pre-wrap">{`git init -b ${cfg.branch}            # first time only
git config user.name "${cfg.userName}"
git config user.email ${cfg.userEmail}
git remote add origin <project GitHub URL>
git add -A                  # respects .gitignore
git reset -- <files > 50MB> # never upload huge binaries
git commit -m "<mission>"
git branch -M ${cfg.branch}
git push -u origin ${cfg.branch}   # via gh credentials`}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}
