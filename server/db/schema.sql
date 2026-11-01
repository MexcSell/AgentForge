-- AgentForge schema. Idempotent: executed on every boot.

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  provider    text NOT NULL,              -- claude-code | anthropic | openai | simulator
  model       text,
  base_url    text,
  api_key     text,
  is_default  boolean NOT NULL DEFAULT false,
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL DEFAULT '{}',
  limits      jsonb NOT NULL DEFAULT '{}',
  rate_limit  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  role            text NOT NULL,
  title           text NOT NULL,
  tier            int  NOT NULL DEFAULT 3,
  department      text,
  skills          jsonb NOT NULL DEFAULT '[]',
  supervisor_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  model_id        text REFERENCES models(id) ON DELETE SET NULL,
  mission         text,
  purpose         text,
  playbook        jsonb NOT NULL DEFAULT '[]',
  prompt_version  int  NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'idle',
  current_task_id uuid,
  xp              int  NOT NULL DEFAULT 0,
  level           int  NOT NULL DEFAULT 1,
  stats           jsonb NOT NULL DEFAULT '{}',
  origin          text NOT NULL DEFAULT 'seed',
  cloned_from     uuid,
  archived        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Clone lifecycle: clone_base is a clone's starting point ({ xp, skills } when it was copied), so a merge adds back
-- only what it learned since; merged_into is the agent a merged clone was folded into.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS clone_base  jsonb,
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES agents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  path            text NOT NULL,
  github_url      text,
  description     text,
  protected       boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'idle',
  manager_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  auto_sync       boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Run & preview settings; NULL means auto-detect (package.json dev/start, index.html) and a free port.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS run_command  text,
  ADD COLUMN IF NOT EXISTS preview_port int,
  ADD COLUMN IF NOT EXISTS preview_path text;

CREATE TABLE IF NOT EXISTS missions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  command      text NOT NULL,
  status       text NOT NULL DEFAULT 'planning',
  plan         jsonb,
  summary      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- A clone made for one mission (engine staffing): merged back into its original when that mission ends. NULL for
-- originals, manual clones and clones made before leases existed.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lease_mission_id uuid REFERENCES missions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id   uuid REFERENCES missions(id) ON DELETE CASCADE,
  parent_key   text,
  key          text NOT NULL,
  title        text NOT NULL,
  description  text,
  role         text NOT NULL,
  skills       jsonb NOT NULL DEFAULT '[]',
  acceptance   jsonb NOT NULL DEFAULT '[]',
  depends_on   jsonb NOT NULL DEFAULT '[]',
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending',
  origin       text NOT NULL DEFAULT 'plan',
  progress     int  NOT NULL DEFAULT 0,
  result       text,
  report       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid REFERENCES tasks(id) ON DELETE SET NULL,
  mission_id     uuid REFERENCES missions(id) ON DELETE SET NULL,
  agent_id       uuid REFERENCES agents(id) ON DELETE SET NULL,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  model_id       text,
  kind           text NOT NULL DEFAULT 'task',
  status         text NOT NULL DEFAULT 'running',
  output         text,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cache_tokens   bigint NOT NULL DEFAULT 0,
  cost_usd       numeric NOT NULL DEFAULT 0,
  tool_calls     jsonb NOT NULL DEFAULT '{}',
  duration_ms    int,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
-- Usage history outlives deleted projects (migration for databases created before this rule).
DO $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['task_id:tasks', 'mission_id:missions'] LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_' || split_part(c, ':', 1) || '_fkey' AND confdeltype = 'c') THEN
      EXECUTE format('ALTER TABLE runs DROP CONSTRAINT runs_%s_fkey', split_part(c, ':', 1));
      EXECUTE format('ALTER TABLE runs ADD CONSTRAINT runs_%1$s_fkey FOREIGN KEY (%1$s) REFERENCES %2$s(id) ON DELETE SET NULL', split_part(c, ':', 1), split_part(c, ':', 2));
    END IF;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS runs_model_time_idx ON runs(model_id, created_at);
CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id, created_at DESC);
-- Claude Code session of a task run, and its last prompt size: the agent's next task in the topic resumes it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS context_tokens integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(agent_id, finished_at DESC) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_events (
  id       bigserial PRIMARY KEY,
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  type     text NOT NULL,
  data     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id   uuid REFERENCES missions(id) ON DELETE SET NULL,
  author_type  text NOT NULL,              -- user | agent | system
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  kind         text NOT NULL DEFAULT 'chat',
  content      text NOT NULL DEFAULT '',
  attachments  jsonb NOT NULL DEFAULT '[]',
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id, created_at);

-- A project's chat is split into topic threads.
CREATE TABLE IF NOT EXISTS topics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             text NOT NULL DEFAULT 'New topic',
  tags              jsonb NOT NULL DEFAULT '[]',
  title_locked      boolean NOT NULL DEFAULT false,   -- true once a human (or the backfill) named it
  archived          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topics_project_idx ON topics(project_id, last_activity_at DESC);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id) ON DELETE CASCADE;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_topic_idx ON messages(topic_id, created_at);
CREATE INDEX IF NOT EXISTS missions_topic_idx ON missions(topic_id);
-- Backfill: history without a topic goes to one locked 'General' topic per project (reused, never duplicated).
-- Missions left without a topic by a topic delete stay unassigned once the project already has topics.
DO $$
DECLARE r record; tid uuid; created boolean; newest timestamptz;
BEGIN
  FOR r IN
    SELECT p.id FROM projects p
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.project_id = p.id AND m.topic_id IS NULL)
       OR (EXISTS (SELECT 1 FROM missions s WHERE s.project_id = p.id AND s.topic_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.project_id = p.id))
  LOOP
    SELECT id INTO tid FROM topics WHERE project_id = r.id AND title = 'General' AND title_locked ORDER BY created_at LIMIT 1;
    created := tid IS NULL;
    IF created THEN
      INSERT INTO topics(project_id, title, tags, title_locked) VALUES (r.id, 'General', '["history"]', true) RETURNING id INTO tid;
    END IF;
    UPDATE messages SET topic_id = tid WHERE project_id = r.id AND topic_id IS NULL;
    UPDATE missions SET topic_id = tid WHERE project_id = r.id AND topic_id IS NULL;
    SELECT max(created_at) INTO newest FROM messages WHERE topic_id = tid;
    IF newest IS NOT NULL THEN
      UPDATE topics SET last_activity_at = CASE WHEN created THEN newest ELSE greatest(last_activity_at, newest) END WHERE id = tid;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text NOT NULL DEFAULT 'system',   -- admin | manager | agent | system
  source_name  text,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
  level        text NOT NULL DEFAULT 'info',
  title        text NOT NULL,
  body         text,
  read         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'lesson',
  content     text NOT NULL,
  score       real NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id          bigserial PRIMARY KEY,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version     int NOT NULL,
  playbook    jsonb NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evolution_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage       text NOT NULL,      -- observe | diagnose | generate | experiment | evaluate | promote
  agent_id    uuid REFERENCES agents(id) ON DELETE CASCADE,
  title       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id          bigserial PRIMARY KEY,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  status      text NOT NULL,
  commit      text,
  message     text,
  output      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One-time (marked by its audit_logs row): the executive becomes 'AgentForge Agent' unless a human renamed it or the
-- name is taken, and every live GM of an unprotected project reports to it. seed.js makes it the AgentForge project's GM.
DO $$
DECLARE exec uuid; renamed int; gms int;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'migrate.executive-gm') THEN RETURN; END IF;
  SELECT id INTO exec FROM agents WHERE role = 'executive' AND NOT archived ORDER BY created_at, id LIMIT 1;
  IF exec IS NULL THEN RETURN; END IF; -- empty database: seed.js creates the organization this way already
  UPDATE agents SET name = 'AgentForge Agent', updated_at = now()
  WHERE id = exec AND name = 'Atlas' AND NOT EXISTS (SELECT 1 FROM agents WHERE name = 'AgentForge Agent');
  GET DIAGNOSTICS renamed = ROW_COUNT;
  UPDATE agents a SET supervisor_id = exec, updated_at = now() FROM projects p
  WHERE p.manager_id = a.id AND NOT p.protected AND NOT a.archived AND a.id <> exec AND a.supervisor_id IS DISTINCT FROM exec;
  GET DIAGNOSTICS gms = ROW_COUNT;
  INSERT INTO audit_logs(actor, action, target, detail)
  VALUES ('system', 'migrate.executive-gm', (SELECT name FROM agents WHERE id = exec), jsonb_build_object('executive', exec, 'renamed', renamed > 0, 'gms', gms));
