import { z } from 'zod';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const zEnv = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().default('pglite://./var/db'),
  DATABASE_SSL: z.enum(['disable', 'prefer', 'require', 'verify-full']).optional(),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  DATABASE_IAM_AUTH: bool.default(false),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: bool.default(true),
  CONFIG_REPO_DIR: z.string().default('./var/config-repo'),
  CONFIG_WORKTREE_CACHE_DIR: z.string().default('./var/config-trees'),
  CONFIG_SEED_DIR: z.string().default('./config-seed'),
  OBJECT_STORE: z.enum(['fs', 's3']).default('fs'),
  OBJECT_STORE_DIR: z.string().default('./var/objects'),
  OBJECT_STORE_S3_BUCKET: z.string().optional(),
  OBJECT_STORE_S3_PREFIX: z.string().default('breadboard/'),
  OBJECT_STORE_THRESHOLD_BYTES: z.coerce.number().int().positive().default(256 * 1024),
  MODEL_PROVIDER: z.enum(['bedrock', 'mock']).default('mock'),
  AWS_REGION: z.string().default('us-east-1'),
  BEDROCK_ENDPOINT: z.string().optional(),
  SANDBOX_RUNNER: z.enum(['docker', 'process']).default('process'),
  SANDBOX_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  SANDBOX_OCI_RUNTIME: z.string().optional(),
  SANDBOX_WARM_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),
  SANDBOX_EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(4100),
  SANDBOX_EGRESS_PROXY_HOST: z.string().optional(),
  /** Base URL tool code uses to call back into the API (through the egress proxy in docker mode). Defaults to PUBLIC_URL. */
  SANDBOX_API_URL: z.string().optional(),
  BROKER_MASTER_KEY: z.string().optional(),
  TOKEN_SIGNING_KEY: z.string().default('dev-only-change-me'),
  /** Break-glass admin sign-in for a fresh deployment (production refuses the seed's `*-change-me` tokens). */
  BREADBOARD_BOOTSTRAP_ADMIN_TOKEN: z.string().optional(),
  UI_DIST_DIR: z.string().optional(),
  ORCHESTRATOR_ENABLED: bool.default(true),
  CONNECTORS_ENABLED: bool.default(true),
  PYTHON_BIN: z.string().default('python3'),
});
export type Env = z.infer<typeof zEnv>;

/**
 * The deployment root: `BREADBOARD_ROOT`, else the nearest ancestor of cwd holding a workspace `package.json`
 * (the monorepo root in dev, `/app` in the container), else cwd. Relative env paths and `.env` resolve here.
 */
export function findRepoRoot(from = process.cwd()): string {
  if (process.env.BREADBOARD_ROOT) return resolve(process.env.BREADBOARD_ROOT);
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {}
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

/** Load env from process.env, layering a `.env` file from the repo root if present (without overriding real env vars). */
export function loadEnv(overrides: Partial<Record<keyof Env, string | boolean | number>> = {}, root = findRepoRoot()): Env {
  const fileVars: Record<string, string> = {};
  const envPath = resolve(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2]!;
      const quoted = /^(["']).*\1$/.test(v);
      if (quoted) v = v.slice(1, -1);
      else v = v.replace(/(^|\s+)#.*$/, '').trim(); // strip inline comments, including after an empty value
      fileVars[m[1]!] = v;
    }
  }
  const merged: Record<string, unknown> = { ...fileVars, ...process.env, ...overrides };
  for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === '') delete merged[k];
  return zEnv.parse(merged);
}

/** Resolve a path env var against a root directory (the repo root by default). */
export function resolvePath(p: string, root = process.cwd()): string {
  return resolve(root, p);
}
