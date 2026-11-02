// Accounts, sessions and device binding (docs/users.md). Passwords: scrypt with a random salt per user. Sessions: a
// random token in an httpOnly cookie, stored as its SHA-256. Devices: per-component SHA-256 of what the browser reports.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, many, query } from '../db/pool.js';
import { notify, audit } from './notify.js';
import { refreshUserClients } from '../events.js';
import { sanitizePermissions, setProtectedProjects, isAdmin } from './access.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
export const SESSION_COOKIE = 'af_session';
const SESSION_DAYS = 30;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- passwords -------------------------------------------------------------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_LEN, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, want);
}
// Compared against when the username does not exist, so a miss takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---- device fingerprint ------------------------------------------------------
// What the client sends (client/src/lib/device.js). Anything else (an IP address, a window size…) is dropped.
// HARDWARE must all match for a login; of the rest at most SOFT_TOLERANCE may differ (another monitor, a browser
// update changing the canvas, a new language or timezone). The browser window size is not part of it at all.
export const DEVICE_HARDWARE = ['platform', 'cores', 'memory', 'gpu'];
export const DEVICE_SOFT = ['canvas', 'touch', 'screen', 'colorDepth', 'timezone', 'language'];
const SOFT_TOLERANCE = 2;

/** The stored form of a device: { component: sha256 } with the known components only; null if the hardware is unknown. */
export function hashDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of [...DEVICE_HARDWARE, ...DEVICE_SOFT]) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = sha256(`agentforge-device|${k}|${String(v).slice(0, 300)}`);
  }
  return ['platform', 'cores', 'gpu'].every((k) => out[k]) ? out : null;
}

/** Whether two stored devices are the same computer (see DEVICE_HARDWARE / DEVICE_SOFT). */
export function sameDevice(a, b) {
  if (!a || !b) return false;
  if (DEVICE_HARDWARE.some((k) => a[k] !== b[k])) return false;
  return DEVICE_SOFT.filter((k) => a[k] !== b[k]).length <= SOFT_TOLERANCE;
}

// ---- users -------------------------------------------------------------------
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;

/** What the API returns for a user: never the password hash or device hashes. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, status: u.status, team: u.team || null, permissions: sanitizeStored(u.permissions),
    device_bound: !!u.device, device_bound_at: u.device_bound_at, created_at: u.created_at, approved_at: u.approved_at, last_login_at: u.last_login_at,
  };
}
const sanitizeStored = (p) => ({ projects: [], ...(p || {}) });

export const getUser = (id) => one(`SELECT * FROM users WHERE id = $1`, [id]);
const byName = (name) => one(`SELECT * FROM users WHERE lower(username) = lower($1)`, [String(name || '')]);
export const listUsers = async () => (await many(`SELECT * FROM users ORDER BY (status = 'pending') DESC, created_at`)).map(publicUser);

/** The other account (if any) whose bound device is this one. */
async function deviceOwner(device, exceptId = null) {
  const rows = await many(`SELECT id, username, device FROM users WHERE device IS NOT NULL AND id IS DISTINCT FROM $1`, [exceptId]);
  return rows.find((r) => sameDevice(r.device, device)) || null;
}

// Sign-ups run one at a time, so two first sign-ups can not both become the administrator.
let lane = Promise.resolve();
const serial = (fn) => {
  const run = lane.then(fn, fn);
  lane = run.catch(() => {});
  return run;
};

