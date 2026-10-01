import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Locate the migrations dir whether running from src (tsx) or dist. */
export function migrationsDir(): string {
  for (const candidate of [join(here, '..', '..', 'migrations'), join(here, '..', 'migrations'), join(here, 'migrations')]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('migrations directory not found');
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: Db, log?: { info: (o: any, msg?: string) => void }): Promise<MigrationResult> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const f of files) {
    if (done.has(f)) {
      result.skipped.push(f);
      continue;
    }
    let sql = readFileSync(join(dir, f), 'utf8');
    // Optional feature-gated blocks: -- @requires pgvector
    if (/^--\s*@requires\s+pgvector/m.test(sql) && !db.features.pgvector) {
      sql = sql.replace(/vector/gi, 'real[]');
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
    });
    result.applied.push(f);
    log?.info({ migration: f }, 'applied migration');
  }
  return result;
}
