import { useState } from 'react';
import { LogIn, UserPlus, Users, Hourglass, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { deviceFingerprint } from '../lib/device.js';
import { cx, Button, Field, Input } from '../components/ui.jsx';

function Brand() {
  return (
    <div className="flex items-center gap-2.5 justify-center">
      <span className="size-9 rounded-[10px] grad-accent flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 64 64" width="20" height="20"><path d="M18 46 30 18l12 28M22.5 37h15" fill="none" stroke="currentColor" className="text-accent-fg" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="font-semibold tracking-tight text-[1.3rem]">AgentForge</span>
    </div>
  );
}

const Card = ({ children }) => (
  <div className="h-full overflow-auto bg-bg dotgrid flex items-center justify-center p-4">
    <div className="w-full max-w-[380px] flex flex-col gap-5">
      <Brand />
      <div className="rounded-[var(--af-radius)] border border-line bg-panel p-5 flex flex-col gap-4 shadow-sm">{children}</div>
    </div>
  </div>
);

/**
 * The homepage for signed-out visitors: log in, or sign up (individually or for a team). New accounts wait for the
 * administrator's approval; with no administrator yet (a fresh install) the first sign-up creates it.
 */
export function Login() {
  const setup = useStore((s) => s.setup);
  const loadMe = useStore((s) => s.loadMe);
  const [mode, setMode] = useState(setup ? 'signup' : 'login'); // login | signup | team
  const [f, setF] = useState({ username: '', password: '', confirm: '', team: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode !== 'login';
  const up = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (signup && f.password !== f.confirm) return setError('The passwords do not match');
    setBusy(true);
    try {
      const body = { username: f.username.trim(), password: f.password, device: deviceFingerprint() };
      if (mode === 'team') body.team = f.team.trim();
      await api.post(signup ? '/api/auth/signup' : '/api/auth/login', body, { quiet: true });
      await loadMe();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const go = (m) => { setMode(m); setError(''); };

  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-[1.02rem]">
          {setup ? 'Create the administrator account' : mode === 'login' ? 'Log in' : mode === 'team' ? 'Team registration' : 'Sign up'}
        </h1>
        <p className="text-xs text-subtle">
          {setup ? 'No administrator exists yet. This first account becomes the administrator of this AgentForge.'
            : mode === 'login' ? 'Sign in to the AgentForge control room.'
              : 'Your account is bound to this computer and becomes usable once the administrator approves it.'}
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === 'team' && <Field label="Team"><Input value={f.team} onChange={up('team')} placeholder="Team or company name" required maxLength={80} /></Field>}
        <Field label="Username"><Input value={f.username} onChange={up('username')} autoComplete="username" autoFocus required /></Field>
        <Field label="Password" hint={signup ? 'At least 8 characters' : undefined}>
          <Input type="password" value={f.password} onChange={up('password')} autoComplete={signup ? 'new-password' : 'current-password'} required />
        </Field>
        {signup && <Field label="Confirm password"><Input type="password" value={f.confirm} onChange={up('confirm')} autoComplete="new-password" required /></Field>}
        {error && <div role="alert" className="text-xs text-bad bg-bad-soft rounded-md px-2.5 py-2">{error}</div>}
        <Button type="submit" variant="primary" size="lg" loading={busy} icon={signup ? (setup ? ShieldCheck : UserPlus) : LogIn}>
          {setup ? 'Create administrator' : mode === 'login' ? 'Log in' : 'Register'}
        </Button>
      </form>
      {!setup && (
        <div className="flex flex-col gap-2 pt-1 border-t border-line">
          {mode === 'login' ? (
            <>
              <Button variant="secondary" icon={UserPlus} onClick={() => go('signup')} className="mt-3">Sign up</Button>
              <button type="button" onClick={() => go('team')} className="self-center inline-flex items-center gap-1 text-xs text-subtle hover:text-fg">
                <Users size={12} /> Team registration
              </button>
            </>
          ) : (
            <button type="button" onClick={() => go('login')} className={cx('self-center text-xs text-subtle hover:text-fg mt-3')}>Already have an account? Log in</button>
          )}
        </div>
      )}
    </Card>
  );
}

/** A signed-in account the administrator has not approved yet: nothing else is reachable. */
export function Pending() {
  const me = useStore((s) => s.me);
  const loadMe = useStore((s) => s.loadMe);
  const logout = useStore((s) => s.logout);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <div className="flex flex-col items-center text-center gap-3 py-2">
        <span className="size-11 rounded-full bg-warn-soft text-warn flex items-center justify-center"><Hourglass size={20} /></span>
        <h1 className="font-semibold text-[1.02rem]">Waiting for administrator approval</h1>
        <p className="text-xs text-subtle">
          Your account <b className="text-fg">{me?.username}</b>{me?.team ? <> for team <b className="text-fg">{me.team}</b></> : null} is registered.
          You can use AgentForge once the administrator approves it.
        </p>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" icon={RefreshCw} loading={busy} onClick={async () => { setBusy(true); try { await loadMe(); } finally { setBusy(false); } }}>Check again</Button>
        <Button className="flex-1" variant="ghost" icon={LogOut} onClick={logout}>Log out</Button>
      </div>
    </Card>
  );
}
