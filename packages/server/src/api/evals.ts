import type { FastifyInstance } from 'fastify';
import { validationFailed } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireScope } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { ANALYSIS_VIEWS, type AnalysisOptions, type AnalysisView } from '../evals/analysis.js';
import { arrayParam, intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

/** Evals REST surface ([11] §3 Evals, [04] §5 record_score mirror). */
export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const P = `${API_PREFIX}/evals`;

  app.post(`${P}/runs`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'evals:write');
    const body = requireBody(req);
    const circuit = requireField<string>(body, 'circuit');
    if (body.model_overrides != null && (typeof body.model_overrides !== 'object' || Array.isArray(body.model_overrides))) throw validationFailed('model_overrides must be an object of preset → model id');
    return withIdempotency(req, reply, services, async () => {
      const run = await services.evals.startRun({
        circuit,
        ref: typeof body.ref === 'string' ? body.ref : null,
        fixture_tags: Array.isArray(body.fixture_tags) ? body.fixture_tags.map(String) : null,
        model_overrides: body.model_overrides ?? null,
        proposal_id: typeof body.proposal_id === 'string' ? body.proposal_id : null,
        // Runs take minutes; REST returns immediately unless the caller explicitly waits.
        wait: body.wait === true,
        by,
      });
      reply.status(run.status === 'running' ? 202 : 201);
      return run;
    });
  });

  app.get(`${P}/runs`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'evals:read');
    const q = req.query as Record<string, unknown>;
    const items = await services.evals.listRuns({ circuit: strParam(q.circuit), status: strParam(q.status), limit: intParam(q.limit, 50) });
    return { items, next_cursor: null };
  });

  app.get(`${P}/runs/:id`, async (req) => {
    requireScope(principalOf(req), 'evals:read');
    return services.evals.getRun((req.params as { id: string }).id);
  });

  app.get(`${P}/runs/:id/fixtures/:fixture/output`, async (req) => {
    requireScope(principalOf(req), 'evals:read');
    const { id, fixture } = req.params as { id: string; fixture: string };
    return services.evals.getFixtureOutput(id, fixture);
  });

  app.get(`${P}/analysis/:circuit`, async (req) => {
    requireScope(principalOf(req), 'evals:read');
    const q = req.query as Record<string, unknown>;
    const view = (strParam(q.view) ?? 'trend') as AnalysisView;
    if (!ANALYSIS_VIEWS.includes(view)) throw validationFailed(`view must be one of ${ANALYSIS_VIEWS.join(', ')}`);
    const opts: AnalysisOptions = { base: strParam(q.base), head: strParam(q.head), circuit_commit: strParam(q.circuit_commit), variant: strParam(q.variant) };
    // `opts` is an optional extension over the EvalService interface (see EvalServiceImpl.analysis).
    const analysis = services.evals.analysis as (c: string, v: AnalysisView, o?: AnalysisOptions) => Promise<Record<string, unknown>>;
    return analysis.call(services.evals, (req.params as { circuit: string }).circuit, view, opts);
  });

  app.get(`${P}/dashboard`, async (req) => {
    requireScope(principalOf(req), 'evals:read');
    return services.evals.dashboard();
  });

  // record_score REST mirror ([04] §5).
  app.post(`${P}/scores`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'evals:write');
    const body = requireBody(req);
    const input = {
      eval_run_id: requireField<string>(body, 'eval_run_id'),
      fixture_id: requireField<string>(body, 'fixture_id'),
      dimension: requireField<string>(body, 'dimension'),
      value: body.value,
      rationale: typeof body.rationale === 'string' ? body.rationale : null,
      by,
    };
    if (input.value === undefined) throw validationFailed("field 'value' is required");
    return withIdempotency(req, reply, services, async () => {
      await services.evals.recordScore(input);
      return { ok: true };
    });
  });

  // "Promote to fixture" from the Session explorer ([04] §3, §8).
  app.post(`${P}/fixtures`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'evals:write');
    const body = requireBody(req);
    const session_id = requireField<string>(body, 'session_id');
    const fixture_title = requireField<string>(body, body.fixture_title !== undefined ? 'fixture_title' : 'title');
    return withIdempotency(req, reply, services, async () => {
      const out = await services.evals.promoteFixture({ session_id, fixture_title, tags: arrayParam(body.tags) ?? [], notes: typeof body.notes === 'string' ? body.notes : undefined, by });
      reply.status(201);
      return out;
    });
  });
}
