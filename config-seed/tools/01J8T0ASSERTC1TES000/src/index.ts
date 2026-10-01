import type { BreadboardContext } from '@breadboard/sandbox-runtime';

interface Input {
  fixture: { fixture_id?: string };
  output: Record<string, unknown> | null;
  exit?: string;
  session_id?: string;
}
interface Output {
  pass: boolean;
  score: number;
  detail: string;
}

const LINK_RE = /\[\[([0-9A-HJKMNP-TV-Z]{20})(?:\|[^\]]*)?\]\]/g;

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output> {
  const settings = ctx.ambient.settings ?? {};
  const field = String(settings.artifact_field ?? 'summary_artifact');
  const requireAny = settings.require_citations !== false;
  const ref = input.output?.[field] as { uid?: string; revision_id?: number } | undefined;
  if (!ref?.uid) return { pass: true, score: 1, detail: `output has no '${field}' artifact (exit '${input.exit ?? '?'}'); nothing to check` };

  const node = await ctx.readNode(ref.uid, ref.revision_id);
  const text = node.body_text ?? (typeof node.body === 'string' ? node.body : JSON.stringify(node.body ?? ''));
  const cited = [...new Set([...text.matchAll(LINK_RE)].map((m) => m[1]!))].filter((u) => u !== ref.uid);
  if (cited.length === 0) return { pass: !requireAny, score: requireAny ? 0 : 1, detail: 'the artifact cites no sources' };

  const missing: string[] = [];
  for (const uid of cited) {
    try {
      await ctx.readNode(uid);
    } catch {
      missing.push(uid);
    }
  }
  const resolved = cited.length - missing.length;
  return {
    pass: missing.length === 0,
    score: resolved / cited.length,
    detail: missing.length ? `${missing.length}/${cited.length} citation(s) do not resolve: ${missing.join(', ')}` : `all ${cited.length} citation(s) resolve`,
  };
}
