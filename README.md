# AgentForge

A self-evolving, multi-agent software engineering control room. You give a project's **General Manager** an order; it splits the order into task contracts, staffs them from a hierarchical agent registry (reusing, cloning or recruiting specialists), runs them in parallel on Claude Code, has independent agents verify the result, pushes the change to GitHub, and feeds what it learned back into the agents' playbooks.

## Run

```bash
npm install
npm start            # supervisor: builds the UI, serves http://127.0.0.1:4800, restarts safely on changes
npm run stop         # stop the supervisor
npm run logs         # follow data/logs/agentforge.log
npm run dev          # development: API with --watch + Vite HMR on :5173
npm run db:check     # PostgreSQL connectivity check
```

Requirements: Node.js ≥ 20, PostgreSQL (defaults: `localhost:5432`, db `agentapp`, user/password `agentuser`), and the `claude` CLI logged in. `gh` is used for push credentials when it is authenticated. Override settings in `.env` (see `.env.example`).

The service binds to `127.0.0.1` only. It has no authentication yet and includes a shell terminal, so do not expose it to a network as-is.

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
scripts/                supervisor.js, dev.js
```
