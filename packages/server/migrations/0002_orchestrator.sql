-- Orchestrator ([02] §4) ---------------------------------------------------
CREATE TABLE session_events (
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  seq            bigint  NOT NULL,
  event_type     text    NOT NULL,
  step_id        text,
  payload        jsonb   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX session_events_type_idx ON session_events (session_id, event_type);

CREATE TABLE step_checkpoints (
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  step_id        text     NOT NULL,
  attempt        integer  NOT NULL,
  status         text     NOT NULL,
  exit_name      text,
  output         jsonb,
  ambient        jsonb    NOT NULL,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  tokens_in      bigint NOT NULL DEFAULT 0,
  tokens_out     bigint NOT NULL DEFAULT 0,
  visit          integer NOT NULL DEFAULT 1,
  kind           text,
  child_session_id char(24),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  PRIMARY KEY (session_id, step_id, attempt)
);

CREATE TABLE session_turns (
  turn_id        char(24) PRIMARY KEY,
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  step_id        text NOT NULL,
  attempt        integer NOT NULL DEFAULT 1,
  role           text NOT NULL,
  username       text,
  content        jsonb NOT NULL,
  model_id       text,
  tokens_in      bigint, tokens_out bigint,
  cost_usd       numeric(12,6),
  latency_ms     integer,
  fallback_from  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX turns_session_idx ON session_turns (session_id, step_id, created_at);
CREATE INDEX turns_cost_window_idx ON session_turns (created_at) WHERE cost_usd IS NOT NULL;

-- Tool execution journal ([06] §4.4) ----------------------------------------
CREATE TABLE tool_executions (
  execution_key  text PRIMARY KEY,                -- session_id + step_id + attempt + call-index
  session_id     char(24) REFERENCES sessions(session_id),
  step_id        text,
  attempt        integer,
  call_index     integer,
  tool_uid       char(20) NOT NULL,
  tool_commit    text,
  input_hash     text NOT NULL,
  status         text NOT NULL,                   -- running|completed|failed
  output         jsonb,
  output_ref     text,
  error          text,
  cost_units     numeric(12,4) NOT NULL DEFAULT 0,
  log_ref        text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE INDEX tool_executions_session_idx ON tool_executions (session_id, step_id);

-- Event outbox ([11] §5): at-least-once delivery for SSE replay + webhooks ---
CREATE TABLE event_outbox (
  event_id       char(24) PRIMARY KEY,
  topic          text NOT NULL,
  payload        jsonb NOT NULL,
  visibility     jsonb NOT NULL DEFAULT '{"scope":"team"}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_outbox_created_idx ON event_outbox (created_at);

CREATE TABLE webhook_deliveries (
  delivery_id    bigserial PRIMARY KEY,
  url            text NOT NULL,
  event_id       char(24) NOT NULL,
  topic          text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',  -- pending|delivered|failed
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz
);
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
