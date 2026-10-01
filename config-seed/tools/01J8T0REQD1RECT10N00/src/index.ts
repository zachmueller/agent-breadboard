import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Input {
  uid?: string | null;
  title?: string;
  rationale?: string;
  role?: string;
  username?: string;
}
interface Output {
  request_id: string | null;
  reason: string;
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  const done = (output: Output) => (ctx.ambient.invocation === 'code-step' ? { exit: 'done', output } : output);
  const uid = input?.uid || ctx.ambient.task?.uid || null;
  const reason = input?.rationale?.trim() || 'No handling circuit clearly fits this item.';

  if (!uid) {
    ctx.log('warn', 'request-direction: no node to tag (no uid given and no ambient task); nothing was requested');
    return done({ request_id: null, reason });
  }

  const target = input?.username
    ? { username: input.username }
    : { role: input?.role || String(ctx.ambient.settings?.default_role ?? 'scientist') };
  const prompt = [
    input?.title ? `How should "${input.title}" be handled?` : 'How should this item be handled?',
    `Triage could not route it automatically: ${reason}`,
    'Set a target circuit on the Task, rewrite it so it fits an existing circuit, or reject it.',
  ].join(' ');

  const { request_id } = await ctx.tagNeedInput({ uid, ...target, prompt });
  ctx.log('info', `tagged ${uid} need-input`, { request_id, ...target });
  return done({ request_id, reason });
}
