import { useEffect, useMemo, useState } from 'react';
import { Users as UsersIcon, Check, X, Ban, Power, Trash2, MonitorSmartphone, ShieldCheck, RefreshCw, Save } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { dateTime } from '../lib/format.js';
import { cx, Button, Badge, Empty, Spinner, Toggle } from '../components/ui.jsx';

const STATUS = { pending: 'warn', active: 'ok', disabled: 'neutral', rejected: 'bad' };

/** Per-project access and capability flags of one account, saved together. */
function Permissions({ user, projects, capabilities, onSaved }) {
  const [p, setP] = useState(user.permissions);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(user.permissions), [user.permissions]);
  const dirty = JSON.stringify(p) !== JSON.stringify(user.permissions);
  const toggleProject = (id) => setP({ ...p, projects: p.projects?.includes(id) ? p.projects.filter((x) => x !== id) : [...(p.projects || []), id] });
  return (
    <div className="grid md:grid-cols-2 gap-4 pt-3 mt-3 border-t border-line">
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.72rem] font-medium uppercase tracking-wider text-subtle">Projects</span>
        {!projects.length && <span className="text-xs text-subtle">No projects to grant yet.</span>}
        {projects.map((pr) => (
          <label key={pr.id} className="flex items-center gap-2 text-[0.82rem] cursor-pointer">
            <input type="checkbox" className="accent-[var(--af-accent)]" checked={!!p.projects?.includes(pr.id)} onChange={() => toggleProject(pr.id)} />
            <span className="truncate">{pr.name}</span>
          </label>
        ))}
        <span className="text-xs text-subtle">The AgentForge platform project is never shown to other users.</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[0.72rem] font-medium uppercase tracking-wider text-subtle">Capabilities</span>
        {Object.entries(capabilities).map(([k, desc]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <Toggle checked={!!p[k]} onChange={(v) => setP({ ...p, [k]: v })} label={k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase())} />
            <span className="text-xs text-subtle pl-11">{desc}</span>
          </div>
        ))}
      </div>
      <div className="md:col-span-2 flex justify-end">
        <Button size="sm" variant="primary" icon={Save} disabled={!dirty} loading={busy}
          onClick={async () => { setBusy(true); try { onSaved(await api.put(`/api/users/${user.id}/permissions`, p)); toast.success(`Permissions saved · ${user.username}`); } finally { setBusy(false); } }}>
          Save permissions
        </Button>
      </div>
    </div>
  );
}

/** The computer the account registered (or bound) from, as its browser described it: for the administrator to judge. */
function DeviceInfo({ info }) {
  const parts = [info.os, info.browser, info.platform, info.screen && `screen ${info.screen}`, info.language, info.timezone].filter(Boolean);
  return (
    <div className="mt-2 flex flex-col gap-0.5 text-xs text-subtle" data-device-info>
      <span className="inline-flex items-center gap-1.5 text-fg"><MonitorSmartphone size={12} className="text-subtle" />{info.label || 'Unknown computer'}</span>
      {parts.length > 0 && <span>{parts.join(' · ')}</span>}
      {info.userAgent && <span className="font-mono text-[0.7rem] break-all">{info.userAgent}</span>}
    </div>
  );
}

