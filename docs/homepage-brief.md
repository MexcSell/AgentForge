# AgentForge homepage brief

| | |
|---|---|
| **For** | Whoever builds the new AgentForge homepage (designer, front-end developer or AI site builder) |
| **Written** | 2026-11-02, from the repository at commit `f6505ff` |
| **Sources** | Only this repository: `README.md`, `server/`, `client/src/`, `scripts/`, `docs/design/topics.md`, git history. Source keys are spelled out in §9 |
| **Rule** | Every feature below exists in the code. Anything unverified is marked **(uncertain)**. Things that are planned but not built are listed in §8 |

You don't need to know the project to use this brief. §1 is a ready-to-paste prompt. §2 to §6 are the product facts and visual identity behind it. §7 is draft copy.

---

## 1. Copy-paste homepage prompt

> Paste everything inside the block below into an AI site builder, or hand it to a designer. It stands on its own.

```text
Design and build a modern, single-page marketing homepage for AgentForge.

WHAT AGENTFORGE IS
AgentForge is a self-hosted control room where a hierarchical organization of AI agents builds software for you.
You give an order in plain language to a project's General Manager (an AI agent). The GM turns the order into
task contracts (role, skills, scope, acceptance criteria, dependencies), staffs each task from an agent registry
(reusing, cloning or recruiting specialists such as frontend, backend, QA, security, docs), runs the tasks in
parallel as real Claude Code or Codex CLI sessions inside your project folder, has the work verified, commits
and pushes the result to GitHub, and records what each agent learned (XP, levels, skills, playbooks).
It runs on your own machine (Node.js + PostgreSQL), opens in the browser at http://127.0.0.1:4800 and looks like
VS Code: an activity bar, resizable panes, a status bar and a command palette.

AUDIENCE
Solo developers and small teams who already use Claude Code or Codex CLI and want them to work like an
engineering team: several agents in parallel, a clear chain of command, and an audit trail. Also AI-agent
tinkerers who want an organization that improves itself.

POSITIONING (one line)
"Your AI engineering org: give an order, and a team of agents plans it, builds it, checks it and ships it to GitHub."

SECTIONS (in this order)
1. Hero: headline, subheadline, primary CTA "Run it locally", secondary CTA "View on GitHub".
   Visual: a dark, VS Code-style app window with three panes: project list | command window (chat with the GM
   showing an order, a plan card and a "Mission done · 3/3 tasks" summary card) | agent rail with avatars.
2. How it works: 6 steps in a horizontal flow: Order → Plan → Staff → Execute → Verify → Sync.
   Add a small "Learn" loop arrow back to Staff (agents gain XP and lessons after each mission).
3. The organization: an org-chart illustration. The top is "AgentForge Agent" (executive), below it the project
   General Managers, below them specialists (Frontend, Backend, QA, Security, Docs…). Message: agents have
   roles, levels, XP and skills; each task is done by a full clone of the role's best agent, so the originals stay
   clean, and the clone is retired when the mission ends.
4. Feature grid (6–8 cards): Topics & missions · Agent registry & org chart · Parallel missions with file leases ·
   Proposals with superior triage · Automatic GitHub sync · Safe self-restart · Claude Code & Codex CLI workers ·
   Live dashboard and machine metrics.
5. "Built to develop itself": AgentForge is registered as its own protected project; agents change the platform,
   it pushes to GitHub and restarts itself only after a candidate build passes a health check.
6. Make it yours: light/dark themes, 7 accent colors, 21 screen-format presets, every pane resizable.
7. Optional, small: "Also watches Bittensor subnets": an opt-in watcher that creates a miner agent per new competition.
8. FAQ (5–7 questions), then a final CTA band: "npm install && npm start".

KEY MESSAGES
- One order in, a finished change out, with a plan, reports and a commit to show for it.
- A real org chart: supervisors, line managers, independent verification.
- Agents get better: XP, skill levels and lessons are kept and fed into versioned playbooks.
- Your machine, your repo: runs locally on 127.0.0.1, works on your project folders, pushes only source files.

TONE
Confident, precise, engineer-to-engineer. Short sentences. No hype words ("revolutionary", "magic").
Show real UI and real terms (mission, topic, GM, clone, playbook).

VISUAL DIRECTION (match the real app)
- Dark-first. Background #09090b, panels #0f0f12, raised surfaces #16161a, hairline borders rgba(255,255,255,0.075).
  Text #ededf0, muted #a1a1aa, subtle #6e6e78.
- Accent: indigo #6366f1 → violet #8b5cf6 gradient (135°), used for primary buttons, active-tab bars and
  highlights. Logo tile gradient #818cf8 → #6d28d9 with a white "A" stroke.
- Status colors: ok #2fbf71, warn #f5b041, bad #f05252, info #3987e5.
- Light-mode section option: background #f6f6f4, panels #ffffff, text #121214.
- Type: Inter (variable) for UI and headings, slight negative letter-spacing on headings; JetBrains Mono for
  code, paths and commands.
- Shapes: 10px radius cards, 1px hairline borders, soft large shadows, a subtle dot-grid background (18px),
  frosted "glass" header (blur 14px). Icons: Lucide line icons.
- Motion: small fade/slide-in (160ms), a pulsing status dot, an accent dashed line flowing into a working agent's
  card in the org chart. Respect prefers-reduced-motion.
- Fully responsive; WCAG AA contrast.

CALLS TO ACTION
Primary: "Run it locally" (shows: git clone … && npm install && npm start, then open http://127.0.0.1:4800).
Secondary: "View on GitHub" (https://github.com/MexcSell/AgentForge), "Read the docs".
Requirements line under the CTA: Node.js ≥ 20 · PostgreSQL · Claude Code CLI (Codex CLI optional).

DO NOT CLAIM
No sign-up, pricing or hosted cloud version (it is self-hosted and has no login). Don't call it open source
unless the owner confirms a license. Don't mention Redis, Qdrant, Better Auth, Cloudflare or Next.js
(they are not part of the product).
```

