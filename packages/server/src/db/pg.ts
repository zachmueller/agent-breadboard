import pg from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';
import { readFileSync } from 'node:fs';
import type { Db, DbOptions, Queryable, QueryResult } from './index.js';
import { normalizeRow } from './index.js';

pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

/**
 * The pool config for a `postgres://` URL, as discrete fields. Never `connectionString`: pg parses that over the
 * config, and for a URL without a password the parsed `password: ''` replaces an IAM token function.
 * SSL parameters in the URL still win over `DATABASE_SSL`, as they did when pg parsed the URL itself.
 */
export function poolConfig(opts: DbOptions, getAuthToken?: () => Promise<string>): pg.PoolConfig {
  const url = new URL(opts.url);
  const sslMode = opts.ssl ?? (url.searchParams.get('sslmode') as DbOptions['ssl'] | null) ?? 'prefer';
  let ssl: pg.PoolConfig['ssl'] = undefined;
  if (sslMode === 'require') ssl = { rejectUnauthorized: false };
  else if (sslMode === 'verify-full') ssl = { rejectUnauthorized: true, ca: opts.sslCaFile ? readFileSync(opts.sslCaFile, 'utf8') : undefined };
  else if (sslMode === 'prefer') ssl = undefined;
  const config: pg.PoolConfig = { max: opts.poolSize ?? 10, ssl, ...parseIntoClientConfig(opts.url) };
  if (getAuthToken) {
    config.password = getAuthToken;
    if (!config.ssl) config.ssl = { rejectUnauthorized: false }; // RDS accepts IAM tokens over TLS only
  }
  return config;
}

export class PgDb implements Db {
  readonly kind = 'pg' as const;
  features = { pgvector: false };
  private constructor(private pool: pg.Pool) {}

  static async open(opts: DbOptions): Promise<PgDb> {
    const url = new URL(opts.url);
    const user = decodeURIComponent(url.username);
    let getAuthToken: (() => Promise<string>) | undefined;
    if (opts.iamAuth) {
      // RDS IAM authentication: mint a short-lived token from the AWS credential chain per connection.
      const { Signer } = await import('@aws-sdk/rds-signer');
      const signer = new Signer({
        hostname: url.hostname,
        port: Number(url.port || 5432),
        username: user,
        region: opts.awsRegion ?? process.env.AWS_REGION ?? 'us-east-1',
      });
      getAuthToken = () => signer.getAuthToken();
    }
    const pool = new pg.Pool(poolConfig(opts, getAuthToken));
    const db = new PgDb(pool);
    // Probe once so misconfiguration fails fast.
    try {
      await db.query('select 1');
    } catch (e) {
      await pool.end().catch(() => {});
      // 28P01 invalid_password, 28000 invalid_authorization_specification: what RDS answers a refused IAM token.
      const code = (e as { code?: string }).code;
      if (opts.iamAuth && (code === '28P01' || code === '28000')) {
        throw new Error(`RDS IAM authentication failed for database user ${user}: the server's AWS role needs rds-db:connect for that user, and the user needs GRANT rds_iam (${(e as Error).message})`, { cause: e });
      }
      throw e;
    }
    db.features.pgvector = await db.ensureVector();
    return db;
  }

  /**
   * pgvector when the server has it: already installed, or creatable by this role (on RDS, the master user).
   * Without it, migrations store embeddings as real[] and semantic search ranks in process.
   */
  private async ensureVector(): Promise<boolean> {
    try {
      await this.query('CREATE EXTENSION IF NOT EXISTS vector');
      return true;
    } catch {
      return (await this.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rows.length > 0;
    }
  }

  async query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as any[]);
    return { rows: r.rows.map(normalizeRow) as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Queryable = {
        async query(sql, params) {
          const r = await client.query(sql, params as any[]);
          return { rows: r.rows.map(normalizeRow), rowCount: r.rowCount ?? r.rows.length };
        },
        async exec(sql) {
          await client.query(sql);
        },
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
