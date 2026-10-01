import { isUid, type SessionEvent, type SessionSummaryDto, type StepSummaryDto } from '@breadboard/shared';

export interface CircuitStepInfo {
  id: string;
  kind: string;
  title?: string;
  exits: Array<{ name: string; to: string; description?: string }>;
  subagent?: string;
  tool?: string;
  circuit?: string;
}

/** Pull the step table out of a circuit definition (`GET /config/definitions/:uid` → `definition`). */
export function circuitSteps(definition: unknown): Map<string, CircuitStepInfo> {
  const m = new Map<string, CircuitStepInfo>();
  const steps = (definition as { steps?: unknown[] } | null)?.steps;
  if (!Array.isArray(steps)) return m;
  for (const s of steps as Array<Record<string, unknown>>) {
    if (typeof s?.id !== 'string') continue;
    m.set(s.id, {
      id: s.id,
      kind: String(s.kind ?? ''),
      title: typeof s.title === 'string' ? s.title : undefined,
      exits: Array.isArray(s.exits) ? (s.exits as CircuitStepInfo['exits']) : [],
      subagent: typeof s.subagent === 'string' ? s.subagent : undefined,
      tool: typeof s.tool === 'string' ? s.tool : undefined,
      circuit: typeof s.circuit === 'string' ? s.circuit : undefined,
    });
  }
  return m;
}

/** Collect `{uid}` artifact references anywhere inside a value (gate payloads, state_detail). */
export function collectNodeRefs(v: unknown, out = new Map<string, number | null>(), depth = 0): Map<string, number | null> {
  if (depth > 6 || v === null || v === undefined) return out;
  if (Array.isArray(v)) {
    for (const x of v) collectNodeRefs(x, out, depth + 1);
    return out;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const uid = o.uid ?? o.node_uid ?? o.artifact_uid;
    if (typeof uid === 'string' && isUid(uid) && !out.has(uid)) out.set(uid, typeof o.revision_id === 'number' ? o.revision_id : null);
    for (const [k, x] of Object.entries(o)) if (k !== 'uid' && k !== 'node_uid') collectNodeRefs(x, out, depth + 1);
  }
  return out;
}

/** Artifacts a gate step is waiting on: from `gate-suspended` events for that step, then session state_detail. */
export function gateArtifacts(session: SessionSummaryDto | undefined, events: SessionEvent[], stepId?: string | null): Array<{ uid: string; revision_id: number | null }> {
  const refs = new Map<string, number | null>();
  for (const e of events) if (e.event_type === 'gate-suspended' && (!stepId || e.step_id === stepId)) collectNodeRefs(e.payload, refs);
  if (!refs.size && session?.state === 'suspended-gate' && (!stepId || (session.state_detail as { step_id?: string })?.step_id === stepId || !(session.state_detail as { step_id?: string })?.step_id))
    collectNodeRefs(session.state_detail, refs);
  return [...refs].map(([uid, revision_id]) => ({ uid, revision_id }));
}

/** Group step summaries by step id, preserving first-visit order; each entry has all attempts. */
export function groupSteps(steps: StepSummaryDto[]): Array<{ step_id: string; attempts: StepSummaryDto[]; latest: StepSummaryDto; visit: number }> {
  // Steps can be visited more than once (loops). A new "visit" starts when a step id reappears after another step.
  const out: Array<{ step_id: string; attempts: StepSummaryDto[]; latest: StepSummaryDto; visit: number }> = [];
  const visits = new Map<string, number>();
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && prev.step_id === s.step_id && s.attempt > prev.latest.attempt) {
      prev.attempts.push(s);
      prev.latest = s;
      continue;
    }
    const v = (visits.get(s.step_id) ?? 0) + 1;
    visits.set(s.step_id, v);
    out.push({ step_id: s.step_id, attempts: [s], latest: s, visit: v });
  }
  return out;
}

/** The step a suspended-error session failed at. */
export function failedStepId(session: SessionSummaryDto | undefined): string | null {
  if (!session) return null;
  const d = session.state_detail as { step_id?: string; failed_step?: string } | undefined;
  if (d?.step_id) return d.step_id;
  if (d?.failed_step) return d.failed_step;
  const failed = [...(session.steps ?? [])].reverse().find((s) => s.status === 'failed');
  return failed?.step_id ?? null;
}

export function stateDetailMessage(session: SessionSummaryDto | undefined): string | null {
  const d = (session?.state_detail ?? {}) as Record<string, unknown>;
  for (const k of ['message', 'error', 'reason_detail', 'reason']) if (typeof d[k] === 'string' && d[k]) return d[k] as string;
  return null;
}
