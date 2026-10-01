-- Identity ([01] §8) ------------------------------------------------------
CREATE TABLE teams (
  team_id        char(20) PRIMARY KEY,
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id        char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  handle         text NOT NULL,
  display_name   text NOT NULL DEFAULT '',
  oidc_subject   text,
  is_admin       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  UNIQUE (team_id, handle)
);
CREATE INDEX users_oidc_idx ON users (oidc_subject) WHERE oidc_subject IS NOT NULL;

CREATE TABLE roles (
  role_id        char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  slug           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  UNIQUE (team_id, slug)
);

CREATE TABLE role_memberships (
  role_id        char(20) NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  user_id        char(20) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, user_id)
);

-- Service tokens ([11] §2, [12] §3): admin-issued, scoped --------------------
CREATE TABLE service_tokens (
  token_id       char(24) PRIMARY KEY,            -- 'tok_' + uid
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  name           text NOT NULL,
  token_hash     text NOT NULL UNIQUE,            -- sha256 of the bearer secret
  scopes         text[] NOT NULL DEFAULT '{}',
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_used_at   timestamptz
);

-- Content plane ([01] §8) --------------------------------------------------
CREATE TABLE nodes (
  uid            char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  type           text NOT NULL,
  title          text NOT NULL DEFAULT '',
  properties     jsonb NOT NULL DEFAULT '{}',
  body           jsonb,
  body_text      text,
  crdt           boolean NOT NULL DEFAULT false,
  tags           text[] NOT NULL DEFAULT '{}',
  scope          text NOT NULL DEFAULT 'team',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  -- producing session for session-scoped visibility checks (denormalized from the first `produces` edge)
  session_id     char(24)
);
CREATE INDEX nodes_type_idx  ON nodes (type, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX nodes_tags_idx  ON nodes USING gin (tags);
CREATE INDEX nodes_props_idx ON nodes USING gin (properties jsonb_path_ops);
CREATE INDEX nodes_fts_idx   ON nodes USING gin (to_tsvector('english',
  coalesce(title,'') || ' ' || coalesce(properties->>'aliases','') || ' ' || coalesce(body_text,'')));
CREATE INDEX nodes_session_idx ON nodes (session_id) WHERE session_id IS NOT NULL;

-- Sessions ([02] §4) — created before edges/revisions because edges reference sessions.
CREATE TABLE sessions (
  session_id     char(24) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  kind           text NOT NULL,
  circuit_uid    char(20),
  circuit_slug   text,
  config_commit  text,
  task_uid       char(20) REFERENCES nodes(uid),
  parent_session char(24) REFERENCES sessions(session_id),
  parent_step_id text,
  state          text NOT NULL DEFAULT 'queued',
  state_detail   jsonb NOT NULL DEFAULT '{}',
  budget         jsonb NOT NULL,
  priority       text NOT NULL DEFAULT 'p2',
  input          jsonb,
  model_overrides jsonb,
  created_by     jsonb NOT NULL DEFAULT '{"kind":"service","id":"orchestrator"}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  ended_at       timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_state_idx ON sessions (state, priority, created_at);
CREATE INDEX sessions_task_idx ON sessions (task_uid);
CREATE INDEX sessions_parent_idx ON sessions (parent_session);
CREATE INDEX sessions_kind_idx ON sessions (kind, created_at DESC);

CREATE TABLE node_revisions (
  uid            char(20) NOT NULL REFERENCES nodes(uid),
  revision_id    integer  NOT NULL,
  labels         text[]   NOT NULL,
  properties     jsonb    NOT NULL,
  body           jsonb,
  body_text      text,
  ydoc_state     bytea,
  ydoc_vector    bytea,
  content_hash   text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,
  PRIMARY KEY (uid, revision_id)
);

CREATE TABLE yjs_updates (
  uid            char(20) NOT NULL REFERENCES nodes(uid),
  seq            bigserial,
  update         bytea NOT NULL,
  origin         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, seq)
);

CREATE TABLE edges (
  edge_id        bigserial PRIMARY KEY,
  type           text NOT NULL,
  src_uid        char(20) REFERENCES nodes(uid),
  src_session_id char(24) REFERENCES sessions(session_id),
  src_step_id    text,
  dst_uid        char(20) NOT NULL REFERENCES nodes(uid),
  dst_revision   integer,
  properties     jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,
  retracted_at   timestamptz,
  retracted_by   jsonb,
  CHECK (src_uid IS NOT NULL OR src_session_id IS NOT NULL)
);
CREATE INDEX edges_src_idx ON edges (src_uid, type) WHERE retracted_at IS NULL;
CREATE INDEX edges_dst_idx ON edges (dst_uid, type) WHERE retracted_at IS NULL;
CREATE INDEX edges_session_idx ON edges (src_session_id) WHERE retracted_at IS NULL;

-- Idempotency keys ([11] §2) -----------------------------------------------
CREATE TABLE idempotency_keys (
  idem_key       text NOT NULL,
  actor_key      text NOT NULL,
  request_hash   text NOT NULL,
  status         integer NOT NULL,
  response       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idem_key, actor_key)
);
