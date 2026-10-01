/**
 * Configuration-plane routes ([11] §3 "Configuration plane"). Thin: scope checks + body shaping; the
 * ConfigService owns validation and the propose-review-commit state machine.
 */
import type { FastifyInstance } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import type { Services, FileChange } from '../core/services.js';
import { requireScope, type Principal } from '../core/principal.js';
import { intParam, principalOf, requireBody, requireField, strParam } from './util.js';
import { API_PREFIX } from '../app.js';

function changesOf(body: any): FileChange[] {
  const raw = requireField<unknown[]>(body, 'changes', 'array');
  return raw.map((c: any, i) => {
    if (!c || typeof c !== 'object' || typeof c.path !== 'string' || !c.path.trim()) throw new BreadboardError('validation-failed', `changes[${i}].path (string) is required`);
    const content = c.content === undefined || c.content === null ? null : c.content;
    if (content !== null && typeof content !== 'string') throw new BreadboardError('validation-failed', `changes[${i}].content must be a string or null (null = delete)`);
    return { path: c.path, content };
  });
}

/** Any config-plane scope implies read access (a token that may propose or merge must be able to inspect the tree). */
function requireRead(p: Principal): void {
  if (p.scopes === null) return;
  if (['admin', 'config:read', 'config:write', 'config:propose', 'config:merge'].some((s) => p.scopes!.includes(s))) return;
  requireScope(p, 'config:read');
}

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const base = `${API_PREFIX}/config`;
  const { config } = services;

  app.get(`${base}/main`, async (req) => {
    requireRead(principalOf(req));
    return { commit: await config.mainCommit() };
  });

  app.get(`${base}/tree`, async (req) => {
    requireRead(principalOf(req));
    const q = req.query as any;
    return config.tree(strParam(q.ref));
  });

  app.get(`${base}/search`, async (req) => {
    requireRead(principalOf(req));
    const q = req.query as any;
    return config.search(strParam(q.q) ?? '', strParam(q.ref));
  });

  app.get(`${base}/definitions/*`, async (req) => {
    requireRead(principalOf(req));
    const q = req.query as any;
    const raw = (req.params as any)['*'] as string;
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      /* keep as-is */
    }
    return config.definition(key, strParam(q.ref));
  });

  app.get(`${base}/history`, async (req) => {
    requireRead(principalOf(req));
    const q = req.query as any;
    return config.history({ path: strParam(q.path), ref: strParam(q.ref), limit: intParam(q.limit, 50) });
  });

  app.post(`${base}/validate`, async (req) => {
    requireRead(principalOf(req));
    const body = requireBody(req);
    return config.validateChanges(changesOf(body), strParam(body.base));
  });

  app.post(`${base}/new`, async (req) => {
    requireScope(principalOf(req), 'config:propose');
    const body = requireBody(req);
    const kind = requireField<string>(body, 'kind');
    if (!['circuit', 'subagent', 'tool', 'mcp'].includes(kind)) throw new BreadboardError('validation-failed', `kind must be one of circuit, subagent, tool, mcp`);
    const slug = requireField<string>(body, 'slug');
    const title = typeof body.title === 'string' && body.title.trim() ? body.title : slug;
    const opts: Record<string, unknown> = {};
    for (const k of ['language', 'subagent', 'model_preset', 'endpoint']) if (body[k] !== undefined) opts[k] = body[k];
    return { changes: config.newDefinitionSkeleton(kind as any, slug, title, opts) };
  });

  // --- proposals ---------------------------------------------------------------------------------

  app.post(`${base}/proposals`, async (req, reply) => {
    const p = principalOf(req);
    requireScope(p, 'config:propose');
    const body = requireBody(req);
    const dto = await config.propose({ changes: changesOf(body), message: requireField(body, 'message'), by: p, base: strParam(body.base), session_id: strParam(body.session_id) ?? p.session_id });
    reply.status(201);
    return dto;
  });

  app.get(`${base}/proposals`, async (req) => {
    requireRead(principalOf(req));
    const q = req.query as any;
    return config.listProposals({ status: strParam(q.status), limit: intParam(q.limit, 50) });
  });

  app.get(`${base}/proposals/:id`, async (req) => {
    requireRead(principalOf(req));
    return config.getProposal((req.params as any).id);
  });

  app.post(`${base}/proposals/:id/amend`, async (req) => {
    const p = principalOf(req);
    requireScope(p, 'config:propose');
    const body = requireBody(req);
    return config.amendProposal((req.params as any).id, changesOf(body), requireField(body, 'message'), p);
  });

  app.post(`${base}/proposals/:id/merge`, async (req) => {
    const p = principalOf(req);
    requireScope(p, 'config:merge');
    return config.mergeProposal((req.params as any).id, p);
  });

  app.post(`${base}/proposals/:id/discard`, async (req) => {
    const p = principalOf(req);
    requireScope(p, 'config:propose');
    return config.discardProposal((req.params as any).id, p);
  });

  // --- direct writes -----------------------------------------------------------------------------

  app.post(`${base}/commit`, async (req, reply) => {
    const p = principalOf(req);
    requireScope(p, 'config:merge');
    const body = requireBody(req);
    const out = await config.commitDirect({ changes: changesOf(body), message: requireField(body, 'message'), by: p });
    reply.status(201);
    return out;
  });

  app.post(`${base}/revert`, async (req, reply) => {
    const p = principalOf(req);
    requireScope(p, 'config:merge');
    const body = requireBody(req);
    const out = await config.revert({ path: strParam(body.path), to_commit: requireField(body, 'to_commit'), by: p, message: strParam(body.message) });
    reply.status(201);
    return out;
  });
}
