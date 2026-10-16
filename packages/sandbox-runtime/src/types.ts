export interface ArtifactRef {
  uid: string;
  revision_id: number;
}

export interface StepResult<O = unknown> {
  exit: string;
  output: O;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Chat content blocks, as the Breadboard model gateway uses them. `reasoning` blocks come back from models that think;
 * pass them back unchanged on the next turn (their signatures are bound to the model and the conversation).
 */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'reasoning'; text: string; signature?: string; redacted?: string; model_id: string; prefix_fp?: string };

export interface ConverseRequest {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: ChatBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  /** Model preset tier (default `medium`); `model_id` overrides it. */
  preset?: string;
  model_id?: string;
  max_tokens?: number;
  temperature?: number;
  /** Reasoning effort; ignored by models that do not reason. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Make the model call this tool (forced where the model allows it, an instruction otherwise). */
  force_tool?: string;
}

export interface ConverseResponse {
  message: { role: 'assistant'; content: ChatBlock[] };
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
  /** `input_tokens` is the uncached input; cache counts appear when the prompt cache was used. */
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number };
  model_id: string;
  cost_usd: number;
}

export interface BrokerFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}
export interface BrokerFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface BreadboardAmbient {
  session_id: string | null;
  step_id: string | null;
  attempt: number | null;
  execution_key: string;
  tool_uid: string;
  budget_remaining: { usd: number; tokens: number } | null;
  task: ArtifactRef | null;
  settings: Record<string, unknown>;
  /** `code-step` when invoked as a circuit step; `tool-call` when invoked by an LLM; `connector` for scheduled sync. */
  invocation: 'code-step' | 'tool-call' | 'connector' | 'mcp-external' | 'eval';
}

/** The closed set of Breadboard primitives available to tool code ([06] §7). */
export interface BreadboardContext {
  ambient: BreadboardAmbient;
  log(level: LogLevel, message: string, data?: unknown): void;

  // Content primitives
  createArtifact(args: { title: string; body: string | object; tags?: string[]; scope?: 'team' | 'session'; properties?: Record<string, unknown>; derived_from?: ArtifactRef[] }): Promise<ArtifactRef>;
  updateArtifact(args: { uid: string; body?: string | object; title?: string; properties?: Record<string, unknown>; tags_add?: string[]; tags_remove?: string[] }): Promise<ArtifactRef>;
  readNode(uid: string, revision_id?: number): Promise<{ uid: string; type: string; title: string; properties: Record<string, unknown>; body: unknown; body_text: string | null; tags: string[]; revision_id: number | null }>;
  addComment(args: { target: string; body: string; anchor?: { revision?: number; quote: string; context?: string } }): Promise<{ uid: string }>;
  emitEdge(args: { type: 'derived-from' | 'attached-to' | 'blocks' | 'depends-on' | 'references'; src: string; dst: string; dst_revision?: number }): Promise<{ edge_id: number }>;
  tagNeedInput(args: { uid: string; role?: string; username?: string; prompt?: string }): Promise<{ request_id: string }>;

  // Knowledge primitives
  queryKnowledge(args: { q: string; mode?: 'text' | 'semantic' | 'hybrid'; domains?: string[]; limit?: number }): Promise<Array<{ uid: string; title: string; snippet: string; score: number; domains: string[] }>>;
  readNote(uid: string): Promise<{ uid: string; title: string; markdown: string; base_revision: number; domains: string[]; read_only: boolean }>;
  proposeNoteEdit(args: { uid: string; base_revision: number; markdown: string }): Promise<{ applied: boolean; had_concurrent_edits: boolean; merged_markdown: string; new_head_revision: number }>;

  // Intake primitives
  createTask(args: { title: string; body: string; priority?: 'p0' | 'p1' | 'p2' | 'p3'; target_circuit?: string; draft?: boolean; tags?: string[] }): Promise<{ uid: string; status: string }>;
  findSimilarTasks(args: { q: string; limit?: number }): Promise<Array<{ uid: string; title: string; status: string; score: number }>>;

  // Session primitives
  runCircuit(uid: string, input: unknown, opts?: { wait?: boolean }): Promise<{ session_id: string; state: string; exit?: string; output?: unknown }>;
  getSessionSummary(session_id: string): Promise<unknown>;

  // Composability
  runTool(uid: string, input: unknown, settings?: Record<string, unknown>): Promise<unknown>;

  // Broker-mediated outbound HTTP
  fetch(capability: string, request: BrokerFetchRequest): Promise<BrokerFetchResponse>;

  // One model turn through the Breadboard model gateway (the tool must declare the `model` capability)
  converse(request: ConverseRequest): Promise<ConverseResponse>;

  // Evals
  recordScore(args: { eval_run_id: string; fixture_id: string; dimension: string; value: unknown; rationale?: string }): Promise<void>;
  getRubric(circuit_uid: string): Promise<unknown>;

  // Config
  /** `ref`: a UID, a slug (or `<kind>:<slug>`), `presets` / `tenets` / `breadboard`, or a repo-relative path. */
  readConfig(ref: string): Promise<unknown>;
}

export interface ToolHandler<I = any, O = any> {
  (input: I, ctx: BreadboardContext): Promise<O | StepResult<O>>;
}

/** Connector tools ([07] §8) export these instead of/in addition to `handler`. */
export interface ConnectorModule {
  list(cursor: string | null, ctx: BreadboardContext): Promise<{ items: Array<{ external_id: string; title: string; updated_at: string }>; next_cursor: string | null }>;
  fetch(external_id: string, ctx: BreadboardContext): Promise<{ markdown: string; metadata: Record<string, unknown> }>;
}

/** Wire protocol between the sandbox runner and the host (stdin JSON in → stdout JSON lines out). */
export interface RunnerRequest {
  entrypoint: string;
  export?: string; // handler | list | fetch
  input: unknown;
  ambient: BreadboardAmbient;
  api: { base_url: string; token: string };
  timeout_ms: number;
}
export type RunnerMessage =
  | { kind: 'log'; level: LogLevel; message: string; data?: unknown; at: string }
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; message: string; stack?: string };