---

## 2. Product documentation

### 2.1 What AgentForge is

AgentForge is a self-hosted web app (Node.js + Fastify, React, PostgreSQL) that runs a **hierarchical, self-evolving organization of AI agents** as a software team [readme] [pkg]. You create a project (a working directory, optionally a GitHub URL) and talk to its **General Manager (GM)** in a chat-like command window. The GM turns each order into task contracts and staffs them from a shared **agent registry**. Each worker is a real CLI coding agent (Claude Code by default, Codex CLI optional) running in the project folder [engine] [models].

At the top of the organization is **AgentForge Agent**, the executive. It also serves as GM of the AgentForge project itself, which is registered as a protected, undeletable project so that agents can develop the platform [seed] [readme].

### 2.2 Who it is for

- Developers who already use Claude Code / Codex CLI and want several agents to work in parallel under coordination instead of running one session at a time.
- Small teams that want an audit trail of who planned, did, verified and pushed each change.
- People exploring multi-agent organizations (roles, hierarchy, self-improvement) on real code.

### 2.3 Problems it solves

| Problem | What AgentForge does | Source |
|---|---|---|
| One long chat carries all history, which costs tokens and is hard to scan | **Topics** split the project chat into threads with their own context; a new topic sends no prior missions | [topics-spec] [engine] |
| A single agent session does everything serially | The GM plans a DAG of tasks; independent tasks run in parallel (`maxParallel`, default 3) | [readme] [seed] |
| Parallel agents step on each other's files | **File leases** between missions of one project: a write task holds its declared files, and colliding tasks wait | [engine] |
| No one checks the agent's work | Every agent verifies its own change; an independent reviewer is added when several agents change code, or on request | [readme] [roles] |
| Results stay local and unversioned | **Automatic GitHub sync** after each mission: commit message written by the GM, `.gitignore` enforced, files > 50 MB skipped | [git] |
| Agents don't learn from past work | XP, levels, skill growth, lessons and versioned **playbooks** with A/B-style promotion and rollback | [evolution] |
| Self-modifying software can break itself | The supervisor checks syntax, boots a candidate, health-checks it and swaps only when agents are idle | [supervisor] [readme] |

---

## 3. Core features (as built)

