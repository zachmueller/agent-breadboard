import { PGlite, types } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { mkdirSync } from 'node:fs';
import type { Db, Queryable, QueryResult } from './index.js';
import { normalizeRow } from './index.js';

/** Embedded Postgres (WASM) for dev/quickstart/tests. Single-connection; transactions serialize. */
export class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  features = { pgvector: true };
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private pg: PGlite) {}

  static async open(target: string): Promise<PgliteDb> {
    const parsers = {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
    };
    let pg: PGlite;
    if (target === 'memory' || target === '' || target === ':memory:') {
      pg = await PGlite.create({ extensions: { vector }, parsers });
    } else {
      mkdirSync(target, { recursive: true });
      pg = await PGlite.create({ dataDir: target, extensions: { vector }, parsers });
    }
    const db = new PgliteDb(pg);
    try {
      await pg.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      db.features.pgvector = false;
    }
    return db;
  }

  /** Serialize all access: PGlite is single-connection and a transaction must not interleave with other queries. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.serialized(async () => {
      const r = await this.pg.query<T>(sql, params as any[]);
      return { rows: (r.rows as any[]).map(normalizeRow) as T[], rowCount: r.affectedRows ?? r.rows.length };
    });
  }

  exec(sql: string): Promise<void> {
    return this.serialized(async () => {
      await this.pg.exec(sql);
    });
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.serialized(() =>
      this.pg.transaction(async (t) => {
        const tx: Queryable = {
          async query(sql, params) {
            const r = await t.query(sql, params as any[]);
            return { rows: (r.rows as any[]).map(normalizeRow), rowCount: r.affectedRows ?? r.rows.length };
          },
          async exec(sql) {
            await t.exec(sql);
          },
        };
        return fn(tx);
      }),
    );
  }

  async close() {
    await this.pg.close();
  }
}
