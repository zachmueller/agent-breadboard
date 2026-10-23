import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, migrationsDir } from './migrate.js';
import { connectTestDb } from '../test/harness.js';
import { EDITOR_SCOPES } from '../identity/identity.js';

describe('migrations (PGlite, or Postgres with TEST_DATABASE_URL)', () => {
  it('applies all migrations and is idempotent', async () => {
    const db = await connectTestDb();
    const r1 = await migrate(db);
    expect(r1.applied.length).toBeGreaterThanOrEqual(4);
    const r2 = await migrate(db);
    expect(r2.applied).toEqual([]);
    const tables = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
    const names = tables.rows.map((r) => r.table_name);
    for (const t of ['teams', 'users', 'nodes', 'node_revisions', 'yjs_updates', 'edges', 'sessions', 'session_events', 'step_checkpoints', 'session_turns', 'eval_runs', 'eval_results', 'tool_executions', 'config_proposals', 'broker_capabilities', 'knowledge_chunks'])
      expect(names).toContain(t);
    // FTS + recursive CTE + jsonb all work
    await db.query(`INSERT INTO teams (team_id, name) VALUES ('T0000000000000000000', 'team')`);
    await db.query(`INSERT INTO nodes (uid, team_id, type, title, created_by, body_text, tags) VALUES ('N0000000000000000000','T0000000000000000000','knowledge','Latency analysis','{"kind":"service","id":"t"}','the quick brown fox','{a,b}')`);
    const fts = await db.query(`SELECT uid FROM nodes WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body_text,'')) @@ plainto_tsquery('english', 'fox latency')`);
    expect(fts.rows).toHaveLength(1);
    const tags = await db.query<{ tags: string[] }>(`SELECT tags FROM nodes WHERE tags @> '{a}'`);
    expect(tags.rows[0]!.tags).toEqual(['a', 'b']);
    expect(db.features.pgvector).toBe(true);
    const col = await db.query<{ udt_name: string }>(`SELECT udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'`);
    expect(col.rows[0]!.udt_name).toBe('vector');
    await db.query(`INSERT INTO knowledge_chunks (uid, chunk_idx, chunk_text, embedding) VALUES ('N0000000000000000000', 0, 'x', '[1,0,0]')`);
    const sim = await db.query<{ d: number }>(`SELECT embedding <=> '[1,0,0]' AS d FROM knowledge_chunks`);
    expect(sim.rows[0]!.d).toBeCloseTo(0);
    await db.close();
  });

  it('upgrades a real[] embedding column to vector once pgvector is available', async () => {
    const db = await connectTestDb();
    db.features.pgvector = false; // as migrated by a server that could not see the extension
    await migrate(db);
    const udt = async () => (await db.query<{ udt_name: string }>(`SELECT udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'`)).rows[0]!.udt_name;
    expect(await udt()).toBe('_float4');
    await db.query(`INSERT INTO teams (team_id, name) VALUES ('T0000000000000000000', 'team')`);
    await db.query(`INSERT INTO nodes (uid, team_id, type, title, created_by) VALUES ('N0000000000000000000','T0000000000000000000','knowledge','n','{"kind":"service","id":"t"}')`);
    await db.query(`INSERT INTO knowledge_chunks (uid, chunk_idx, chunk_text, embedding) VALUES ('N0000000000000000000', 0, 'x', '{0.6,0.8}'::real[])`);
    db.features.pgvector = true;
    expect((await migrate(db)).applied).toEqual([]);
    expect(await udt()).toBe('vector');
    const sim = await db.query<{ d: number }>(`SELECT embedding <=> '[0.6,0.8]'::vector AS d FROM knowledge_chunks`);
    expect(sim.rows[0]!.d).toBeCloseTo(0);
    await db.close();
  });

  it("0008 turns members' full-access personal tokens into editor tokens and leaves admins' full", async () => {
    const db = await connectTestDb();
    await migrate(db);
    await db.query(`INSERT INTO teams (team_id, name) VALUES ('T0000000000000000000', 'team')`);
    await db.query(`INSERT INTO users (user_id, team_id, handle, display_name, is_admin) VALUES ('UADMIN00000000000000','T0000000000000000000','boss','Boss',true), ('UMEMBER0000000000000','T0000000000000000000','pat','Pat',false)`);
    const token = (id: string, user: string, scopes: string[] | null) =>
      db.query(`INSERT INTO user_tokens (token_id, team_id, user_id, name, token_hash, scopes, expires_at) VALUES ($1,'T0000000000000000000',$2,$3,$4,$5, now() + interval '1 day')`, [id, user, id, `hash-${id}`, scopes]);
    await token('ptk_admin_full', 'UADMIN00000000000000', null);
    await token('ptk_member_full', 'UMEMBER0000000000000', null);
    await token('ptk_member_ro', 'UMEMBER0000000000000', ['nodes:read', 'mcp:call']);
    // Already applied to the empty table above; replay its statement over the tokens that existed before it.
    await db.query(readFileSync(join(migrationsDir(), '0008_personal_token_tiers.sql'), 'utf8'));
    const rows = (await db.query<{ token_id: string; scopes: string[] | null }>(`SELECT token_id, scopes FROM user_tokens ORDER BY token_id`)).rows;
    expect(Object.fromEntries(rows.map((r) => [r.token_id.trim(), r.scopes]))).toEqual({ ptk_admin_full: null, ptk_member_full: [...EDITOR_SCOPES], ptk_member_ro: ['nodes:read', 'mcp:call'] });
    await db.close();
  });
});
