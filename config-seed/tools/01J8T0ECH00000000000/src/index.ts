import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Output {
  echo: unknown;
  invocation: string;
}

export async function handler(input: unknown, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  ctx.log('info', 'echo', { input });
  const output: Output = { echo: input ?? null, invocation: ctx.ambient.invocation };
  return ctx.ambient.invocation === 'code-step' ? { exit: 'done', output } : output;
}
