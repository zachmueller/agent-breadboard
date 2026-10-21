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
  /** Repository mirrors ([06] §7.1): bare clones the server keeps for `search_repo` / `read_repo_file`. A cache: no backup needed. */
  MIRROR_DIR: z.string().default('./var/mirrors'),
  /** Let mirrors fetch `file://` and loopback `http://` remotes (tests and local development only). */
  MIRROR_ALLOW_FILE_URLS: bool.default(false),
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
  /**
   * Trusted proxy ([12] §3): an authenticating proxy in front of the server that sends no identity (for example a
   * CDN with a signed-cookie gate). Requests carrying BREADBOARD_TRUSTED_PROXY_HEADER with this secret sign in as
   * BREADBOARD_TRUSTED_PROXY_USER. Set both or neither; only the proxy may know the secret.
   */
  BREADBOARD_TRUSTED_PROXY_SECRET: z.string().optional(),
  BREADBOARD_TRUSTED_PROXY_USER: z.string().optional(),
  BREADBOARD_TRUSTED_PROXY_HEADER: z.string().default('x-breadboard-proxy-auth'),
  /**
   * Load-balancer identity ([12] §3): an AWS Application Load Balancer that signs users in with OIDC and forwards their
   * claims as a signed `x-amzn-oidc-data` JWT. Set to that load balancer's ARN; every request's header is verified
   * against it and signs in as the token's subject. Optionally pin the IdP's issuer and the OIDC client id as well.
   */
  BREADBOARD_ALB_AUTH_ARN: z.string().optional(),
  BREADBOARD_ALB_AUTH_ISSUER: z.string().optional(),
  BREADBOARD_ALB_AUTH_CLIENT_ID: z.string().optional(),
  /**
   * Comma-separated handles of existing users without an OIDC subject (e.g. the trusted-proxy user) that the first
   * OIDC or load-balancer sign-in with the same handle becomes, instead of a new suffixed user.
   */
  BREADBOARD_OIDC_ADOPT_HANDLES: z.string().optional(),
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

/** Values shipped in the seed, `.env.example`, and env defaults (`dev-only-change-me`): public, so never secret. */
export const WELL_KNOWN_SECRET = /-change-me$/;
const MIN_SIGNING_KEY_LENGTH = 32;

/**
 * Secrets production (`NODE_ENV=production`, as in the shipped image) must not run without: a signing key anyone
 * could read from this repo would let them forge admin sessions, and a missing broker key would encrypt credentials
 * with a key derived from the signing key. Returns one message per problem; empty outside production.
 */
export function productionSecretProblems(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  const signing = env.TOKEN_SIGNING_KEY;
  if (WELL_KNOWN_SECRET.test(signing)) problems.push('TOKEN_SIGNING_KEY is unset or a well-known *-change-me value; set a random key (openssl rand -hex 32)');
  else if (signing.length < MIN_SIGNING_KEY_LENGTH) problems.push(`TOKEN_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters (openssl rand -hex 32)`);
  if (!env.BROKER_MASTER_KEY) problems.push('BROKER_MASTER_KEY is unset; set a 32-byte base64 key (openssl rand -base64 32)');
  if (env.BREADBOARD_BOOTSTRAP_ADMIN_TOKEN && WELL_KNOWN_SECRET.test(env.BREADBOARD_BOOTSTRAP_ADMIN_TOKEN)) {
    problems.push('BREADBOARD_BOOTSTRAP_ADMIN_TOKEN is a well-known *-change-me value; set a random token (openssl rand -hex 24)');
  }
  return problems;
}

export const MIN_PROXY_SECRET_LENGTH = 32;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Headers a client or an ordinary proxy sets for other reasons: trusting a secret in one of them would be confusing. */
const RESERVED_HEADERS = new Set(['authorization', 'cookie', 'host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded']);

export interface TrustedProxyConfig {
  /** Lower-case header name. */
  header: string;
  secret: string;
  /** Handle of the user every proxied request signs in as. */
  user: string;
}

/** Trusted-proxy misconfigurations, refused in every environment: half-configured or weak trust is worse than none. */
export function trustedProxyProblems(env: Env): string[] {
  const secret = env.BREADBOARD_TRUSTED_PROXY_SECRET || undefined;
  const user = env.BREADBOARD_TRUSTED_PROXY_USER?.trim() || undefined;
  if (!secret && !user) return [];
  const problems: string[] = [];
  if (!secret) problems.push('BREADBOARD_TRUSTED_PROXY_USER is set without BREADBOARD_TRUSTED_PROXY_SECRET');
  if (!user) problems.push('BREADBOARD_TRUSTED_PROXY_SECRET is set without BREADBOARD_TRUSTED_PROXY_USER');
  if (secret && (WELL_KNOWN_SECRET.test(secret) || secret.length < MIN_PROXY_SECRET_LENGTH)) {
    problems.push(`BREADBOARD_TRUSTED_PROXY_SECRET must be at least ${MIN_PROXY_SECRET_LENGTH} random characters (openssl rand -hex 32)`);
  }
  const header = env.BREADBOARD_TRUSTED_PROXY_HEADER.trim().toLowerCase();
  if (!HEADER_NAME.test(header) || RESERVED_HEADERS.has(header)) problems.push(`BREADBOARD_TRUSTED_PROXY_HEADER must be a dedicated header name, got ${env.BREADBOARD_TRUSTED_PROXY_HEADER}`);
  return problems;
}

