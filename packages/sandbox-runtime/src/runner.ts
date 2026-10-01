import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createContext } from './context.js';
import type { RunnerMessage, RunnerRequest } from './types.js';

/**
 * Entry used inside the TypeScript sandbox image (and by the local-process fallback):
 * reads one RunnerRequest JSON document from stdin, loads the tool entrypoint, invokes the requested export,
 * and writes RunnerMessage JSON lines to stdout. Exit code 0 on result, 1 on error.
 */
export async function runToolProcess(workdir: string, request: RunnerRequest): Promise<void> {
  const emit = (m: RunnerMessage) => process.stdout.write(JSON.stringify(m) + '\n');
  // Flush stdout before exiting: on pipes, process.exit() can truncate large pending writes.
  const exit = (code: number) => process.stdout.write('', () => process.exit(code));
  const ctx = createContext({ ambient: request.ambient, baseUrl: request.api.base_url, token: request.api.token, emit });
  const timer = setTimeout(() => {
    emit({ kind: 'error', message: `tool timed out after ${request.timeout_ms}ms` });
    exit(1);
  }, request.timeout_ms);
  try {
    const modUrl = pathToFileURL(resolve(workdir, request.entrypoint)).href;
    const mod = await import(modUrl);
    const exportName = request.export ?? 'handler';
    const fn = mod[exportName] ?? mod.default?.[exportName] ?? (exportName === 'handler' ? mod.default : undefined);
    if (typeof fn !== 'function') throw new Error(`entrypoint ${request.entrypoint} does not export '${exportName}'`);
    const value = exportName === 'handler' ? await fn(request.input, ctx) : await fn(...(Array.isArray(request.input) ? request.input : [request.input]), ctx);
    emit({ kind: 'result', value: value === undefined ? null : value });
    clearTimeout(timer);
    exit(0);
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    emit({ kind: 'error', message: err?.message ?? String(e), stack: err?.stack });
    exit(1);
  }
}

/** CLI: `node runner-cli.js <workdir>` with the RunnerRequest on stdin. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const workdir = argv[0] ?? process.cwd();
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const req = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunnerRequest;
  await runToolProcess(workdir, req);
}
