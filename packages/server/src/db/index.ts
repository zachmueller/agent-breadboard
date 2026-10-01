/**
 * Database seam ([01] §2, [12] §1): the server reaches Postgres only through connection config.
 *  - `postgres://…` / `postgresql://…`  → node-postgres pool (RDS/managed/self-hosted), with TLS + IAM-auth options
 *  - `pglite://<dir>` | `pglite://memory` → embedded in-process Postgres (dev/quickstart/tests)
 * Both speak the same SQL; the DAL never branches on the backend except via `features`.
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Execute a multi-statement SQL script (no parameters). Used by migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  readonly features: { pgvector: boolean };
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  url: string;
  ssl?: 'disable' | 'prefer' | 'require' | 'verify-full';
  sslCaFile?: string;
  iamAuth?: boolean;
  awsRegion?: string;
  poolSize?: number;
}

export async function connectDb(opts: DbOptions): Promise<Db> {
  if (opts.url.startsWith('pglite://')) {
    const { PgliteDb } = await import('./pglite.js');
    return PgliteDb.open(opts.url.slice('pglite://'.length));
  }
  if (/^postgres(ql)?:\/\//.test(opts.url)) {
    const { PgDb } = await import('./pg.js');
    return PgDb.open(opts);
  }
  throw new Error(`unsupported DATABASE_URL scheme: ${opts.url.split(':')[0]}`);
}

/** Normalize driver-specific row values: BigInt → number, Uint8Array → Buffer. */
export function normalizeRow<T extends Record<string, any>>(row: T): T {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') (row as any)[k] = Number(v);
    else if (v instanceof Uint8Array && !Buffer.isBuffer(v)) (row as any)[k] = Buffer.from(v);
  }
  return row;
}

/** Helper for `IN (...)` lists. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}
