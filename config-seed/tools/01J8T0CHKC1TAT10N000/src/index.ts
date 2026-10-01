import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Input {
  artifact: string | { uid: string; revision_id?: number };
}
interface Output {
  ok: boolean;
  missing: string[];
  cited: string[];
}

/** `[[UID]]` or `[[UID|title]]` with a 20-char Crockford base32 UID ([01] §3.2). */
const LINK_RE = /\[\[([0-9A-HJKMNP-TV-Z]{20})(?:\|[^\]]*)?\]\]/g;

export function extractCitations(text: string): string[] {
  return [...new Set([...text.matchAll(LINK_RE)].map((m) => m[1]!))];
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  const ref = typeof input.artifact === 'string' ? { uid: input.artifact } : input.artifact;
  if (!ref || typeof ref.uid !== 'string') throw new Error('input.artifact must be a UID or an artifact ref');

  const node = await ctx.readNode(ref.uid, ref.revision_id);
  const text = node.body_text ?? (typeof node.body === 'string' ? node.body : JSON.stringify(node.body ?? ''));
  const cited = extractCitations(text).filter((uid) => uid !== ref.uid);

  const missing: string[] = [];
  for (const uid of cited) {
    try {
      await ctx.readNode(uid);
    } catch (e) {
      // not-found and forbidden both count: a citation the reader cannot open does not ground anything.
      ctx.log('debug', `citation ${uid} did not resolve`, { code: (e as { code?: string }).code });
      missing.push(uid);
    }
  }

  const strict = ctx.ambient.settings?.strict === true;
  const ok = missing.length === 0 && (!strict || cited.length > 0);
  ctx.log('info', `checked ${cited.length} citation(s): ${missing.length} missing`, { strict });
  const output: Output = { ok, missing, cited };
  return ctx.ambient.invocation === 'code-step' ? { exit: ok ? 'pass' : 'fail', output } : output;
}
