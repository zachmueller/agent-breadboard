import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Input {
  title: string;
  body?: string;
  task_uid?: string | null;
  limit?: number;
}
interface Candidate {
  uid: string;
  title: string;
  status: string;
  score: number;
}
interface Output {
  candidates: Candidate[];
  edges_emitted: number;
  summary: string;
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  const minScore = Number(ctx.ambient.settings?.min_score ?? 0.75);
  const limit = Math.min(25, Number(input.limit ?? ctx.ambient.settings?.limit ?? 8));
  const self = input.task_uid || null;

  // Title carries most of the signal; a bounded slice of the body adds context without drowning it.
  const q = [input.title, (input.body ?? '').slice(0, 1500)].filter(Boolean).join('\n\n');
  const hits = await ctx.findSimilarTasks({ q, limit: limit + 1 });
  const candidates = hits.filter((h) => h.uid !== self && h.score >= minScore).slice(0, limit);

  let edges_emitted = 0;
  if (self) {
    for (const c of candidates) {
      try {
        await ctx.emitEdge({ type: 'references', src: self, dst: c.uid });
        edges_emitted++;
      } catch (e) {
        ctx.log('warn', `could not emit references edge ${self} -> ${c.uid}`, { error: (e as Error).message });
      }
    }
  }

  const summary = candidates.length
    ? `${candidates.length} similar task(s) at or above score ${minScore}.`
    : `No similar tasks at or above score ${minScore} (searched ${hits.length}).`;
  ctx.log('info', summary, { edges_emitted });
  const output: Output = { candidates, edges_emitted, summary };
  return ctx.ambient.invocation === 'code-step' ? { exit: candidates.length ? 'found' : 'none', output } : output;
}