/** Creates an account: pending, or the active administrator when there is none yet. */
export function signup({ username, password, device, team } = {}) {
  return serial(async () => {
    username = String(username || '').trim();
    if (!USERNAME.test(username)) throw fail(400, 'Username: 3–32 letters, digits, dots, dashes or underscores, starting with a letter or digit');
    if (String(password || '').length < 8) throw fail(400, 'Password: at least 8 characters');
    const dev = hashDevice(device);
    if (!dev) throw fail(400, 'Could not identify this computer. Enable JavaScript and WebGL, then try again.');
    if (await byName(username)) throw fail(409, 'That username is already registered');
    if (await deviceOwner(dev)) throw fail(409, 'This computer is already registered to another username. Sign in with that account instead.', { code: 'device_taken' });
    const first = !(await one(`SELECT 1 FROM users WHERE role = 'admin'`));
    const user = await one(
      `INSERT INTO users(username, password_hash, role, status, team, permissions, device, device_bound_at, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING *`,
      [username, await hashPassword(password), first ? 'admin' : 'user', first ? 'active' : 'pending', String(team || '').trim().slice(0, 80) || null,
        sanitizePermissions({}), dev, first ? new Date() : null],
    );
    await audit(username, first ? 'user.bootstrap-admin' : 'user.signup', username, { team: user.team });
    if (!first) await notify({ source_type: 'system', source_name: 'Users', level: 'warn', title: `Registration waiting for approval · ${username}`, body: user.team ? `Team: ${user.team}` : null }).catch(() => {});
    return user;
  });
}

/**
 * Checks a login. Pending users get a session (they see the waiting screen); rejected and disabled ones do not.
 * A non-admin must sign in from the computer bound to the account; after an administrator reset, the next login binds it.
 */
export async function login({ username, password, device } = {}) {
  const user = await byName(username);
  if (!user) {
    await verifyPassword(String(password || ''), await DUMMY_HASH);
    throw fail(401, 'Invalid username or password');
  }
  if (!(await verifyPassword(String(password || ''), user.password_hash))) throw fail(401, 'Invalid username or password');
  if (user.status === 'rejected') throw fail(403, 'Your registration was rejected by the administrator', { code: 'rejected' });
  if (user.status === 'disabled') throw fail(403, 'This account is disabled. Contact the administrator.', { code: 'disabled' });
  const dev = hashDevice(device);
  const admin = user.role === 'admin';
  if (!admin && !dev) throw fail(400, 'Could not identify this computer. Enable JavaScript and WebGL, then try again.');
  if (!admin && user.device && !sameDevice(user.device, dev)) {
    await audit(user.username, 'user.login-device-refused', user.username);
    throw fail(403, 'This account is registered to another computer. Sign in from that computer, or ask the administrator to reset your device.', { code: 'device_mismatch' });
  }
  let bind = !user.device && dev;
  if (bind && !admin && (await deviceOwner(dev, user.id))) throw fail(409, 'This computer is already registered to another username', { code: 'device_taken' });
  if (bind && admin && (await deviceOwner(dev, user.id))) bind = false; // the admin may sign in anywhere; it never takes a device over
  const row = await one(
    `UPDATE users SET last_login_at = now()${bind ? ', device = $2, device_bound_at = now()' : ''} WHERE id = $1 RETURNING *`,
    bind ? [user.id, dev] : [user.id]);
  return row;
}

/**
 * Break-glass bootstrap: AF_ADMIN_USERNAME (+ AF_ADMIN_PASSWORD to create it) makes that account an active admin on
 * boot. An existing account keeps its password and is promoted and re-enabled; without the variables nothing happens.
 */
export async function ensureAdmin(env = process.env) {
  const name = String(env.AF_ADMIN_USERNAME || '').trim();
  if (!name) return null;
  const u = await byName(name);
  if (u) {
    if (u.role === 'admin' && u.status === 'active') return u;
    const row = await one(`UPDATE users SET role = 'admin', status = 'active', approved_at = coalesce(approved_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [u.id]);
    await audit('system', 'user.bootstrap-admin', name, { promoted: true });
    return row;
  }
  if (!USERNAME.test(name) || String(env.AF_ADMIN_PASSWORD || '').length < 8) {
    console.warn('[auth] AF_ADMIN_USERNAME is set but no such user exists; set AF_ADMIN_PASSWORD (8+ characters) to create it');
    return null;
  }
  const row = await one(`INSERT INTO users(username, password_hash, role, status, permissions, approved_at) VALUES ($1,$2,'admin','active',$3,now()) RETURNING *`,
    [name, await hashPassword(env.AF_ADMIN_PASSWORD), sanitizePermissions({})]);
  await audit('system', 'user.bootstrap-admin', name, { created: true });
  return row;
}

/** True until an administrator exists: the homepage then offers to create it. */
export const needsSetup = async () => !(await one(`SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'`));

// ---- sessions ------------------------------------------------------------------
export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`, [sha256(token), userId, SESSION_DAYS]);
  await query(`DELETE FROM sessions WHERE expires_at < now()`).catch(() => {});
  return token;
}

export async function sessionUser(token) {
  if (!token) return null;
  const h = sha256(token);
  const u = await one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [h]);
  if (u) query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '10 minutes'`, [h]).catch(() => {});
  return u;
}

export const destroySession = (token) => (token ? query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]) : null);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignore */ }
    }
  }
  return out;
}

