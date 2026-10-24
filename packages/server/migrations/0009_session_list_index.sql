-- Paged session lists ([11] §2): newest-first (and oldest-first) listings walk this index
-- for both cursor and offset pages instead of sorting the team's whole history.
CREATE INDEX IF NOT EXISTS sessions_team_created_idx ON sessions (team_id, created_at DESC, session_id DESC);
