import { describe, it, expect } from 'vitest';
import { migrate } from './migrate.js';
import { connectTestDb } from '../test/harness.js';

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
});
