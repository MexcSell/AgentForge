I'm assuming "Agent Hoge" means AgentForge, this repo. The slowness isn't Claude Code itself: once a run starts it works at normal speed, and the engine adds only about 10 s of overhead per mission. The time goes into **waiting and repeated work**. I checked this against the last 30 days of the `runs`/`missions` tables in the live DB, using read-only queries.

## 1. Orders queue behind each other in one topic (the biggest cause)
[engine.js:219](server/orchestrator/engine.js#L219) `pump()` runs **one mission at a time per topic**. Accepted proposals also become new missions in the same topic, so the queue keeps growing.

This morning in the "Test harness noise" topic:

| Order | Created | Plan started | Finished |
|---|---|---|---|
| Commit a cn regression test | 06:34 | 07:03 | 07:07 |
| Extend the browser harness | 06:53 | 07:07 | 07:23 |
| Turn off the Vite HMR websocket | 06:57 | **07:23** | 07:27 |

That last order took 4 minutes of actual work and waited 26 minutes first. On recent missions, **wait before planning was 15–29 min, against 4–15 min of actual work**. In VS Code you never wait for a previous order to finish.

## 2. Every mission is a serial chain with a long verification step
The plan prompt makes this mandatory ([prompts.js](server/orchestrator/prompts.js#L80)): *"Code-changing work must be followed by an independent verification task (reviewer or qa)"*. So each mission runs:

plan (~30–60 s) → implement → QA/reviewer → commit + digest

Verification usually takes longer than the change itself:

| Role | Avg run | Bash calls |
|---|---|---|
| frontend (implementation) | 185 s | 17 |
| qa | 449 s | 30 |
| reviewer | 453 s | 31 |

Tasks wait an average of **337 s** for the task they depend on.

## 3. Every run starts cold, with no shared context
[claudeCode.js:17](server/models/claudeCode.js#L17) starts a fresh `claude -p --no-session-persistence` process for every plan, task, retry, commit and triage run. Each agent re-explores the repo from scratch: an average task run reads **2.8M cached tokens**, writes 41k output tokens and makes about 28 Bash calls. The reviewer then re-reads everything the implementer just read. In VS Code, one warm session builds up that context once.

## 4. Smaller factors
- Everything runs on Opus 5.5, including commit, digest and triage runs. Those take only about 4–7 s each, so they are minor.
- `maxParallel` is 3 tasks per mission, but plans rarely have more than one task ready at a time, so this barely matters.

## What would help most, in order
1. **Let missions in the same topic run in parallel** when their declared files don't overlap. The file-lease mechanism ([engine.js:42](server/orchestrator/engine.js#L42)) already handles conflicts. Short of that, send independent orders to separate topics.
2. **Make the separate verification task optional** for small changes, so the implementer runs its own tests, or use a cheaper model (Sonnet or Haiku) for qa/reviewer.
3. **Reuse sessions**: run the retry, and possibly the reviewer, with `--resume` on the implementer's session instead of starting cold.

I can implement any of these. Option 1 alone would remove most of the waiting.