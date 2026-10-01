import type { BreadboardContext, BreadboardAmbient, LogLevel, RunnerMessage } from './types.js';

/**
 * Build the `ctx` object handed to tool code. Every primitive is an authenticated call to the Breadboard
 * API (`/api/v1/primitives/<name>`), so grants are enforced server-side regardless of where code runs ([06] §7).
 */
export function createContext(args: { ambient: BreadboardAmbient; baseUrl: string; token: string; emit: (m: RunnerMessage) => void }): BreadboardContext {
  const { ambient, baseUrl, token, emit } = args;

  async function call<T>(name: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/primitives/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-breadboard-execution': ambient.execution_key },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: { code: 'parse-failed', message: text } };
    }
    if (!res.ok) {
      const err = new Error(json?.error?.message ?? `primitive ${name} failed (${res.status})`) as Error & { code?: string; detail?: unknown };
      err.code = json?.error?.code ?? 'internal';
      err.detail = json?.error?.detail;
      throw err;
    }
    return json as T;
  }

  const log = (level: LogLevel, message: string, data?: unknown) => emit({ kind: 'log', level, message, data, at: new Date().toISOString() });

  return {
    ambient,
    log,
    createArtifact: (a) => call('create_artifact', a),
    updateArtifact: (a) => call('update_artifact', a),
    readNode: (uid, revision_id) => call('read_node', { uid, revision_id }),
    addComment: (a) => call('add_comment', a),
    emitEdge: (a) => call('emit_edge', a),
    tagNeedInput: (a) => call('tag_need_input', a),
    queryKnowledge: (a) => call('query_knowledge', a),
    readNote: (uid) => call('read_note', { uid }),
    proposeNoteEdit: (a) => call('propose_note_edit', a),
    createTask: (a) => call('create_task', a),
    findSimilarTasks: (a) => call('find_similar_tasks', a),
    runCircuit: (uid, input, opts) => call('run_circuit', { circuit: uid, input, wait: opts?.wait ?? true }),
    getSessionSummary: (session_id) => call('get_session_summary', { session_id }),
    runTool: (uid, input, settings) => call('run_tool', { tool: uid, input, settings }),
    fetch: (capability, request) => call('broker_fetch', { capability, request }),
    converse: (request) => call('model_converse', request),
    recordScore: (a) => call('record_score', a),
    getRubric: (circuit_uid) => call('get_rubric', { circuit_uid }),
    readConfig: (ref) => call('read_config', { ref }),
  };
}
