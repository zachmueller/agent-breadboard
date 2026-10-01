import type { BreadboardContext } from '@breadboard/sandbox-runtime';

interface Input {
  fixture: { fixture_id?: string; tags?: string[] };
  output?: unknown;
  exit?: string;
  session_id?: string;
}
interface Output {
  pass: boolean;
  score: number;
  detail: string;
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output> {
  const tag = (input.fixture?.tags ?? []).find((t) => t.startsWith('expect-exit:'));
  const expected = tag ? tag.slice('expect-exit:'.length) : String(ctx.ambient.settings?.expected ?? '');
  if (!expected) return { pass: false, score: 0, detail: 'no expectation: add an `expect-exit:<name>` fixture tag or set `expected`' };

  let actual = input.exit;
  if (!actual && input.session_id) {
    const summary = (await ctx.getSessionSummary(input.session_id)) as { exit?: string; exit_name?: string } | null;
    actual = summary?.exit ?? summary?.exit_name;
  }
  if (!actual) return { pass: false, score: 0, detail: `expected exit '${expected}' but the session's exit is unknown` };
  const pass = actual === expected;
  return { pass, score: pass ? 1 : 0, detail: pass ? `exited through '${actual}' as expected` : `expected exit '${expected}', got '${actual}'` };
}
