-- Personal access tokens ([12] §3): a member's own long-lived bearer credentials (a local harness such as
-- Claude Code over MCP), optionally limited to read-only scopes. Hashed at rest; expiring; revocable.
CREATE TABLE user_tokens (
  token_id       char(24) PRIMARY KEY,                           -- 'ptk_' + uid
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  user_id        char(20) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name           text NOT NULL,
  token_hash     text NOT NULL UNIQUE,                           -- sha256 of the `bbu_…` secret
  scopes         text[],                                         -- NULL = acts fully as the user
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, created_at DESC);