export const tokenOf = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;

// Secure only behind https (a TLS proxy sets x-forwarded-proto): the server itself speaks plain http on loopback.
const secure = (req) => req.protocol === 'https' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
export const sessionCookie = (req, token) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`;
export const clearedCookie = (req) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`;

// ---- administration --------------------------------------------------------------
/** Re-reads the protected (AgentForge) project ids that non-admins never see. */
export async function loadProtected() {
  setProtectedProjects((await many(`SELECT id FROM projects WHERE protected`)).map((r) => r.id));
}

// Pushes a changed account to its open browsers (new permissions), or closes them when it can no longer sign in.
async function changed(id, { endSessions = false } = {}) {
  if (endSessions) await query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  const u = await getUser(id);
  refreshUserClients(id, u, publicUser(u));
  return publicUser(u);
}

const ACTIONS = {
  approve: { from: ['pending', 'rejected'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected', endSessions: true },
  disable: { from: ['active', 'pending'], to: 'disabled', endSessions: true },
  enable: { from: ['disabled'], to: 'active' },
};

/** approve | reject | disable | enable | reset-device, by an administrator (actor). Never on the actor's own account. */
export async function userAction(actor, id, action) {
  const u = await getUser(id);
  if (!u) throw fail(404, 'User not found');
  if (action === 'reset-device') {
    await query(`UPDATE users SET device = NULL, device_bound_at = NULL, updated_at = now() WHERE id = $1`, [u.id]);
    await audit(actor.username, 'user.reset-device', u.username);
    return changed(u.id);
  }
  const a = ACTIONS[action];
  if (!a) throw fail(400, 'Unknown action');
  if (u.id === actor.id) throw fail(400, 'You can not change your own account status');
  if (u.role === 'admin' && a.to !== 'active') throw fail(400, 'An administrator account can not be disabled or rejected');
  if (!a.from.includes(u.status)) throw fail(409, `Can not ${action} a ${u.status} account`);
  await query(`UPDATE users SET status = $2, updated_at = now()${a.to === 'active' ? ', approved_at = coalesce(approved_at, now())' : ''} WHERE id = $1`, [u.id, a.to]);
  await audit(actor.username, `user.${action}`, u.username);
  return changed(u.id, { endSessions: a.endSessions });
}

export async function setPermissions(actor, id, permissions) {
  const u = await getUser(id);
  if (!u) throw fail(404, 'User not found');
  const p = sanitizePermissions(permissions);
  await query(`UPDATE users SET permissions = $2, updated_at = now() WHERE id = $1`, [u.id, p]);
  await audit(actor.username, 'user.permissions', u.username, p);
  return changed(u.id);
}

/** A project a non-admin created is granted to them. */
export async function grantProject(user, projectId) {
  if (isAdmin(user)) return;
  const u = await getUser(user.id);
  const p = sanitizePermissions(u.permissions);
  p.projects = [...new Set([...p.projects, projectId])];
  await query(`UPDATE users SET permissions = $2, updated_at = now() WHERE id = $1`, [u.id, p]);
  await changed(u.id);
}

export async function deleteUser(actor, id) {
  const u = await getUser(id);
  if (!u) throw fail(404, 'User not found');
  if (u.id === actor.id) throw fail(400, 'You can not delete your own account');
  if (u.role === 'admin') throw fail(400, 'An administrator account can not be deleted');
  await query(`DELETE FROM users WHERE id = $1`, [u.id]);
  await audit(actor.username, 'user.delete', u.username);
  refreshUserClients(u.id, null, null);
  return { ok: true };
}
