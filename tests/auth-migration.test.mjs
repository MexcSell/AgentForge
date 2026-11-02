// The username-only / device-secret migration of server/db/schema.sql on a database from before it (users table as
// added with accounts: password_hash NOT NULL, a fingerprint `device`, pending sign-ups holding sessions): it applies
// twice without touching existing rows, the administrator and approved users keep access (password login, which binds
// this browser's secret once), and pending accounts lose their sessions. Session temp tables only (search_path=pg_temp).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

process.env.PGOPTIONS = '-c search_path=pg_temp';
const { pool, one } = await import('../server/db/pool.js');
const client = await pool.connect();
pool.query = (text, params) => client.query(text, params);
const auth = await import('../server/services/auth.js');

const PC = { platform: 'Linux x86_64', cores: 8, memory: 8, gpu: 'ANGLE (NVIDIA, GeForce GTX 1080)', canvas: 'c0ffee12', touch: 0, screen: '1920x1080', colorDepth: 24, timezone: 'Europe/Berlin', language: 'en-US' };
const OTHER_PC = { ...PC, cores: 16, memory: 32, gpu: 'Apple M2' };
const browser = (label) => ({ secret: crypto.randomBytes(32).toString('base64url'), info: { label } });
const refusal = (p) => p.then(() => null, (e) => ({ status: e.status, code: e.code }));

// users and sessions exactly as the accounts commit (8db6a59) created them.
const OLD = `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'rejected')),
  team text, permissions jsonb NOT NULL DEFAULT '{}', device jsonb, device_bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, last_login_at timestamptz);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);`;

const sessions = {};
let before_;

before(async () => {
  await pool.query(OLD);
  const pw = await auth.hashPassword('correct horse');
  for (const [name, role, status, device] of [['owner', 'admin', 'active', null], ['dave', 'user', 'active', PC], ['frank', 'user', 'active', null], ['erin', 'user', 'pending', OTHER_PC]]) {
    const { id } = await one(`INSERT INTO users(username, password_hash, role, status, device) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, pw, role, status, device && auth.hashDevice(device)]);
    sessions[name] = await auth.createSession(id);
  }
  before_ = (await pool.query(`SELECT id, username, password_hash, role, status, device, permissions FROM users ORDER BY username`)).rows;
  const schema = fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // idempotent: every boot applies it
});

after(async () => {
  client.release();
  await pool.end();
});

test('the schema change is additive: existing rows are untouched, the password becomes optional', async () => {
  const live = await one(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE c.relname = 'users' AND s.nspname = pg_my_temp_schema()::regnamespace::text`);
  assert.equal(live.n, 1, 'users must be a session temp table');
  assert.deepEqual((await pool.query(`SELECT id, username, password_hash, role, status, device, permissions FROM users ORDER BY username`)).rows, before_);
  const cols = (await pool.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND table_schema = pg_my_temp_schema()::regnamespace::text`)).rows;
  const col = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
  assert.equal(col.password_hash, 'YES');
  assert.equal(col.device_secret_hash, 'YES');
  assert.equal(col.device_info, 'YES');
  assert.equal(await auth.needsSetup(), false, 'the administrator still exists');
});

test('active accounts keep their sessions; a pending account\'s old session is void and it can not log in', async () => {
  assert.equal((await auth.sessionUser(sessions.owner)).username, 'owner');
  assert.equal((await auth.sessionUser(sessions.dave)).username, 'dave');
  assert.equal(await auth.sessionUser(sessions.erin), null);
  assert.deepEqual(await refusal(auth.login({ username: 'erin', password: 'correct horse', device: browser('x'), fingerprint: OTHER_PC })), { status: 403, code: 'pending' });
});

test('the administrator signs in with its password from any computer and binds a free browser', async () => {
  assert.equal((await auth.login({ username: 'owner', password: 'correct horse' })).username, 'owner', 'no device needed');
  const b = browser('Chrome on Linux');
  await auth.login({ username: 'owner', password: 'correct horse', device: b, fingerprint: OTHER_PC });
  assert.equal((await auth.deviceLogin({ device: b })).username, 'owner');
});

test('a legacy user binds this browser at a password login from its fingerprinted computer, then needs no password', async () => {
  const b = browser('Firefox on Linux');
  assert.deepEqual(await refusal(auth.login({ username: 'dave', password: 'wrong', device: b, fingerprint: PC })), { status: 401, code: undefined });
  assert.deepEqual(await refusal(auth.login({ username: 'dave', password: 'correct horse', device: b, fingerprint: OTHER_PC })), { status: 403, code: 'device_mismatch' });
  assert.deepEqual(await refusal(auth.login({ username: 'dave', password: 'correct horse', fingerprint: PC })), { status: 400, code: 'device_required' });
  assert.deepEqual(await refusal(auth.deviceLogin({ device: b })), { status: 401, code: 'unknown_device' });
  const u = await auth.login({ username: 'dave', password: 'correct horse', device: b, fingerprint: PC });
  assert.deepEqual(u.device_info, { label: 'Firefox on Linux' });
  assert.equal((await auth.deviceLogin({ device: b })).username, 'dave');
  // From then on the secret is the binding: the password from another browser is refused, even with the fingerprint.
  assert.deepEqual(await refusal(auth.login({ username: 'dave', password: 'correct horse', device: browser('y'), fingerprint: PC })), { status: 403, code: 'device_mismatch' });
  assert.equal((await auth.login({ username: 'dave', password: 'correct horse', device: b })).username, 'dave');
});

test('a legacy user with no device bound binds the first browser; a username-only sign-up can not claim its name', async () => {
  const f = browser('Edge on Windows');
  assert.equal((await auth.login({ username: 'frank', password: 'correct horse', device: f })).username, 'frank');
  assert.equal((await auth.deviceLogin({ device: f })).username, 'frank');
  // A username-only sign-up can not claim a password account's name.
  assert.deepEqual(await refusal(auth.signup({ username: 'Frank', device: browser('z') })), { status: 409, code: 'username_taken' });
});
