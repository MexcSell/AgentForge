# Users, permissions and device binding

All of AgentForge needs a signed-in account except the login homepage itself and `GET /api/health`, which the supervisor polls. A request to `/api/*`, `/uploads/*` or a project preview (`/preview/<id>/…`) without a session gets **401**. Only active accounts get a session: pending, rejected and disabled accounts have none (a session left over from before counts as none), so they get 401 over HTTP and on the event WebSocket `/api/events` alike.

Code: `server/services/auth.js` (accounts, passwords, sessions, devices), `server/services/access.js` (who sees what, including the WebSocket filter), `server/routes/auth.js` (endpoints, hooks and the route policy table), and in the client `client/src/views/Login.jsx`, `client/src/views/Users.jsx` and `client/src/lib/device.js`.

## The administrator (owner)

There is a single administrator role. It is set up in one of these ways:

1. **First sign-up.** While no active administrator exists, the homepage shows **Create the administrator account**. The first account created there (a username only, bound to that browser's device, see below) becomes the active administrator straight away. It has no password: give it one with `scripts/reset-admin.js` so it can also sign in from other computers, or if that browser's storage is lost. After the deploy that adds accounts, open AgentForge and create your account. Until then, every page is behind the homepage, and no data can be read.
2. **Environment (break-glass).** Set `AF_ADMIN_USERNAME` (and `AF_ADMIN_PASSWORD` to create the account if it does not exist) in `.env`. On every boot of the real server, that account is made an active administrator. An existing account keeps its password and is promoted and re-enabled.
3. **Forgotten password:** run `node scripts/reset-admin.js <username> <new password>`. It sets the password and makes the account an active administrator, creating it if needed. It writes directly to the database in `.env`.

An administrator with a password is never bound to a device: **Log in with a password** works from any computer (it binds that browser only if the account has no device yet, and never takes over another account's device). An administrator without a password can not have its device reset. It cannot disable, reject or delete its own account or another administrator account, so it cannot lock itself out from the Users page. Sessions are stored in the database (`sessions`), so a restart or redeploy does not sign anyone out. The schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `password_hash` made nullable), so migrating the live database touches no existing data; see *Migration* below.

**Exposure warning:** until the administrator account exists, whoever opens the homepage first can create it. The server listens on all interfaces by default (`HOST=127.0.0.1` keeps it local), so it is reachable from the network: create the account right after deploying, or set `AF_ADMIN_USERNAME`/`AF_ADMIN_PASSWORD` before the restart.

## Sign-up and approval

- The homepage asks for a **username only** and has a **Register** button. Pressing it sends the username and this browser's device (below) to `POST /api/auth/signup`.
- A new account starts as `pending`, bound to that device, and gets **no session**. The browser shows **Waiting for administrator approval** and checks again every 15 seconds (or on **Check again**). The administrator gets a notification for each registration, naming the computer.
- Account states: `pending` → `active` (approve) or `rejected` (reject); `active` ↔ `disabled`. Rejected and disabled accounts cannot sign in; the homepage says why. Disabling, rejecting or deleting an account ends its sessions and closes its open WebSockets immediately.
- Usernames are 3–32 letters, digits, dots, dashes or underscores, starting with a letter or digit, and unique regardless of case (`409 username_taken`, `400 invalid_username`). A device can hold one account (`409 device_taken`). Registrations are limited to 10 per 15 minutes per client address (`429 rate_limited`; the address is the proxy's view only with `TRUST_PROXY`). The computer info may be at most 4 KB (`413 device_info_too_large`), and the sign-in endpoints accept at most 16 KB bodies.
- `team` is still accepted by the API and shown on the Users page, but the homepage no longer asks for it.

## Device sign-in (no password)

`client/src/lib/device.js` creates a **device secret** the first time it is needed: 256 random bits from `crypto.getRandomValues` (available on plain-http LAN origins, unlike WebCrypto keys), kept in the browser's `localStorage` (`agentforge.device`). The server stores only its SHA-256 (`users.device_secret_hash`, unique).

With it the browser sends **computer info** for the administrator: a label such as "Chrome on Linux", OS, browser, platform, user agent, screen size, language and timezone (`users.device_info`). It is shown on the Users page at approval and **never used to authenticate**: a request that copies all of it without the secret is refused. No IP or other network address is collected.

- On load without a session, a browser that has a secret signs in by itself through `POST /api/auth/device`: an active account gets a session; `403` with `code` `pending`, `rejected` or `disabled` otherwise; `401 unknown_device` for a secret no account holds.
- **Log out** ends the session and keeps this browser from signing straight back in; **Sign in on this computer** on the homepage does it again.
- Another computer, another browser profile, or cleared site data has no (or another) secret, so it is not signed in.
- **Reset device** on the Users page clears an account's device. The user then registers again with **the same username** from the new computer: the account (with its permissions) is bound to it and goes back to `pending` until you approve it again, so check the computer info. Only accounts without a password and without a device can be re-registered like this. Password accounts bind the new computer at their next password login instead.

## Passwords (existing accounts and break-glass)

- Accounts created before username-only sign-up keep their password. **Log in with a password** on the homepage sends the username, the password, this browser's device and the legacy fingerprint. The first successful login binds this browser's device secret (the one-time migration path); from then on the account also signs in with no password, and a password login from another browser is refused (`403 device_mismatch`). Until it binds, a non-admin account bound to a legacy fingerprint must still log in from that computer (hardware must match; up to 2 of canvas, touch, screen, colour depth, timezone and language may differ).
- Pending accounts get no session from a password login either.
- Passwords are hashed with **scrypt** (N=16384, r=8, p=1) using a random 16-byte salt per hash, stored as `scrypt$N$r$p$salt$hash` and compared in constant time. A login with an unknown username still runs a hash, so it takes the same time as a wrong password.

## Sessions

- A session is a random 256-bit token held in the `af_session` cookie, set with `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the request came over https (`X-Forwarded-Proto: https` from a TLS proxy counts only with `TRUST_PROXY` set, see the README's HTTPS section). The database stores only the token's SHA-256. Sessions last 30 days. **Log out** (the user name in the title bar) deletes the session.

## Migration

`server/db/schema.sql` adds `users.device_secret_hash` and `users.device_info` and drops `NOT NULL` from `users.password_hash`; nothing is removed or rewritten (the legacy fingerprint column `device` stays). After the deploy:

- The administrator and approved users keep their password and their sessions. Their next password login binds the browser it comes from. tests/auth-migration.test.mjs runs this on the old table.
- Sessions of accounts that are still pending stop working (pending accounts get no session now); their browsers show the homepage. Such a user can log in with their password once approved, which binds their browser.

## Permissions

The administrator can see and do everything. Every other account has:

| Permission | Grants |
| --- | --- |
| `projects` (list) | The projects the user can see, with their chat, tasks, topics, team, Git info and preview. |
| `createProjects` | Creating projects. A project a user creates is added to their `projects` automatically. |
| `runMissions` | In granted projects: orders, stop, stand-ups, sync, approving and rejecting proposals, topics, team changes, starting and stopping the preview, and uploads. Without it, a user can only read granted projects. |
| `manageAgents` | The Agents view (registry, org chart, evolution) and every agent API. |
| `manageSettings` | Settings and Models (view and change). |

These are **admin-only** whatever the permissions: the Users page, Files and the terminal (both give full access to the host), GitHub, Bittensor, project edit and delete, posting notices, and the safe restart. Any API route not listed in `POLICY` in `server/routes/auth.js` is admin-only by default.

**The AgentForge platform project (the protected one) is never visible to a non-admin.** That holds even if it is granted (the Users page does not offer it, and the server strips it). Ungranted projects are hidden in the same way:

- **REST:** they are not in `/api/projects`, the dashboard or notifications. Their routes, including a topic or task addressed by its own id, answer **404**.
- **WebSocket:** each event is checked per socket (`eventVisibleTo`). Project events go only to users who can see that project. Agent events go only with `manageAgents`, and settings or models events only with `manageSettings`. Event types not listed there go to administrators only.
- **Agents:** without `manageAgents`, `/api/agents` lists only the agents on the user's projects (members and GMs), so the team views keep working.

Changing an account's permissions updates its open WebSockets immediately. The browser receives an `auth:update` event and reloads its data.

## Limits

The device secret identifies a browser profile, not a person or a machine: whoever copies it out of the browser's storage can sign in as that account, and clearing site data loses it (ask the administrator to reset the device, then register again). Someone who registers from a second browser under a new name cannot be told apart without network data, which is deliberately not collected. The administrator's approval step, with the computer info, is the check for that.
