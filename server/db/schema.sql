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
