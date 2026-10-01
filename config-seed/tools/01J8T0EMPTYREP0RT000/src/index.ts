import type { BreadboardContext, StepResult, ArtifactRef } from '@breadboard/sandbox-runtime';

interface Input {
  question?: string;
  reason?: string;
}
interface Output {
  note: string;
  report_artifact: ArtifactRef;
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  const question = input?.question?.trim() || '(question not provided)';
  const note = `No qualifying sources were found for: ${question}`;
  const body = [
    `# No sources found`,
    '',
    `**Question:** ${question}`,
    '',
    input?.reason ? `**Why:** ${input.reason}` : '**Why:** the search step returned no qualifying sources.',
    '',
    'Suggested next steps:',
    '- Rephrase the question with more specific terms, or broaden it.',
    '- Add relevant Notes to the `prior-art` Knowledge Domain and re-run.',
    '- Check whether the scholarly search capability is configured in the credential broker.',
  ].join('\n');

  const report_artifact = await ctx.createArtifact({
    title: `No sources found: ${question.slice(0, 80)}`,
    body,
    tags: ['deliverable', 'empty-report'],
    scope: 'team',
    properties: { session_id: ctx.ambient.session_id },
  });
  const output: Output = { note, report_artifact };
  return ctx.ambient.invocation === 'code-step' ? { exit: 'done', output } : output;
}
