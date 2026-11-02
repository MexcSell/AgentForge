# AgentForge

A self-evolving, multi-agent software engineering control room. You give a project's **General Manager** an order; it splits the order into task contracts, staffs them from a hierarchical agent registry (reusing, cloning or recruiting specialists), runs them in parallel on Claude Code, has independent agents verify the result, pushes the change to GitHub, and feeds what it learned back into the agents' playbooks.

## Run

```bash
npm install
npm start            # supervisor: builds the UI, serves http://<host>:4800, restarts safely on changes
npm run stop         # stop the supervisor
npm run logs         # follow data/logs/agentforge.log
npm run dev          # development: API with --watch + Vite HMR on :5173
npm run db:check     # PostgreSQL connectivity check
```

Requirements: Node.js ≥ 20, PostgreSQL (defaults: `localhost:5432`, db `agentapp`, user/password `agentuser`), and the `claude` CLI logged in. `gh` is used for push credentials when it is authenticated. Override settings in `.env` (see `.env.example`).

### Remote access

The server listens on all interfaces (`HOST=0.0.0.0`), so other computers can open `http://<server IP or hostname>:4800` (the startup log lists the URLs). Every page and API still needs a signed-in account, and WebSockets only accept the app's own origin. To keep it local, set `HOST=127.0.0.1` in `.env` (another address binds just that interface); the change applies on the next restart. The administrator can sign in from any computer; other accounts are bound to the computer they registered from, so a teammate signs up from their own computer and the administrator approves it (or uses **Reset device** to move an account). If it does not load from outside, open TCP port 4800 in the host firewall and any cloud security group / router port forward. Traffic on port 4800 is plain HTTP, and the app includes a shell terminal (admin only). Over the internet, serve it over HTTPS (below) and keep 4800 private.

### Serving over HTTPS