function UserRow({ user, me, projects, capabilities, onChange, onDelete }) {
  const [open, setOpen] = useState(false);
  const self = user.id === me?.id;
  const admin = user.role === 'admin';
  const act = (action, label) => async () => {
    onChange(await api.post(`/api/users/${user.id}/${action}`));
    toast.success(`${label} · ${user.username}`);
  };
  return (
    <div className="rounded-[var(--af-radius)] border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[0.88rem]">{user.username}</span>
        {admin && <Badge tone="accent" icon={ShieldCheck}>Administrator</Badge>}
        <Badge tone={STATUS[user.status]}>{user.status}</Badge>
        {user.team && <Badge>Team · {user.team}</Badge>}
        <Badge tone={user.device_bound ? 'info' : 'neutral'} icon={MonitorSmartphone}>{user.device_bound ? 'Device bound' : 'No device bound'}</Badge>
        <span className="text-xs text-subtle">Registered {dateTime(user.created_at)}{user.last_login_at ? ` · last login ${dateTime(user.last_login_at)}` : ''}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {user.status === 'pending' && <>
            <Button size="sm" variant="primary" icon={Check} onClick={act('approve', 'Approved')}>Approve</Button>
            <Button size="sm" variant="danger" icon={X} onClick={act('reject', 'Rejected')}>Reject</Button>
          </>}
          {user.status === 'rejected' && <Button size="sm" icon={Check} onClick={act('approve', 'Approved')}>Approve</Button>}
          {!self && !admin && user.status === 'active' && <Button size="sm" icon={Ban} onClick={act('disable', 'Disabled')}>Disable</Button>}
          {user.status === 'disabled' && <Button size="sm" icon={Power} onClick={act('enable', 'Enabled')}>Enable</Button>}
          {user.device_bound && <Button size="sm" variant="ghost" icon={MonitorSmartphone} title="The user registers again from their new computer (or a password account logs in from it) and waits for your approval" onClick={act('reset-device', 'Device binding reset')}>Reset device</Button>}
          {!admin && <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide permissions' : 'Permissions'}</Button>}
          {!self && !admin && <Button size="sm" variant="ghost" icon={Trash2} label="Delete" title="Delete account"
            onClick={async () => { if (!confirm(`Delete the account ${user.username}?`)) return; await api.del(`/api/users/${user.id}`); onDelete(user.id); toast.info(`Deleted · ${user.username}`); }} />}
        </div>
      </div>
      {user.device_info && <DeviceInfo info={user.device_info} />}
      {open && !admin && <Permissions user={user} projects={projects} capabilities={capabilities} onSaved={onChange} />}
    </div>
  );
}

/** Admin only: approve registrations, enable/disable and delete accounts, set permissions and reset device bindings. */
export default function Users() {
  const me = useStore((s) => s.me);
  const all = useStore((s) => s.projects);
  const projects = useMemo(() => all.filter((p) => !p.protected), [all]); // the platform project is never granted
  const [data, setData] = useState(null);
  const load = () => api.get('/api/users').then(setData).catch(() => {});
  // Reloads when the waiting count changes (users:pending): a new sign-up, or an approval from another browser.
  const pendingUsers = useStore((s) => s.pendingUsers);
  useEffect(() => { load(); }, [pendingUsers]);
  const replace = (u) => setData((d) => ({ ...d, users: d.users.map((x) => (x.id === u.id ? u : x)) }));
  const remove = (id) => setData((d) => ({ ...d, users: d.users.filter((x) => x.id !== id) }));
  const pending = data?.users.filter((u) => u.status === 'pending').length || 0;
  return (
    <div className="h-full overflow-auto">
      <div className="p-4 flex flex-col gap-3 max-w-[1200px]">
        <div className="flex items-center gap-3">
          <UsersIcon size={18} className="text-subtle" />
          <span className="font-semibold text-[0.95rem]">Users</span>
          {pending > 0 && <Badge tone="warn">{pending} waiting for approval</Badge>}
          <Button size="sm" variant="ghost" icon={RefreshCw} className="ml-auto" onClick={load}>Refresh</Button>
        </div>
        {!data ? <div className="flex justify-center py-10"><Spinner /></div>
          : !data.users.length ? <Empty icon={UsersIcon} title="No users yet" />
            : data.users.map((u) => <UserRow key={u.id} user={u} me={me} projects={projects} capabilities={data.capabilities} onChange={replace} onDelete={remove} />)}
        <p className={cx('text-xs text-subtle')}>
          New sign-ups wait here until approved, with the computer they registered from as its browser describes it. Each account signs in with a secret
          kept by that browser, so another computer is refused until you reset its device; the user then registers again from the new one and waits
          for your approval. Administrators with a password may sign in anywhere. See docs/users.md.
        </p>
      </div>
    </div>
  );
}
