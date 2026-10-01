import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Input {
  query: string;
  repo?: string | null;
  limit?: number;
}
interface Result {
  repo: string;
  path: string;
  url: string;
  fragments: string[];
}
interface Output {
  available: boolean;
  query: string;
  results: Result[];
  note?: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult<Output>> {
  const finish = (output: Output) => (ctx.ambient.invocation === 'code-step' ? { exit: 'done', output } : output);
  const settings = ctx.ambient.settings ?? {};
  const repo = (input.repo || String(settings.default_repo ?? '')).trim();
  const limit = Math.max(1, Math.min(50, Number(input.limit ?? settings.max_results ?? 10)));
  if (repo && !REPO_RE.test(repo)) throw new Error(`repo must look like owner/name, got: ${repo}`);

  const q = repo ? `${input.query} repo:${repo}` : input.query;
  const url = `https://api.github.com/search/code?per_page=${limit}&q=${encodeURIComponent(q)}`;

  let res;
  try {
    res = await ctx.fetch('github-api', {
      url,
      method: 'GET',
      headers: { accept: 'application/vnd.github.text-match+json', 'x-github-api-version': '2022-11-28' },
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'error';
    ctx.log('warn', `github-api capability unavailable (${code}); returning no results`, { message: (e as Error).message });
    return finish({
      available: false,
      query: q,
      results: [],
      note: `Code search is unavailable: the broker capability 'github-api' is missing or denied (${code}). Ask an admin to configure it.`,
    });
  }

  if (res.status === 401 || res.status === 403 || res.status === 422) {
    ctx.log('warn', `GitHub code search returned ${res.status}`, { body: res.body.slice(0, 500) });
    return finish({ available: res.status === 422, query: q, results: [], note: `GitHub returned HTTP ${res.status}: ${res.body.slice(0, 200)}` });
  }
  if (res.status >= 400) throw new Error(`GitHub code search failed: HTTP ${res.status}`);

  const data = JSON.parse(res.body) as { total_count?: number; items?: any[] };
  const results: Result[] = (data.items ?? []).slice(0, limit).map((it) => ({
    repo: String(it.repository?.full_name ?? ''),
    path: String(it.path ?? ''),
    url: String(it.html_url ?? ''),
    fragments: (it.text_matches ?? []).map((m: any) => String(m.fragment ?? '')).filter(Boolean).slice(0, 3),
  }));
  ctx.log('info', `code search: ${results.length} of ${data.total_count ?? results.length} result(s)`, { q });
  return finish({ available: true, query: q, results });
}
