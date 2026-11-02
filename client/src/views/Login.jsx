import { useEffect, useState } from 'react';
import { LogIn, UserPlus, Hourglass, RefreshCw, ShieldCheck, MonitorSmartphone, Ban } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { deviceCredential, deviceFingerprint, storedDeviceSecret } from '../lib/device.js';
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
 * The homepage for signed-out visitors. Sign up takes a username only: the account is bound to this browser's device
 * secret and waits for the administrator's approval (with no administrator yet, the first sign-up creates it). A
 * registered browser signs in by itself (store.loadMe); after Log out, "Sign in on this computer" does it again.
 * A browser whose account was rejected or disabled sees why instead of the form (it can not register again).
 * Accounts with a password (created before, or the administrator elsewhere) use "Log in with a password".
 */
export function Login() {
  const setup = useStore((s) => s.setup);
  const loadMe = useStore((s) => s.loadMe);
  const deviceSignIn = useStore((s) => s.deviceSignIn);
  const refused = useStore((s) => s.device); // rejected or disabled (pending shows the waiting screen)
  const [mode, setMode] = useState('signup'); // signup | password
  const [f, setF] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const known = !setup && !!storedDeviceSecret();
  const up = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const run = (what, fn) => async (e) => {
    e?.preventDefault();
    setError('');
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const register = run('signup', async () => {
    const r = await api.post('/api/auth/signup', { username: f.username.trim(), device: deviceCredential() }, { quiet: true });
    if (r.pending) useStore.setState({ device: { code: 'pending', username: r.user.username, team: r.user.team } });
    else await loadMe(); // the first account: the administrator, signed in
  });
  const passwordLogin = run('password', async () => {
    await api.post('/api/auth/login', { username: f.username.trim(), password: f.password, device: deviceCredential(), fingerprint: deviceFingerprint() }, { quiet: true });
    await loadMe();
  });
  const thisComputer = run('device', async () => {
    if (!(await deviceSignIn()) && !useStore.getState().device) setError('This computer is not registered. Sign up with a username first.');
  });
  const go = (m) => { setMode(m); setError(''); };

  if (refused && mode === 'signup') {
    return (
      <Card>
        <div className="flex flex-col items-center text-center gap-3 py-2">
          <span className="size-11 rounded-full bg-bad-soft text-bad flex items-center justify-center"><Ban size={20} /></span>
          <h1 className="font-semibold text-[1.02rem]">{refused.code === 'disabled' ? 'Account disabled' : refused.code === 'rejected' ? 'Registration rejected' : 'Sign-in refused'}</h1>
          <p role="alert" className="text-xs text-subtle">{refused.username ? <><b className="text-fg">{refused.username}</b>: </> : null}{refused.message}</p>
        </div>
        {error && <div role="alert" className="text-xs text-bad bg-bad-soft rounded-md px-2.5 py-2">{error}</div>}
        <div className="flex flex-col gap-2">
          <Button icon={RefreshCw} loading={busy === 'device'} onClick={thisComputer}>Check again</Button>
          <button type="button" onClick={() => go('password')} className="self-center text-xs text-subtle hover:text-fg">Log in with a password</button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-[1.02rem]">
          {setup ? 'Create the administrator account' : mode === 'password' ? 'Log in with a password' : 'Sign up'}
        </h1>
        <p className="text-xs text-subtle">
          {setup ? 'No administrator exists yet. This first account becomes the administrator of this AgentForge, bound to this computer.'
            : mode === 'password' ? 'For accounts that have a password. Your account is then bound to this computer.'
              : 'Choose a username. Your account is bound to this computer and becomes usable once the administrator approves it.'}
        </p>
      </div>
      {refused && <div role="alert" className="text-xs text-bad bg-bad-soft rounded-md px-2.5 py-2">{refused.username ? <><b>{refused.username}</b>: </> : null}{refused.message}</div>}
      <form onSubmit={mode === 'password' ? passwordLogin : register} className="flex flex-col gap-3">
        <Field label="Username" hint={mode === 'signup' ? '3–32 letters, digits, dots, dashes or underscores' : undefined}>
          <Input value={f.username} onChange={up('username')} autoComplete="username" autoFocus required maxLength={32} />
        </Field>
        {mode === 'password' && <Field label="Password"><Input type="password" value={f.password} onChange={up('password')} autoComplete="current-password" required /></Field>}
        {error && <div role="alert" className="text-xs text-bad bg-bad-soft rounded-md px-2.5 py-2">{error}</div>}
        <Button type="submit" variant="primary" size="lg" loading={busy === mode} icon={mode === 'password' ? LogIn : setup ? ShieldCheck : UserPlus}>
          {setup ? 'Create administrator' : mode === 'password' ? 'Log in' : 'Register'}
        </Button>
      </form>
      {!setup && (
        <div className="flex flex-col gap-2 pt-1 border-t border-line">
          {known && <Button variant="secondary" icon={MonitorSmartphone} loading={busy === 'device'} onClick={thisComputer} className="mt-3">Sign in on this computer</Button>}
          <button type="button" onClick={() => go(mode === 'password' ? 'signup' : 'password')} className={cx('self-center text-xs text-subtle hover:text-fg', !known && 'mt-3')}>
            {mode === 'password' ? 'New here? Sign up with a username' : 'Log in with a password'}
          </button>
        </div>
      )}
    </Card>
  );
}

/** Registered from this browser, not approved yet: nothing else is reachable. Checks again by itself every 15 s. */
export function Pending() {
  const device = useStore((s) => s.device);
  const deviceSignIn = useStore((s) => s.deviceSignIn);
  const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); try { await deviceSignIn(); } catch { /* server unreachable: try again later */ } finally { setBusy(false); } };
  useEffect(() => {
    const t = setInterval(() => deviceSignIn().catch(() => {}), 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card>
      <div className="flex flex-col items-center text-center gap-3 py-2">
        <span className="size-11 rounded-full bg-warn-soft text-warn flex items-center justify-center"><Hourglass size={20} /></span>
        <h1 className="font-semibold text-[1.02rem]">Waiting for administrator approval</h1>
        <p className="text-xs text-subtle">
          Your account <b className="text-fg">{device?.username}</b>{device?.team ? <> for team <b className="text-fg">{device.team}</b></> : null} is registered on this computer.
          You can use AgentForge once the administrator approves it; this page signs you in by itself.
        </p>
      </div>
      <Button icon={RefreshCw} loading={busy} onClick={check}>Check again</Button>
    </Card>
  );
}