END $$;

-- Topic titles hold key words; the summary says what the topic covers so far (kept current by the GM's plans).
ALTER TABLE topics ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';
-- One-time (marked by its audit_logs row): unlocked titles of more than 3 words become at most 3 key words (28 chars,
-- same stopwords as heuristics.js topicTitle); the full old title moves into an empty summary.
DO $$
DECLARE r record; w text; core text; keys text[]; words text[]; picked text[]; kw text; n int := 0;
  stop text[] := string_to_array('a an the and or but nor so of to in on at by for from with without into onto over under about as is are was were be been being am do does did has have had it its this that these those there here what which who whom whose when where why how i me my we our you your he she they them their please can could should would will shall may might must just also only very too then than not no all any some more most each every make let lets get show add use new now up out off via vs', ' ');
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'migrate.topic-keywords') THEN RETURN; END IF;
  FOR r IN SELECT id, title FROM topics WHERE NOT title_locked AND array_length(regexp_split_to_array(btrim(title), '\s+'), 1) > 3 LOOP
    keys := '{}'; words := '{}';
    FOREACH w IN ARRAY regexp_split_to_array(btrim(r.title), '\s+') LOOP
      core := regexp_replace(w, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g');
      CONTINUE WHEN core = '';
      words := words || core;
      IF NOT lower(core) = ANY(stop) THEN keys := keys || core; END IF;
    END LOOP;
    picked := (CASE WHEN cardinality(keys) > 0 THEN keys ELSE words END)[1:3];
    WHILE cardinality(picked) > 1 AND length(array_to_string(picked, ' ')) > 28 LOOP
      picked := picked[1:cardinality(picked) - 1];
    END LOOP;
    kw := btrim(left(array_to_string(picked, ' '), 28));
    CONTINUE WHEN kw = '';
    UPDATE topics SET title = kw, summary = CASE WHEN summary = '' THEN r.title ELSE summary END, updated_at = now() WHERE id = r.id;
    n := n + 1;
  END LOOP;
  INSERT INTO audit_logs(actor, action, target, detail) VALUES ('system', 'migrate.topic-keywords', 'topics', jsonb_build_object('shortened', n));
END $$;

-- Project membership: the agents added to a project (by a human, or automatically when the GM staffs them) and whether
-- they are still on it. The GM is always a member and can't be released. A merged agent's rows move to the agent it was
-- merged into (absorb() in services/agents.js); a retired (archived, unmerged) agent's rows stay and are ignored.
CREATE TABLE IF NOT EXISTS project_members (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  added_by     text NOT NULL DEFAULT 'user' CHECK (added_by IN ('user', 'auto')),
  added_at     timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  PRIMARY KEY (project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS project_members_agent_idx ON project_members(agent_id);
-- One-time (marked by its audit_logs row): every agent that had a task in a project, and its GM, become active members.
DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'migrate.project-members') THEN RETURN; END IF;
  INSERT INTO project_members(project_id, agent_id, status, added_by)
  SELECT DISTINCT x.project_id, x.agent_id, 'active', 'auto' FROM (
    SELECT t.project_id, t.agent_id FROM tasks t WHERE t.agent_id IS NOT NULL
    UNION SELECT p.id, p.manager_id FROM projects p WHERE p.manager_id IS NOT NULL
  ) x
  ON CONFLICT (project_id, agent_id) DO UPDATE SET status = 'active', released_at = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_logs(actor, action, target, detail) VALUES ('system', 'migrate.project-members', 'project_members', jsonb_build_object('members', n));
END $$;
