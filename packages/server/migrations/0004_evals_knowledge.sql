-- Evals results store ([04] §4.1) --------------------------------------------
CREATE TABLE eval_runs (
  eval_run_id    char(24) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  circuit_uid    char(20) NOT NULL,
  circuit_commit text NOT NULL,
  rubric_commit  text NOT NULL,
  model_overrides jsonb,
  judge_model_id text NOT NULL,
  fixture_tags   text[],
  proposal_id    char(24),
  status         text NOT NULL DEFAULT 'running', -- running|completed|failed
  summary        jsonb NOT NULL DEFAULT '{}',
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE INDEX eval_runs_circuit_idx ON eval_runs (circuit_uid, created_at DESC);

CREATE TABLE eval_results (
  eval_run_id    char(24) NOT NULL REFERENCES eval_runs(eval_run_id),
  fixture_id     text NOT NULL,
  scored_session char(24) NOT NULL,
  dimension      text NOT NULL,
  dim_type       text NOT NULL,
  value          jsonb NOT NULL,
  rationale      text,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eval_run_id, fixture_id, dimension)
);

-- Knowledge connectors state ([07] §8) --------------------------------------
CREATE TABLE connector_state (
  tool_uid       char(20) PRIMARY KEY,
  cursor         text,
  last_sync_at   timestamptz,
  last_error     text,
  running        boolean NOT NULL DEFAULT false,
  doc_count      integer NOT NULL DEFAULT 0
);

-- Knowledge embeddings ([07] §9) --------------------------------------------
-- @requires pgvector
CREATE TABLE knowledge_chunks (
  uid            char(20) NOT NULL REFERENCES nodes(uid) ON DELETE CASCADE,
  chunk_idx      integer NOT NULL,
  chunk_text     text NOT NULL,
  embedding      vector,
  model_id       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, chunk_idx)
);
