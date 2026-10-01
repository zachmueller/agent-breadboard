-- Config proposals ([01] §6.3, [11] §3) ------------------------------------
CREATE TABLE config_proposals (
  proposal_id    char(24) PRIMARY KEY,            -- 'prp_' + uid
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  branch         text NOT NULL UNIQUE,
  base_commit    text NOT NULL,
  head_commit    text NOT NULL,
  message        text NOT NULL,
  status         text NOT NULL DEFAULT 'open',    -- open|merged|discarded
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  session_id     char(24),
  merged_commit  text,
  merged_by      jsonb,
  merged_at      timestamptz,
  discarded_at   timestamptz,
  eval_run_ids   text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX config_proposals_status_idx ON config_proposals (status, created_at DESC);

-- Credential broker ([12] §5) ----------------------------------------------
CREATE TABLE broker_credentials (
  credential_id  char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'bearer',  -- bearer|header|basic|query|aws-sigv4|raw
  ciphertext     bytea NOT NULL,                  -- libsodium secretbox
  nonce          bytea NOT NULL,
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

CREATE TABLE broker_capabilities (
  capability_id  char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  name           text NOT NULL,
  credential_id  char(20) REFERENCES broker_credentials(credential_id),
  description    text NOT NULL DEFAULT '',
  scope          jsonb NOT NULL DEFAULT '{}',     -- {hosts:[pattern], methods:[...], path_prefixes:[...], scopes:[read|write]}
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

CREATE TABLE broker_audit (
  audit_id       bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  tool_uid       char(20),
  session_id     char(24),
  step_id        text,
  actor          jsonb,
  capability     text NOT NULL,
  method         text,
  target_host    text,
  target_path    text,
  response_status integer,
  ok             boolean NOT NULL,
  error          text
);
CREATE INDEX broker_audit_at_idx ON broker_audit (at DESC);

-- Egress proxy audit ([06] §4, [12] §6)
CREATE TABLE egress_audit (
  audit_id       bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  execution_key  text,
  tool_uid       char(20),
  host           text NOT NULL,
  port           integer NOT NULL,
  allowed        boolean NOT NULL
);
