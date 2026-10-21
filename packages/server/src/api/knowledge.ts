/**
 * Knowledge REST surface ([11] §3 "Knowledge", [07]). Grants are enforced in the KnowledgeService; the
 * routes add token-scope checks (`knowledge:read` / `knowledge:write`). The Yjs WebSocket endpoint
 * (`WS /api/v1/sync`) is mounted by `services.sync.register(app)`.
 */
import type { FastifyInstance } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireScope, type Principal } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { assertCanRead } from '../knowledge/service.js';
import { arrayParam, intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

type UidParams = { uid: string };
const MODES = new Set(['text', 'semantic', 'hybrid']);

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const { knowledge } = services;
  const read = (req: any): Principal => {
    const p = principalOf(req);
    requireScope(p, 'knowledge:read');
    return p;
  };
  const write = (req: any): Principal => {
    const p = principalOf(req);
    requireScope(p, 'knowledge:write');
    return p;
  };
  const revisionField = (body: any, name: string): number => {
    const v = typeof body?.[name] === 'string' ? Number(body[name]) : body?.[name];
    if (!Number.isInteger(v)) throw new BreadboardError('validation-failed', `field '${name}' (integer) is required`);
    return v as number;
  };

  app.get(`${API_PREFIX}/knowledge/search`, async (req) => {
    const by = read(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const mode = strParam(q.mode);
    if (mode && !MODES.has(mode)) throw new BreadboardError('validation-failed', `mode must be one of text|semantic|hybrid`);
    const hits = await knowledge.search({
      q: strParam(q.q) ?? '',
      mode: mode as 'text' | 'semantic' | 'hybrid' | undefined,
      domains: arrayParam(q.domain) ?? arrayParam(q.domains),
      types: arrayParam(q.type),
      limit: intParam(q.limit, 10),
      by,
    });
    return { items: hits };
  });

  app.get(`${API_PREFIX}/knowledge/domains`, async (req) => {
    const by = read(req);
    const all = await knowledge.domains();
    // AI principals only see the domains they hold a read grant on.
    const items = by.grants ? all.filter((d) => by.grants!.knowledge.read.has(d.slug)) : all;
    return { items };
  });

  app.get(`${API_PREFIX}/knowledge/connectors`, async (req) => {
    read(req);
    return { items: await services.connectors.status() };
  });

  app.post<{ Params: { tool: string } }>(`${API_PREFIX}/knowledge/connectors/:tool/sync`, async (req, reply) => {
    const by = write(req);
    return withIdempotency(req, reply, services, () => services.connectors.syncNow(req.params.tool, by));
  });

  app.post(`${API_PREFIX}/knowledge`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const title = requireField<string>(body, 'title');
    const markdown = typeof body.markdown === 'string' ? body.markdown : typeof body.body === 'string' ? body.body : '';
    return withIdempotency(req, reply, services, async () => {
      const { revision_id: _rev, possible_duplicates: _dups, ...node } = await knowledge.createNote({
        title,
        markdown,
        domains: arrayParam(body.domains),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        properties: body.properties && typeof body.properties === 'object' ? body.properties : undefined,
        scope: body.scope,
        by,
      });
      reply.status(201);
      return services.content.nodeDto(node);
    });
  });

  /** The read_note contract: rendered Markdown pinned to a `base_revision`. */
  app.get<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid`, async (req) => knowledge.readNote(req.params.uid, read(req)));

  /** Rendered Markdown for any CRDT-backed node the caller can see (editor/viewer helper). */
  app.get<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/markdown`, async (req) => {
    const by = read(req);
    const node = await services.nodes.get(req.params.uid);
    assertCanRead(node, by, { knowledgeOnly: false });
    if (node.type === 'knowledge') {
      const n = await knowledge.readNote(node.uid, by);
      return { uid: n.uid, markdown: n.markdown, base_revision: n.base_revision, read_only: n.read_only };
    }
    return { uid: node.uid, markdown: await knowledge.markdownOf(node.uid), base_revision: await services.nodes.headRevisionId(node.uid), read_only: false };
  });

  app.get<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/attribution`, async (req) => {
    const by = read(req);
    assertCanRead(await services.nodes.get(req.params.uid), by, { knowledgeOnly: false });
    return { blocks: await knowledge.attribution(req.params.uid) };
  });

  /** The propose_note_edit reconcile path ([07] §5.2). */
  app.post<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/edits`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const base_revision = revisionField(body, 'base_revision');
    const markdown = requireField<string>(body, 'markdown');
    return withIdempotency(req, reply, services, () => knowledge.proposeEdit({ uid: req.params.uid, base_revision, markdown, by }));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/revert-ai-edit`, async (req, reply) => {
    const by = write(req);
    const pre_ai_edit_revision = revisionField(requireBody(req), 'pre_ai_edit_revision');
    return withIdempotency(req, reply, services, () => knowledge.revertAiEdit({ uid: req.params.uid, pre_ai_edit_revision, by }));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/restore`, async (req, reply) => {
    const by = write(req);
    const revision_id = revisionField(requireBody(req), 'revision_id');
    return withIdempotency(req, reply, services, () => knowledge.restoreRevision({ uid: req.params.uid, revision_id, by }));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/knowledge/:uid/compact`, async (req) => {
    const by = write(req);
    if (!by.is_admin) throw new BreadboardError('forbidden', 'compaction is admin-only');
    return { pruned: await knowledge.compact(req.params.uid) };
  });
}

