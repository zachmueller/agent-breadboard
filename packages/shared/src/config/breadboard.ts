import { z } from 'zod';
import { zUid, zSlug, zBudget, zRetryPolicy, SCHEMA_TAGS } from './common.js';

export const zKnowledgeInjectionRule = z.object({
  domain: z.string().min(1),
  trigger: z.object({ kind: z.literal('reference-match'), pattern: z.string().min(1) }),
  inject: z.object({ notes_tagged: z.string().min(1) }),
  max_notes: z.number().int().positive().default(3),
});
export type KnowledgeInjectionRule = z.infer<typeof zKnowledgeInjectionRule>;

/** A git branch name a mirror may track: refname rules, minus anything git would reject or read as an option. */
export const MIRROR_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<![/.])$/;

function mirrorUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (!['https:', 'http:', 'file:'].includes(u.protocol)) return 'must use https (http and file only for local testing)';
  if (u.username || u.password) return 'must not embed credentials: name a broker capability instead';
  return null;
}

/** A git repository the server mirrors for `search_repo` / `read_repo_file` ([06] §7.1). */
export const zRepoMirror = z.object({
  /** Slug; subagents grant it as `repos: [<name>]` and callers pass it as `repo`. */
  name: zSlug,
  description: z.string().default(''),
  url: z.string().min(1).superRefine((v, ctx) => {
    const problem = mirrorUrlProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: `repository url ${problem}` });
  }),
  branch: z.string().regex(MIRROR_BRANCH_RE, 'branch must be a valid git branch name').default('main'),
  /** Broker capability that authenticates the fetch; omit for a public repository. */
  capability: z.string().min(1).optional(),
  /** A search or read fetches first when the last fetch attempt is at least this old. */
  refresh_minutes: z.number().min(1).default(5),
  /** Files larger than this are not searched (for notebooks: the rendered cell sources). */
  max_file_bytes: z.number().int().positive().default(1_048_576),
  /** Raw `.ipynb` files larger than this are not rendered or searched. */
  max_notebook_bytes: z.number().int().positive().default(52_428_800),
  /** Git glob pathspecs never searched (still readable). */
  exclude: z.array(z.string().min(1)).default([]),
  fetch_timeout_s: z.number().int().positive().max(86_400).default(600),
  enabled: z.boolean().default(true),
});
export type RepoMirrorConfig = z.infer<typeof zRepoMirror>;

export const zBreadboardConfig = z.object({
  schema: z.literal(SCHEMA_TAGS.breadboard),
  team: z.object({ name: z.string().min(1).default("Breadboard") }).prefault({}),
  capacity: z
    .object({
      max_concurrent_runs: z.number().int().positive().default(4),
      max_spend_usd_per_hour: z.number().positive().default(25),
      dispatch_interval_ms: z.number().int().positive().default(2000),
    })
    .prefault({}),
  defaults: z
    .object({
      scope: z.enum(['team', 'session']).default('team'),
      budget: zBudget.default({ max_cost_usd: 5, max_tokens: 1_000_000 }),
      retry: zRetryPolicy.default({ max_attempts: 3, backoff: { base_s: 5, cap_s: 300 } }),
      max_visits: z.number().int().positive().default(25),
      max_tool_cost_units: z.number().positive().default(100),
    })
    .prefault({}),
  intake: z
    .object({
      triage_circuit: zUid.optional(),
      draft_retention_days: z.number().int().positive().default(30),
      shaper_subagent: zUid.optional(),
    })
    .prefault({}),
  designers: z
    .object({
      circuit: zUid.optional(),
      tool: zUid.optional(),
      subagent: zUid.optional(),
    })
    .prefault({}),
  knowledge: z
    .object({
      domains: z.array(z.object({ slug: zSlug, description: z.string().default('') })).default([]),
      base_revision_retention_hours: z.number().positive().default(24),
      compaction_update_threshold: z.number().int().positive().default(500),
      wipeout_fraction: z.number().min(0).max(1).default(0.9),
      size_warning_chars: z.number().int().positive().default(200_000),
    })
    .prefault({}),
  knowledge_injection: z.array(zKnowledgeInjectionRule).default([]),
  tenets: z.object({ max_chars: z.number().int().positive().max(2000).default(2000) }).prefault({}),
  auth: z
    .object({
      mode: z.enum(['local', 'oidc']).default('local'),
      local_users: z
        .array(
          z.object({
            handle: z.string().min(1),
            display_name: z.string().optional(),
            token: z.string().min(8),
            admin: z.boolean().default(false),
            roles: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      oidc: z
        .object({
          issuer: z.string().url(),
          client_id: z.string(),
          client_secret_env: z.string().default('OIDC_CLIENT_SECRET'),
          redirect_uri: z.string().url().optional(),
          scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
          groups_claim: z.string().default('groups'),
          group_mappings: z
            .object({
              admin: z.array(z.string()).default([]),
              roles: z.record(z.string(), z.array(z.string())).prefault({}),
            })
            .prefault({}),
        })
        .optional(),
    })
    .prefault({}),
  webhooks: z
    .array(
      z.object({
        url: z.string().url(),
        secret_env: z.string(),
        topics: z.array(z.string()).default(['session.state']),
      }),
    )
    .default([]),
  sandbox: z
    .object({
      nesting_depth_cap: z.number().int().positive().default(8),
      warm_pool_size: z.number().int().nonnegative().default(2),
      images: z.object({ typescript: z.string().default('breadboard-sandbox-ts:local'), python: z.string().default('breadboard-sandbox-py:local') }).prefault({}),
    })
    .prefault({}),
  connectors: z
    .array(
      z.object({
        tool: zUid,
        schedule_minutes: z.number().positive().optional(),
        domains: z.array(z.string()).optional(),
        settings: z.record(z.string(), z.any()).prefault({}),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  repos: z
    .array(zRepoMirror)
    .default([])
    .superRefine((repos, ctx) => {
      const seen = new Set<string>();
      repos.forEach((r, i) => {
        if (seen.has(r.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `duplicate repository name '${r.name}'` });
        seen.add(r.name);
      });
    }),
});
export type BreadboardConfig = z.infer<typeof zBreadboardConfig>;