### 3.1 Projects, topics and missions
- Project list on the left, command window in the middle, agent rail on the right. Multi-select, rename (F2), "Open in Files", "Sync to GitHub", delete (the protected AgentForge project can't be deleted) [projects-view].
- **Topics**: each project chat is split into topic tabs with tags, unread state, archive and an "All topics" popover. The GM can move an order to a fresh topic and posts a notice when it does [topics-spec] [engine:moved].
- **Missions**: each order becomes a mission. Missions in different topics run concurrently; orders in one topic run in sequence [settings-view] [engine].
- Message types in the feed: Plan, Report, Proposal, Mission summary, Stand-up meeting, Error [command-window].
- Slash commands: `/new [title] [#tag…]`, `/standup`, `/sync`, `/stop` [command-window].
- Images can be pasted or attached to an order [command-window] [api:uploads].
- An agent's next task in the same topic resumes its previous CLI session (within 60 min, up to 120k context tokens) [engine:resume].

### 3.2 GM feed and mission digests
- The topic feed keeps the GM's headlines (orders, plans, summaries, errors, meetings). Worker reports, proposals and chatter fold into one row per mission; an escalated proposal that needs you stays visible [feed].
- At mission end the GM writes a **digest** from the task reports: `Mission done · 3/3 tasks · duration · tokens`, then the summary [engine:digest].

### 3.3 Agent registry: roles, levels, XP, skills
- 19 roles in 5 tiers: Executive Intelligence, Management & Orchestration, Specialist Teams, Independent Verification, Self-Evolution. Examples: Executive Director, General Manager, Chief Architect, Frontend/Backend/Full-stack, UI/UX Designer, Database, AI, DevOps, Research, Technical Writer, QA, Security Auditor, Independent Code Reviewer, Performance Analyst, Prompt Optimizer, and **Mino** (Bittensor miner) [roles].
- Each role is either *write* (may edit files) or *read* (inspects and reports) [roles].
- Agents have a codename (Orion, Nova, Quill…), level, XP, skills scored 0–100, a mission statement, a purpose and a supervisor. Level = 1 + ⌊√(XP / 40)⌋ [roles] [evolution].
- Seeded organization: AgentForge Agent (executive) with Darwin (evolution), Archer (architect), Lens (reviewer) and Scout (research) reporting to it [seed].
- Agents view tabs: **Registry**, **Org chart**, **Evolution** [agents-view]. Clicking an agent opens a detail dialog with status, XP progress, skills, history and live output [agent-detail].

### 3.4 Full-clone staffing
- For each task the GM picks the best agent of the role by skill score. Originals never work themselves: the task goes to a **clone leased to the mission**, and if the role doesn't exist yet, a new specialist is recruited and kept as the original [engine:staff].
- When the mission ends (done, failed or cancelled), its leased clones are **retired**. Each keeps what it learned, the originals stay untouched, and any pending work of a retired clone is handed over. Freed clone numbers and archived names are reused [engine:retire] [agents-svc] [git-log].
- Merging a clone into its original is a separate, manual action (§3.7).
- The executive is never cloned or recruited [engine:staff].

### 3.5 Project members and org chart
- Staffed agents join the project as members. You can add agents, release one or all idle ones, and restore released agents. A released agent is never auto-staffed again on that project [members] [rail].
- The project's **Org** view shows the hierarchy as a wrapping tree of cards. The GM is shown as "orchestrating" during active missions, and an animated connector flows into a working agent's card [org-view] [styles].

### 3.6 Proposals and triage
- Agents can raise **proposals** (follow-up work). With "Superiors decide agent proposals" on, the proposer's line supervisor approves, rejects or escalates; the GM or the executive decides finally. Only escalations reach you. Otherwise proposals wait for your Approve/Reject. Approved proposals become missions that queue behind your own orders [engine:triage] [settings-view] [readme].
- Default: proposals wait for your approval (`proposalTriage: false`, `autoApproveProposals: false` in the seeded settings) [seed].

### 3.7 Hand-over, merging and role consolidation
- **Hand-over**: when an agent or project is deleted, or a clone is merged, its pending work is handed over to a replacement. Delete and merge confirms preview the hand-overs first [agents-svc] [api] [handover-ui].
- **Merge**: fold a clone back into its original (skills, XP and lessons combined; playbooks folded) [agents-svc:merge] [evolution].
- **Consolidate role**: fold several same-role agents into one keeper you choose, with a preview dialog [agents-svc:consolidate] [consolidate-ui].

### 3.8 Self-evolution
- After every task: experience, skills, XP and lessons are recorded. Lessons are curated into versioned playbooks. Agents with repeated failures run a candidate playbook, which is promoted only if it beats their baseline success rate and is rolled back otherwise. Stages: observe → diagnose → generate → experiment → evaluate → promote [evolution] [schema].
- The GM also earns XP and orchestration skills from the missions it leads [evolution:learnMission] [git-log].

### 3.9 File leases and concurrent missions
- Missions of different topics share one working tree. A running write task holds the files its plan declared (plus the files it is seen editing); a colliding task waits, still pending, until a task of the project finishes. Only running tasks hold leases, so waiting can't deadlock [engine:leases].

### 3.10 GitHub sync and safe restart
- After a mission that changed files, the project is committed (the GM writes the commit message) and pushed. Source only: `.gitignore` is enforced, files over 50 MB are skipped, and files still being edited by another in-flight mission are deferred to its sync. Auto-upload is on by default; there is also a manual sync (`/sync`, context menu, GitHub view) [git] [seed] [github-view].
- **Safe self-restart** (`npm start` supervisor): server changes are syntax-checked, booted as a candidate on port + 1 and health-checked, and swapped in only when no agent is mid-task. Client changes are rebuilt into `client/dist-next`, swapped in atomically, and open browsers reload. Failures show in the status bar [supervisor] [readme] [shell].

### 3.11 Models and workers
- Providers: **Claude Code** and **Codex CLI** (can edit files), plus Anthropic API, OpenAI GPT, OpenAI-compatible and Simulator (read-only) [models].
- Model Manager shows daily/weekly tokens and prompts, cost, reset times and optional limits; a model that hits a limit stops with a clear message [models] [models-view].

### 3.12 Workspace tools
- **Files**: multi-pane file manager (Ctrl multi-select, drag to move, Ctrl/Alt-drag to copy, copy/cut/paste, duplicate, rename, download, delete), a syntax-highlighted viewer/editor (CodeMirror, Markdown rendered) and a built-in shell terminal (xterm + node-pty) per path [files-view] [terminal] [pkg].
- **Preview**: runs the project's dev server and shows it in an embedded frame with Desktop / Tablet (768) / Mobile (390) viewports and an output console [preview] [runner].
- **Dashboard**: tiles for service status, projects running, agents working, tasks today, tokens today, unread notices; charts for 14-day task throughput and task states; recent missions, top agents, service health, notifications feed, Bittensor competitions [dashboard].
- **Host metrics** in the status bar: CPU (GHz, %), RAM, storage and network, read from `/proc` and `/sys` (Linux) and switchable in Settings [metrics] [settings-view].
- **Live browser tab**: the favicon shows service status (dot), unread count (badge), and the title shows how many agents are running [favicon].
- **Command palette** (Ctrl/⌘ K) and view shortcuts Alt+1…7 [app] [shell].

### 3.13 Bittensor watcher with miner agents (opt-in)
- Watches a Bittensor network (finney, test or local) for new subnets via RPC, SDK, a JSON feed or a file. For each new competition it notifies you, lists it on the Dashboard, creates a **Mino** (`miner` role) agent with a task, and runs a submission step [bittensor] [readme].
- Off until configured; dry-run by default. Real submission needs `autoSubmit: true`, `dryRun: false` and wallet keys. The default submit script registers a hotkey, which **burns TAO**. Secrets are passed only through environment variables and redacted from output [readme] [bittensor].

---

## 4. How it works

```
 ┌───────┐   ┌──────┐   ┌───────┐   ┌─────────┐   ┌────────┐   ┌──────┐
 │ Order │ → │ Plan │ → │ Staff │ → │ Execute │ → │ Verify │ → │ Sync │ → (Report · Learn)
 └───────┘   └──────┘   └───────┘   └─────────┘   └────────┘   └──────┘
```

1. **Order**: you type an order in a project topic (text and images; `/new` starts a topic) [command-window].
2. **Plan**: the GM turns it into task contracts: role, skills, scope, acceptance criteria, dependencies. Usually that's one task; the planner runs without tools [readme] [prompts].
3. **Staff**: each task gets a clone, leased to the mission, of the role's best agent. A missing role is recruited and placed in the hierarchy [engine:staff].
4. **Execute**: a DAG scheduler runs independent tasks in parallel as Claude Code / Codex CLI sessions; file leases keep concurrent missions apart; write roles edit, read roles only inspect [readme] [engine].
5. **Verify**: each agent tests or builds its own change; an independent reviewer is added when several agents change code or the order asks for it. A failed task can be retried once with the failure context [readme] [settings-view].
6. **Sync**: changed files are committed and pushed to GitHub [git].
7. **Report & learn**: agents report to the GM, who posts a mission digest; proposals are triaged; XP, skills and lessons update; the mission's leased clones are retired [engine] [evolution].

---

## 5. Visual identity (current UI)

No screenshots are stored in the repository. The values below come from `client/src/styles.css`, `client/src/lib/*` and the views.

### 5.1 Type
- **Inter Variable** for all UI text, with OpenType features `cv11`, `ss01`, `ss03`; headings weight 650 with `-0.01em` tracking [styles].
- **JetBrains Mono Variable** for code, paths, hashes and the terminal [styles].
- Root size 14.5px (scaled by the screen-format preset); small uppercase tracked labels (`0.72rem`) on dashboard cards [styles] [dashboard].

### 5.2 Color tokens

| Token | Dark (default) | Light |
|---|---|---|
| Background | `#09090b` | `#f6f6f4` |
| Panel | `#0f0f12` | `#ffffff` |
| Raised | `#16161a` | `#ffffff` |
| Sunken | `#0b0b0e` | `#f1f1ef` |
| Line | `rgba(255,255,255,.075)` | `rgba(15,15,20,.085)` |
| Text | `#ededf0` | `#121214` |
| Muted / subtle | `#a1a1aa` / `#6e6e78` | `#5b5b63` / `#8c8c95` |
| OK / Warn / Bad / Info | `#2fbf71` / `#f5b041` / `#f05252` / `#3987e5` | `#0a8f3c` / `#b7791f` / `#d03b3b` / `#2a78d6` |

- **Accent** (user-selectable; default **indigo**): indigo `#6366f1`→`#8b5cf6`, violet, blue, emerald, amber, rose, mono. Used as a 135° gradient (`grad-accent`) and for focus rings and selection [styles] [store].
- Default theme is **dark**; options Light / Dark / System [store] [settings-view].
- **Logo / favicon**: rounded square with an `#818cf8 → #6d28d9` gradient and a white stroked "A", a status dot (green online, blue busy, amber degraded/restarting, red down, grey offline) and a red unread badge [favicon].

### 5.3 Shape, depth, motion
- Radius 10px by default (6–14px by preset); 1px hairline borders; soft two-layer shadows; frosted `glass` surfaces (blur 14px); `dotgrid` background (18px) in floating layouts [styles] [layouts].
- Motion: 160ms fade/slide-in, pulsing status dot, shimmer for loading, an accent dashed line flowing into a working agent's card; honours `prefers-reduced-motion` [styles].
- Icons: Lucide line icons throughout [pkg].

### 5.4 Layout and main panes
- **Shell**: title bar, a left activity bar (Dashboard, Projects, Agents, Files, Models, GitHub, Settings), the main view, and a 24px status bar (service status and uptime, restart/build state, active project, agents working, machine usage, default model tokens today, layout name, version · commit) [app] [shell].
- **Projects**: three resizable panes: project list | command window (topic strip, mission bar, message cards, composer with image attach) | agent rail / Org [projects-view] [layouts].
- **Agents**: Registry grid, Org chart, Evolution timeline [agents-view].
- **Files**: split file panes with a terminal at the bottom [files-view].
- **21 screen-format presets** (Standard, Compact, Comfortable, Focus, Zen, Wide Chat, Agent Ops, Mirror, Command Center, Terminal Heavy, Stacked, Presentation, Large Text, Dense Data, Ultrawide, Laptop 13", Tablet, Mobile, Cinema, Floating Cards, Labeled Rail). Every pane is resizable and sizes are remembered per format [layouts]. (The README says "22 screen-format presets"; the code defines 21.)
- Components: `Button`, `IconButton`, `Badge`, `Tabs`, `Toggle`, `Input`, `Select`, `Modal`/`Confirm`, context menus, toasts, sparkline/meter charts, Markdown with highlighted code [ui] [charts].

---

## 6. Facts for the homepage footer / requirements block

- Runs with `npm install && npm start`; UI at `http://127.0.0.1:4800` [readme].
- Requires Node.js ≥ 20, PostgreSQL and the `claude` CLI logged in; `gh` is used for push credentials when authenticated [readme].
- Binds to 127.0.0.1 only, has **no authentication yet** and includes a shell terminal, so it must not be exposed to a network as-is [readme].
- Repository: https://github.com/MexcSell/AgentForge [design].

---

## 7. Draft homepage copy

### 7.1 Headline options
1. **Give an order. Get a team.**
2. **Your AI engineering org, running on your machine.**
3. **From one order to a pushed commit, with a whole agent team in between.**
4. **Claude Code, organized.**
5. **Agents that plan, build, verify and ship, and get better each time.**

### 7.2 Subheadlines
- AgentForge turns your order into task contracts, staffs them from a registry of specialist agents, runs them in parallel on Claude Code or Codex CLI, verifies the result and pushes it to GitHub.
- A General Manager plans. Specialists build. Reviewers verify. Every change lands in your repo with a report, and every agent learns from it.
- A VS Code-style control room for a hierarchy of AI agents, self-hosted on your own machine.

### 7.3 Feature blurbs
- **Topics and missions.** Each thread keeps its own context, so orders stay small and focused. Missions in different topics run at the same time.
- **A real org chart.** Executive, General Managers, specialists and verifiers, with supervisors, levels, XP and skills you can see.
- **Clones on demand.** Every task is done by a full clone of the role's best agent, leased to the mission, so you can run as many in parallel as you need and the originals stay clean.
- **No stepping on toes.** File leases keep concurrent missions off each other's files.
- **Checked before shipped.** Agents verify their own changes, and an independent reviewer joins when several agents touch the code.
- **Ships to GitHub.** Source-only commits with GM-written messages, pushed automatically after each mission.
- **Proposals, triaged.** Agents suggest follow-up work; their supervisors approve, reject or escalate, so only real decisions reach you.
- **It improves itself.** Lessons become versioned playbooks. A new playbook is kept only if it beats the old one.
- **Restarts safely.** Changes to AgentForge itself are health-checked as a candidate and swapped in only when no agent is working.
- **Your workspace, your way.** Light or dark, 7 accents, 21 screen formats, a file manager, terminal, live preview and machine metrics built in.

### 7.4 FAQ

**What do I need to run it?**
Node.js 20+, PostgreSQL and the Claude Code CLI logged in. Run `npm install && npm start` and open `http://127.0.0.1:4800`.

**Which models do the work?**
File-editing work runs on the Claude Code CLI (the default) or the Codex CLI. You can also add Anthropic API, OpenAI GPT and OpenAI-compatible models, which run read-only.

**Do several agents really work at once?**
Yes. Independent tasks in a mission run in parallel (3 by default, up to 12), and missions in different topics run concurrently. File leases keep them from editing the same files.

**Will it push to my GitHub automatically?**
After a mission that changed files, yes, if auto-upload is on (the default). It commits source only: `.gitignore` is enforced and files over 50 MB are skipped. You can also sync manually with `/sync`.

**Who decides what agents do next?**
You. Agents can propose follow-up work. By default proposals wait for your approval; you can let supervisors triage them so only escalations reach you.

**Is it safe to put on a server?**
Not yet. It binds to 127.0.0.1, has no login and includes a shell terminal. Keep it local.

**What is the Bittensor watcher?**
An optional module that watches a Bittensor network for new subnets and creates a "Mino" miner agent for each one. It is off and in dry-run mode until you configure it.

---

## 8. Design doc vs. shipped, and open questions

| `design.md` / older docs say | Shipped code | Use on homepage |
|---|---|---|
| Frontend: Next.js | React + Vite + Tailwind CSS [pkg] [readme] | React / Vite |
| Redis, Qdrant, Better Auth, Cloudflare | Listed as "Not yet" in README; not in dependencies [readme] [pkg] | Don't mention |
| "About 20 screen formats" / README "22 presets" | 21 presets in `layouts.js` [layouts] | "21 screen formats" |
| "Free and open source" | `package.json` is `"private": true`; no LICENSE file in the repo | **(uncertain)** Don't claim open source until the owner confirms a license |

Uncertain or not verified:
- **License / public availability (uncertain)**: no LICENSE file; whether the GitHub repo is public was not checked.
- **Screenshots**: none exist in the repo. Capture them from a running instance (dark theme, indigo accent, Standard format) before launch.
- **Host metrics** read Linux `/proc` and `/sys`; behaviour on macOS/Windows was not checked **(uncertain)**.
- **Codex CLI** is supported as a provider; whether it is as well tested in missions as Claude Code was not measured **(uncertain)**.

---

## 9. Source keys

| Key | Path |
|---|---|
| readme | `README.md` |
| design | `design.md` (original, machine-translated requirements) |
| pkg | `package.json` |
| topics-spec | `docs/design/topics.md` |
| engine | `server/orchestrator/engine.js` (`:leases` ~L24–90, `:moved` ~L383, `:staff` ~L484–515, `:retire` ~L518–530, `:resume` L898–899, `:digest` ~L612–645, `:triage` ~L1196–1260) |
| prompts | `server/orchestrator/prompts.js` |
| evolution | `server/orchestrator/evolution.js` (`levelFor` L19, `learnMission` L107, promote/rollback L75–82) |
| roles | `server/roles.js` |
| seed | `server/db/seed.js` |
| schema | `server/db/schema.sql` |
| agents-svc | `server/services/agents.js` (`mergeAgent`, `replacementFor`, `previewConsolidate`, `consolidateRole`) |
| members | `server/services/members.js` |
| git | `server/services/git.js` |
| metrics | `server/services/metrics.js` |
| runner | `server/services/runner.js` |
| terminal | `server/services/terminal.js` |
| bittensor | `server/services/bittensor.js` |
| models | `server/models/index.js` |
| api | `server/routes/api.js` (`:uploads` `/api/uploads`) |
| supervisor | `scripts/supervisor.js` |
| app | `client/src/App.jsx` |
| shell | `client/src/components/Shell.jsx` |
| ui / charts | `client/src/components/ui.jsx`, `client/src/components/charts.jsx` |
| styles | `client/src/styles.css` |
| store | `client/src/lib/store.js` |
| layouts | `client/src/lib/layouts.js` |
| favicon | `client/src/lib/favicon.js` |
| feed | `client/src/lib/feed.js` |
| dashboard | `client/src/views/Dashboard.jsx` |
| settings-view | `client/src/views/Settings.jsx` |
| models-view | `client/src/views/Models.jsx` |
| github-view | `client/src/views/GitHub.jsx` |
| projects-view | `client/src/views/projects/Projects.jsx` |
| command-window | `client/src/views/projects/CommandWindow.jsx` |
| rail | `client/src/views/projects/AgentRail.jsx` |
| org-view | `client/src/views/projects/AgentOrg.jsx` |
| preview | `client/src/views/projects/PreviewWindow.jsx` |
| agents-view | `client/src/views/agents/Agents.jsx` |
| agent-detail | `client/src/views/agents/AgentDetail.jsx` |
| handover-ui | `client/src/views/agents/HandOverPreview.jsx` |
| consolidate-ui | `client/src/views/agents/consolidate.jsx` |
| files-view | `client/src/views/files/Files.jsx` |
| git-log | `git log` (e.g. `e6f80d7` full clones, `0c54fac` GM XP, `9a02e34` Bittensor) |