export function trustedProxyConfig(env: Env): TrustedProxyConfig | null {
  const problems = trustedProxyProblems(env);
  if (problems.length) throw new Error(`invalid trusted-proxy configuration:\n  - ${problems.join('\n  - ')}`);
  if (!env.BREADBOARD_TRUSTED_PROXY_SECRET) return null;
  return { header: env.BREADBOARD_TRUSTED_PROXY_HEADER.trim().toLowerCase(), secret: env.BREADBOARD_TRUSTED_PROXY_SECRET, user: env.BREADBOARD_TRUSTED_PROXY_USER!.trim() };
}

/** `arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>`: Application Load Balancers only. */
const ALB_ARN = /^arn:aws:elasticloadbalancing:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:loadbalancer\/app\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?\/[0-9a-f]{16}$/;
const OIDC_CLIENT_ID = /^[A-Za-z0-9._~:@-]{1,255}$/;

export interface AlbAuthConfig {
  /** The load balancer's ARN: the `signer` every accepted token must name. */
  signerArn: string;
  /** Where the load balancer publishes the public key for a token's `kid`. */
  keyUrl(kid: string): string;
  /** When set, the token's `iss` must equal it. */
  issuer: string | null;
  /** When set, the token's `client` must equal it. */
  clientId: string | null;
}

/** Load-balancer identity misconfigurations, refused in every environment. */
export function albAuthProblems(env: Env): string[] {
  const arn = env.BREADBOARD_ALB_AUTH_ARN?.trim() || undefined;
  const issuer = env.BREADBOARD_ALB_AUTH_ISSUER?.trim() || undefined;
  const clientId = env.BREADBOARD_ALB_AUTH_CLIENT_ID?.trim() || undefined;
  if (!arn) return issuer || clientId ? ['BREADBOARD_ALB_AUTH_ISSUER and BREADBOARD_ALB_AUTH_CLIENT_ID need BREADBOARD_ALB_AUTH_ARN'] : [];
  const problems: string[] = [];
  if (!ALB_ARN.test(arn)) problems.push(`BREADBOARD_ALB_AUTH_ARN must be an Application Load Balancer ARN in the aws partition (arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>), got ${arn}`);
  if (issuer && !/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(issuer)) problems.push(`BREADBOARD_ALB_AUTH_ISSUER must be an https URL, got ${issuer}`);
  if (clientId && !OIDC_CLIENT_ID.test(clientId)) problems.push('BREADBOARD_ALB_AUTH_CLIENT_ID has characters an OIDC client id cannot have');
  return problems;
}

export function albAuthConfig(env: Env): AlbAuthConfig | null {
  const problems = albAuthProblems(env);
  if (problems.length) throw new Error(`invalid load-balancer identity configuration:\n  - ${problems.join('\n  - ')}`);
  const signerArn = env.BREADBOARD_ALB_AUTH_ARN?.trim();
  if (!signerArn) return null;
  const region = ALB_ARN.exec(signerArn)![1]!;
  return {
    signerArn,
    keyUrl: (kid) => `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`,
    issuer: env.BREADBOARD_ALB_AUTH_ISSUER?.trim() || null,
    clientId: env.BREADBOARD_ALB_AUTH_CLIENT_ID?.trim() || null,
  };
}

/** `BREADBOARD_OIDC_ADOPT_HANDLES` as a list (lower-cased, deduplicated). */
export function oidcAdoptHandles(env: Env): string[] {
  return [...new Set((env.BREADBOARD_OIDC_ADOPT_HANDLES ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

/** Refuse to start in production with missing or well-known secrets (see `productionSecretProblems`). */
export function assertProductionSecrets(env: Env): void {
  const problems = productionSecretProblems(env);
  if (problems.length) throw new Error(`refusing to start with NODE_ENV=production:\n  - ${problems.join('\n  - ')}`);
}

/** Resolve a path env var against a root directory (the repo root by default). */
export function resolvePath(p: string, root = process.cwd()): string {
  return resolve(root, p);
}
