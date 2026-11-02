# Users, permissions and device binding

All of AgentForge needs a signed-in account except the login homepage itself and `GET /api/health`, which the supervisor polls. A request to `/api/*`, `/uploads/*` or a project preview (`/preview/<id>/…`) without a session gets **401**. An account that is still waiting for approval gets **403** with `status: "pending"`. The event WebSocket `/api/events` follows the same rules.

Code: `server/services/auth.js` (accounts, passwords, sessions, devices), `server/services/access.js` (who sees what, including the WebSocket filter), `server/routes/auth.js` (endpoints, hooks and the route policy table), and in the client `client/src/views/Login.jsx`, `client/src/views/Users.jsx` and `client/src/lib/device.js`.

## The administrator (owner)

There is a single administrator role. It is set up in one of these ways:

1. **First sign-up.** While no active administrator exists, the homepage shows **Create the administrator account**. The first account created there becomes the active administrator straight away. After the deploy that adds accounts, open AgentForge and create your account. Until then, every page is behind the homepage, and no data can be read.
2. **Environment (break-glass).** Set `AF_ADMIN_USERNAME` (and `AF_ADMIN_PASSWORD` to create the account if it does not exist) in `.env`. On every boot of the real server, that account is made an active administrator. An existing account keeps its password and is promoted and re-enabled.
3. **Forgotten password:** run `node scripts/reset-admin.js <username> <new password>`. It sets the password and makes the account an active administrator, creating it if needed. It writes directly to the database in `.env`.

The administrator is never bound to a device: it can sign in from any computer. It cannot disable, reject or delete its own account or another administrator account, so it cannot lock itself out from the Users page. Sessions are stored in the database (`sessions`), so a restart or redeploy does not sign anyone out. The schema change only adds the `users` and `sessions` tables (`CREATE TABLE IF NOT EXISTS`), so migrating the live database touches no existing data.

**Exposure warning:** until the administrator account exists, whoever opens the homepage first can create it. The server listens on all interfaces by default (`HOST=127.0.0.1` keeps it local), so it is reachable from the network: create the account right after deploying, or set `AF_ADMIN_USERNAME`/`AF_ADMIN_PASSWORD` before the restart.

## Sign-up and approval

- The homepage offers **Log in**, a **Sign up** button, and a small **Team registration** link. Team registration works like sign-up and also records a team name, which is shown on the Users page.
- A new account starts as `pending`. Signing in shows **Waiting for administrator approval** and nothing else: every other API call returns 403. The administrator gets a notification for each new registration.
- Account states: `pending` → `active` (approve) or `rejected` (reject); `active` ↔ `disabled`. Rejected and disabled accounts cannot sign in. Disabling, rejecting or deleting an account ends its sessions and closes its open WebSockets immediately.
- Usernames are 3–32 characters and unique regardless of case. Passwords must be at least 8 characters.

## Passwords and sessions

- Passwords are hashed with **scrypt** (N=16384, r=8, p=1) using a random 16-byte salt per hash. The stored form is `scrypt$N$r$p$salt$hash`. The hash is compared in constant time. A login with an unknown username still runs a hash, so it takes the same time as a wrong password.
- A session is a random 256-bit token held in the `af_session` cookie, set with `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the request came over https (`X-Forwarded-Proto: https` from a TLS proxy counts only with `TRUST_PROXY` set, see the README's HTTPS section). The database stores only the token's SHA-256. Sessions last 30 days. **Log out** (the user name in the title bar) deletes the session.

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

## Device binding

At sign-up and at every login, the browser sends a fingerprint of the computer (`client/src/lib/device.js`): platform, CPU cores, device memory, GPU renderer (WebGL), a canvas rendering hash, touch points, screen size (sorted, so rotating does not matter), colour depth, timezone and language. **It never includes an IP or any other network address, or the window size.** The server keeps only the known components and stores the SHA-256 of each one (`users.device`). Raw values are never stored.

Matching (`sameDevice`):

- **Hardware must match:** platform, cores, memory and GPU.
- **Up to 2 of the other components may differ:** canvas, touch, screen, colour depth, timezone, language. This covers a second monitor, a browser update or travelling. The window size is not part of the fingerprint, so resizing changes nothing.

Rules:

- **Sign-up is refused** (409) if the computer already matches a device bound to another username, or if the username is already taken, whatever the letter case. One computer cannot hold a second account, and nobody can claim an existing name from another computer.
- **Login from another computer is refused** (403, `code: "device_mismatch"`) for non-admins, with a message to ask the administrator.
- **Reset device** on the Users page clears the binding. The next login binds the computer it comes from, unless that computer is already bound to another account.

Limits: browser fingerprints identify a computer and browser setup, not a person. Two identical machines (same model, OS and browser) look the same. Someone who signs up from a second, different computer under a new name cannot be detected without network data, which is deliberately not collected. The administrator's approval step is the check for that.