[deploy/Caddyfile](deploy/Caddyfile) puts [Caddy](https://caddyserver.com) in front of the app. Caddy gets the certificate itself, redirects HTTP to HTTPS, adds HSTS, passes WebSockets (live updates, terminal, previews) through, and sends `X-Forwarded-Proto/Host/For`.

1. **DNS and ports**: point an A/AAAA record for your domain (e.g. `agentforge.example.com`) at the server, and open TCP 80 and 443 in the firewall / cloud security group (80 is needed for the certificate and the redirect).
2. **Install Caddy** ([install docs](https://caddyserver.com/docs/install); Debian/Ubuntu: the `caddy` apt package, which runs as a systemd service). Copy the config with `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile`. Then either replace `{$AF_DOMAIN}` in it with your domain, or run `sudo systemctl edit caddy` and add `Environment=AF_DOMAIN=agentforge.example.com` under `[Service]`. Check it with `AF_DOMAIN=agentforge.example.com caddy validate --config /etc/caddy/Caddyfile` (the variable is needed in the shell unless you replaced the placeholder), then `sudo systemctl reload caddy`. Open `https://<domain>` and sign in while the old address still works.
3. **Trust the proxy**: set `TRUST_PROXY=1` in `.env`. The app then believes `X-Forwarded-*` only from a proxy on this host (loopback), so the session cookie is `Secure` over https, WebSockets accept the `https://<domain>` origin, and the request IP is the real client's. For a proxy on another machine, list its addresses instead (`TRUST_PROXY=10.0.0.5` or a CIDR). Without `TRUST_PROXY`, forwarded headers are ignored, so direct clients can not fake them.
4. **Close the plain port**: set `HOST=127.0.0.1` in `.env` so only the proxy can reach 4800, and restart (**Safe restart** or `npm run stop && npm start`). Then remove any firewall rule that opened 4800. Do this only after `https://<domain>` works, or remote users lose access.

**No domain?** Use Caddy's own certificate authority on the IP or LAN name: in the Caddyfile, comment out the `{$AF_DOMAIN}` block and enable the `tls internal` block with your address (e.g. `https://192.168.1.20`). Browsers warn until they trust Caddy's root certificate: `caddy trust` on the server, and on other computers import `root.crt` from Caddy's data directory (`/var/lib/caddy/.local/share/caddy/pki/authorities/local/` for the apt package). Steps 3 and 4 stay the same.

## Users

Every page and API needs a signed-in account (`GET /api/health` excepted). On a fresh install, or right after the deploy that added accounts, the homepage offers **Create the administrator account**: the first account becomes the administrator (the owner). Later sign-ups (a username only: the account is bound to a random device secret kept by that browser) wait for approval on the admin-only **Users** page, where the administrator approves or rejects them, disables, enables or deletes accounts, grants projects and capabilities, and resets a user's device binding. Non-admins never see the AgentForge project. Approved accounts sign in from their browser with no password; another computer is refused. Accounts from before keep their password and bind their browser at the next login. Break-glass: `AF_ADMIN_USERNAME` / `AF_ADMIN_PASSWORD` in `.env`, or `node scripts/reset-admin.js <user> <password>`. Details: [docs/users.md](docs/users.md).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Fastify | One language across UI, API and orchestration; non-blocking I/O for many agent processes, WebSockets and terminals |
| Frontend | React + Vite + Tailwind CSS | VS Code-style single-page control room; seconds-fast rebuilds make self-updates cheap |
| Database | PostgreSQL | Relational integrity for projects, tasks, runs and audit; JSONB for skills, plans and reports |
| Agent runtime | Claude Code CLI (`claude -p --output-format stream-json`) | Real file and tool access per project, streamed tool calls, usage and plan rate limits |
| Not yet | Redis, Qdrant, Better Auth, Cloudflare | Not needed on a single node; add when scaling out or exposing publicly |

## How a mission runs

1. **Plan**: the project's General Manager (one per project) turns the order into task contracts: role, skills, scope, acceptance criteria and dependencies. Usually that is one task, so one agent does the whole order the way a single Claude Code session would. The planner runs without tools; it reads files only to declare them when other missions share the working tree.
2. **Staff**: for each task, the best idle agent of that role is chosen by skill score. If it is busy, it is **cloned**; if the role does not exist, a new specialist is **recruited** and placed in the hierarchy.
3. **Execute**: a DAG scheduler runs independent tasks in parallel (`maxParallel`). Write-roles may edit files; read-roles (research, security, review) cannot.
4. **Verify**: each agent verifies its own change (relevant tests or build). An independent reviewer task is added only when several agents change code in one mission, or when the order asks for a review.
5. **Report**: every agent reports upward to the GM. Agents may raise **proposals**. By default these wait for your approval; with "Superiors decide agent proposals" on, the GM decides them. Approved proposals become new missions, which queue behind the user's own orders in the topic.
   An agent's next task in the same topic resumes its previous Claude Code session (within 60 min, up to 120k context tokens), and a retry resumes the failed attempt, so the code is not re-read from scratch.
6. **Sync**: if Claude Code changed files, the project is committed and pushed (source only: `.gitignore` is enforced and files over 50 MB are skipped).
7. **Evolve**: XP, levels, skill growth and lessons are recorded. Lessons are curated into versioned playbooks. Agents with repeated failures run a candidate playbook, which is promoted only if it beats their baseline success rate and is rolled back otherwise.

Command-window slash commands: `/standup` (coordination meeting), `/sync` (push now), `/stop` (cancel the mission).

## Safe self-restart

`scripts/supervisor.js` watches the source:

- **server/** changes go through four steps: `node --check` the changed files, boot a candidate on port + 1, health-check it, then wait until no agent is mid-task and swap. A failing candidate never replaces the running service; the error appears in the status bar and notifications.
- **client/** changes are rebuilt into `client/dist-next` and swapped in atomically, and open browsers reload.

The AgentForge project itself is registered as a protected, undeletable project, so agents can develop this platform. Their changes are pushed and the service restarts itself safely.

## Bittensor competitions

The server can watch a Bittensor network for new subnets (competitions). For each new one it shows a notification, lists the competition on the Dashboard (**Bittensor competitions**), creates one agent with role `miner` (title **Mino**) and a task describing the competition, and then runs the submission step. The watcher stays off until you configure it. With no config file, an empty one or `"enabled": false`, it only logs `[bittensor] watcher inert: …`. Nothing from these files is committed: `config/bittensor.json` and `config/bittensor.secrets.json` are in `.gitignore`.

1. **Settings:** `cp config/bittensor.example.json config/bittensor.json`, then set `"enabled": true`.
   - `network`: `finney`, `test` or `local`. `endpoint` defaults to the network's public entrypoint (`ws://` and `wss://` URLs are also accepted).
   - `sources`: any of `rpc` (chain state over JSON-RPC, the default), `sdk` (`scripts/bittensor/list_subnets.py`, which needs `pip install bittensor`), `feed` (`feed.url` returning a JSON array of `{ id?, netuid?, name?, registered_block? }`) and `file` (the same JSON from `file.path`).
   - `pollIntervalSec`: at least 30.
   - `subnets.include` / `subnets.exclude`: lists of netuids.
   - `baselineOnFirstRun`: when true (the default), the subnets that already exist on the first poll are recorded without starting agents.
   The file is re-read on every poll, so you don't need to restart the server after editing it.
2. **Keys:** `cp config/bittensor.secrets.example.json config/bittensor.secrets.json`, then fill in `wallet.name` and `wallet.hotkey`. These two are required to submit. You can also set `wallet.path`, `coldkeyPath`, `coldkeyPassword` and `coldkeyMnemonic`, plus `apiKeys.feed`, which is sent as a Bearer token to the feed. Secret values are passed to the submit command only through `BT_*` environment variables, and they are redacted from stored output.
3. **Auto-submit:** set `"autoSubmit": true` **and** `"dryRun": false` in `config/bittensor.json`.
   - Submission runs only when enabled, autoSubmit, !dryRun and keys are all in place. Otherwise each competition records `would submit (dry-run)` together with the reason.
   - The command is `submit.command`. The default, `scripts/bittensor/submit.sh`, registers the hotkey with `btcli subnets register`. **Registration burns TAO.** Check the cost before you arm it.
   - Each competition gets one run. A run cut short by a restart is recorded as failed and is not retried automatically.
   - The result (`dry-run`, `submitted` or `failed`, with the output) is shown on the Dashboard card.

The API is `GET /api/bittensor` (watcher status and competitions; the status never includes secrets) and `POST /api/bittensor/poll` (poll now).

## Layout

```
server/
  index.js              Fastify app, WebSockets (/api/events, /api/terminal), static UI
  orchestrator/         engine (missions, staffing, scheduler), prompts, evolution, heuristics
  models/               Claude Code, Anthropic API, OpenAI-compatible, offline simulator
  services/             agents, projects, git sync, terminal (node-pty), notifications
  routes/               REST API (projects, agents, models, files, settings, github…)
  db/                   schema.sql (idempotent), seed, pool
client/src/
  views/                Dashboard, projects (command window, agent rail), agents, files, Models, GitHub, Settings
  components/           shell, split panes, modal, context menu, charts, markdown
  lib/                  store (zustand), live events, 22 screen-format presets, dynamic favicon
config/                 *.example.json templates (real bittensor config/keys are gitignored)
scripts/                supervisor.js, dev.js, bittensor/ (SDK subnet lister, submit placeholder)
```
