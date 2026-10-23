-- Personal token tiers ([12] §3): read-only, editor, and full (unscoped), which only an admin may hold. A member's
-- existing full-access token becomes an editor token; an admin's stays full. The list must equal EDITOR_SCOPES
-- (identity.ts; a test checks it).
UPDATE user_tokens t
   SET scopes = ARRAY['tasks:read', 'nodes:read', 'sessions:read', 'config:read', 'knowledge:read', 'evals:read', 'events:read', 'mcp:call',
                      'tasks:write', 'nodes:write', 'knowledge:write', 'config:propose', 'sessions:write', 'evals:write', 'tools:execute']
  FROM users u
 WHERE t.user_id = u.user_id AND t.scopes IS NULL AND NOT u.is_admin;
