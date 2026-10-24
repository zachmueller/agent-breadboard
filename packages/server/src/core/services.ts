/**
 * The service container. Every subsystem is reached through these interfaces so the API, MCP server,
 * orchestrator, and sandbox primitives share one implementation of each behaviour.
 * Concrete classes live in their subsystem directories; `build.ts` wires them.
 */
import type { Actor, ArtifactRef, BreadboardConfig, Circuit, EdgeRecord, Effort, Fixtures, McpServer, NodeRecord, NodeRevision, Page, Presets, Rubric, Scope, SessionBudget, SessionEvent, SessionKind, SessionRecord, SessionSummaryDto, StreamEvent, Subagent, Tool, Turn, EventTopic, ConfigTreeEntry, ConfigDefinitionDto, AffectedCircuitDto, ProposalDto, ReviewQueueItemDto, LineageDto, NodeDto, NeedInputRequest } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { ObjectStore } from './object-store.js';
import type { Grants, Principal } from './principal.js';
import type { NodeStore } from '../content/nodes.js';
import type { EdgeStore } from '../content/edges.js';
import type { GraphQueries } from '../content/graph-queries.js';
import type { LinkIndexer } from '../content/link-indexer.js';
import type { IdentityStore, UserRecord } from '../identity/identity.js';
import type { RunnerRequest, RunnerMessage, BreadboardAmbient } from '@breadboard/sandbox-runtime';

// ---------------------------------------------------------------------------
// Configuration plane ([01] §6, §10.4)
// ---------------------------------------------------------------------------
export interface GitAuthor {
  name: string;
  email: string;
}
export interface FileChange {
  path: string;
  /** null = delete */
  content: string | null;
}
export interface CommitInfo {
  commit: string;
  author: string;
  date: string;
  message: string;
  files?: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }>;
}

/** System-git behind a seam; filesystem surface is commit-addressed ([01] §6.3). */
export interface ConfigRepo {
  readonly dir: string;
  init(seedDir?: string | null, author?: GitAuthor): Promise<{ created: boolean; head: string }>;
  /** Resolve `main` (default), a branch, or a commit to a full commit hash. */
  resolve(ref?: string): Promise<string>;
  /** Materialize a read-only tree for a commit (cached detached worktree/export). Returns an absolute dir path. */
  materializeTree(commit: string): Promise<string>;
  readFile(commit: string, path: string): Promise<string | null>;
  readFileBuffer(commit: string, path: string): Promise<Buffer | null>;
  listFiles(commit: string, prefix?: string): Promise<string[]>;
  /** Commit changes on top of `branch` (created from `base` if missing). Returns the new commit. */
  commit(opts: { branch: string; base?: string; changes: FileChange[]; message: string; author: GitAuthor }): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  deleteBranch(name: string): Promise<void>;
  listBranches(): Promise<string[]>;
  diff(base: string, head: string): Promise<{ patch: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }> }>;
  /** Merge `branch` into `into` (default main). Fast-forward when possible, else a merge commit; conflicts reported. */
  merge(opts: { branch: string; into?: string; message: string; author: GitAuthor }): Promise<{ commit: string | null; conflicts: string[] }>;
  /** Create a commit on `main` reverting `path` to its content at `toCommit` (or reverting a whole commit when path omitted). */
  revert(opts: { toCommit: string; path?: string; message: string; author: GitAuthor }): Promise<string>;
  log(opts?: { path?: string; ref?: string; limit?: number }): Promise<CommitInfo[]>;
  /** Garbage-collect the materialized-tree cache (LRU/age). */
  gcTrees(opts?: { maxEntries?: number; maxAgeMs?: number }): Promise<number>;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DefinitionLookupOptions {
  /**
   * Also resolve what agents type: a slug (`check-citations`), `<kind>:<slug>`, a slug in place of the UID in a path
   * (`tools/check-citations.yaml`), and paths with a leading `config/`; a miss lists the closest definitions. For
   * `read_config` only: REST and the UI address definitions by UID or path ([01] §6.2).
   */
  lenient?: boolean;
}

export interface LoadedCircuit {
  uid: string;
  commit: string;
  circuit: Circuit;
  /** Prompt templates keyed by path relative to the circuit dir (e.g. `prompts/gather.md`). */
  prompts: Record<string, string>;
  rubric: Rubric | null;
  fixtures: Fixtures | null;
}

export interface LoadedTool {
  uid: string;
  commit: string;
  tool: Tool;
  /** Absolute path of the materialized `tools/<uid>` directory. */
  dir: string;
}

export interface ConfigService {
  /** Current main commit (cached, refreshed on every commit through this service). */
  mainCommit(): Promise<string>;
  settings(ref?: string): Promise<BreadboardConfig>;
  presets(ref?: string): Promise<Presets>;
  tenets(ref?: string): Promise<string>;
  circuit(uid: string, ref?: string): Promise<LoadedCircuit>;
  subagent(uid: string, ref?: string): Promise<Subagent>;
  tool(uid: string, ref?: string): Promise<LoadedTool>;
  mcp(uid: string, ref?: string): Promise<McpServer>;
  rubric(circuitUid: string, ref?: string): Promise<Rubric | null>;
  fixtures(circuitUid: string, ref?: string): Promise<Fixtures | null>;
  /** All definitions in the tree. */
  tree(ref?: string): Promise<ConfigTreeEntry[]>;
  search(q: string, ref?: string): Promise<ConfigTreeEntry[]>;
  definition(uidOrPath: string, ref?: string, opts?: DefinitionLookupOptions): Promise<ConfigDefinitionDto>;
  /** Definitions that reference `uid` (config-plane backlinks, [03] §8.2). */
  referencedBy(uid: string, ref?: string): Promise<ConfigTreeEntry[]>;
  /** Full-tree validation at a commit (schema, UID/path match, dangling refs, circuit graph rules, tenets cap…). */
  validateTree(ref?: string): Promise<ValidationReport>;
  /** Validate a prospective change set against a base commit without committing. */
  validateChanges(changes: FileChange[], base?: string): Promise<ValidationReport>;
  /** Direct commit to main (user editors). Validates first; rejects on errors. */
  commitDirect(opts: { changes: FileChange[]; message: string; by: Principal }): Promise<{ commit: string; validation: ValidationReport }>;
  /** Propose-review-commit: write a branch, open a proposal. `draft` stages it outside the review queue until `submitProposal`. */
  propose(opts: { changes: FileChange[]; message: string; by: Principal; base?: string; session_id?: string | null; draft?: boolean }): Promise<ProposalDto>;
  getProposal(id: string): Promise<ProposalDto>;
  /** `definition` keeps proposals that change files of that definition (by UID); `session_id` those a conversation opened. */
  listProposals(opts?: { status?: string | string[]; limit?: number; session_id?: string; definition?: string }): Promise<ProposalDto[]>;
  /** `listProposals` with `offset` paging and the `total` matching the filters (within the newest 500 when `definition` is set). */
  pageProposals(opts?: { status?: string | string[]; limit?: number; offset?: number; session_id?: string; definition?: string }): Promise<{ total: number; proposals: ProposalDto[] }>;
  /** Update a draft or open proposal's branch with further changes (designer-chat revisions). */
  amendProposal(id: string, changes: FileChange[], message: string, by: Principal): Promise<ProposalDto>;
  /** Move a draft into the review queue (draft → open). */
  submitProposal(id: string, by: Principal): Promise<ProposalDto>;
  /** Refuses a draft: it must be submitted first. */
  mergeProposal(id: string, by: Principal): Promise<ProposalDto>;
  discardProposal(id: string, by: Principal): Promise<ProposalDto>;
  /** Circuits the proposal's changes reach, with their fixture counts, so its evals can be chosen. */
  affectedCircuits(id: string): Promise<AffectedCircuitDto[]>;
  attachEvalRun(proposalId: string, evalRunId: string): Promise<void>;
  revert(opts: { path?: string; to_commit: string; by: Principal; message?: string }): Promise<{ commit: string }>;
  history(opts?: { path?: string; ref?: string; limit?: number }): Promise<CommitInfo[]>;
  /** Unified patch between two commits or branches (resolved like every other `ref`). */
  diff(base: string, head: string): Promise<{ patch: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }> }>;
  /** Mint a UID + default skeleton for a new definition of a kind (editors' "new" action). */
  newDefinitionSkeleton(kind: 'circuit' | 'subagent' | 'tool' | 'mcp', slug: string, title: string, opts?: Record<string, unknown>): FileChange[];
  /** Regenerate INDEX.md content for a commit. */
  renderIndex(ref?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Events ([11] §5)
// ---------------------------------------------------------------------------
export interface EventBus {
  publish(topic: EventTopic, payload: Record<string, unknown>, visibility?: StreamEvent['visibility']): Promise<StreamEvent>;
  subscribe(fn: (e: StreamEvent) => void): () => void;
  /** Events after `afterId` (SSE Last-Event-ID replay); bounded. */
  replay(afterId: string | null, limit?: number): Promise<StreamEvent[]>;
  /** Visibility filter for a subscriber. */
  visibleTo(e: StreamEvent, p: Principal): boolean;
  start(): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Model gateway ([12] §7, [05] §4)
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent[];
}
export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | ReasoningContent;

/**
 * A model's reasoning (extended thinking), kept so it can be replayed verbatim on the next turn and read in
 * transcripts. `text` is the summary the model returned (may be empty); `signature` / `redacted` (base64) are opaque
 * and bound to `model_id` and to the conversation prefix, fingerprinted as `prefix_fp` (system prompt + tool specs).
 * Providers drop the block when replaying to a different model or under a different prefix.
 */
export interface ReasoningContent {
  type: 'reasoning';
  text: string;
  signature?: string;
  redacted?: string;
  model_id: string;
  prefix_fp?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface ModelRequest {
  /** Either a preset tier or an explicit model id (explicit wins). */
  preset?: string;
  model_id?: string;
  provider?: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Force the model to call this tool (finish-tool pattern, [03] §10.3). */
  force_tool?: string;
  requires?: Array<'tool-use' | 'structured-output' | 'streaming' | 'embeddings' | 'vision'>;
  max_tokens?: number;
  temperature?: number;
  /** Reasoning effort; ignored by models that do not reason. */
  effort?: Effort;
  /** Model overrides (eval comparison runs): preset → explicit model id. */
  model_overrides?: Record<string, string> | null;
  /** Config commit whose `presets/models.yaml` resolves `preset` (a branch run's); default main. */
  config_commit?: string | null;
  /** Logging context */
  session_id?: string;
  step_id?: string;
}

export interface TokenUsage {
  /** Uncached input tokens. */
  input_tokens: number;
  output_tokens: number;
  /** Input tokens served from the prompt cache. */
  cache_read_tokens?: number;
  /** Input tokens written to the prompt cache. */
  cache_write_tokens?: number;
}
export interface ModelResponse {
  model_id: string;
  provider: string;
  message: ChatMessage; // role assistant
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
  usage: TokenUsage;
  cost_usd: number;
  latency_ms: number;
  /** Set when preset fallback skipped an earlier entry. */
  fallback_from: string | null;
}

export interface ModelCapabilities {
  'tool-use': boolean;
  'structured-output': boolean;
  streaming: boolean;
  embeddings: boolean;
  vision: boolean;
  /** Honours cache points (prompt caching). */
  'prompt-caching': boolean;
  /** Returns reasoning blocks and accepts an effort level. */
  reasoning: boolean;
  context_tokens: number;
}

export interface ModelProvider {
  readonly name: string;
  invoke(req: ModelRequest & { model_id: string }): Promise<Omit<ModelResponse, 'fallback_from' | 'cost_usd'>>;
  stream?(req: ModelRequest & { model_id: string }): AsyncIterable<{ type: 'text'; text: string } | { type: 'done'; response: Omit<ModelResponse, 'fallback_from' | 'cost_usd'> }>;
  capabilities(modelId: string): ModelCapabilities;
  cost(modelId: string, usage: TokenUsage): number;
  embed?(modelId: string, texts: string[]): Promise<number[][]>;
}

export interface ModelGateway {
  complete(req: ModelRequest): Promise<ModelResponse>;
  embed(texts: string[]): Promise<{ model_id: string; vectors: number[][] }>;
  capabilities(provider: string, modelId: string): ModelCapabilities;
  resolvePreset(preset: string, requires?: ModelRequest['requires'], overrides?: Record<string, string> | null, commit?: string | null): Promise<Array<{ provider: string; model_id: string }>>;
  providers(): string[];
  /** Recent fallback events for the health dashboard. */
  fallbackEvents(): Array<{ at: string; from: string; to: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Sessions & orchestrator ([02])
// ---------------------------------------------------------------------------
export interface CreateSessionInput {
  kind: SessionKind;
  circuit_uid?: string | null;
  circuit_slug?: string | null;
  config_commit?: string | null;
  task_uid?: string | null;
  parent_session?: string | null;
  parent_step_id?: string | null;
  budget: SessionBudget;
  priority?: string;
  input?: unknown;
  model_overrides?: Record<string, string> | null;
  created_by: Actor;
  state?: SessionRecord['state'];
  state_detail?: Record<string, unknown>;
}

export interface SessionFilter {
  state?: string[];
  kind?: string[];
  circuit?: string;
  task?: string;
  parent?: string;
  /** Actor id of the session's creator (`created_by->>'id'`). */
  created_by?: string;
  /** Designer chats opened on a definition (`state_detail.context.definition_uid`). */
  definition?: string;
  /** Runs on a proposal's branch (`state_detail.proposal_id`). */
  proposal?: string;
  created_after?: string;
  created_before?: string;
  /** Newest first (default) or oldest first. */
  order?: 'asc' | 'desc';
  cursor?: string | null;
  /** Offset paging: the page also carries `total` ([11] §2). */
  offset?: number | null;
  limit?: number;
}

/** A session's own spend, summed over its turns. Token budgets count all four token columns. */
export interface SessionCost {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  mustGet(id: string): Promise<SessionRecord>;
  list(f: SessionFilter): Promise<Page<SessionRecord>>;
  update(id: string, patch: Partial<Pick<SessionRecord, 'state' | 'state_detail' | 'budget' | 'config_commit' | 'started_at' | 'ended_at' | 'priority' | 'circuit_slug'>>): Promise<SessionRecord>;
  appendEvent(id: string, type: SessionEvent['event_type'], payload: Record<string, unknown>, stepId?: string | null): Promise<SessionEvent>;
  events(id: string, afterSeq?: number, limit?: number): Promise<SessionEvent[]>;
  recordTurn(t: Omit<Turn, 'turn_id' | 'created_at'> & { attempt?: number; latency_ms?: number | null; fallback_from?: string | null }): Promise<Turn>;
  turns(id: string, stepId?: string, attempt?: number): Promise<Turn[]>;
  upsertCheckpoint(cp: { session_id: string; step_id: string; attempt: number; status: 'running' | 'exited' | 'failed'; exit_name?: string | null; output?: unknown; ambient: unknown; cost_usd?: number; tokens_in?: number; tokens_out?: number; tokens_cache_read?: number; tokens_cache_write?: number; visit?: number; kind?: string; child_session_id?: string | null; error?: string | null; ended?: boolean }): Promise<void>;
  checkpoints(id: string): Promise<Array<Record<string, any>>>;
  /** Cost aggregates from turn rows (authoritative leaf) ([02] §6). */
  cost(id: string): Promise<SessionCost>;
  costIncludingChildren(id: string): Promise<number>;
  /** Batched `costIncludingChildren` for list pages. */
  costsIncludingChildren(ids: string[]): Promise<Map<string, number>>;
  children(id: string): Promise<SessionRecord[]>;
  /** Spend across all sessions within a rolling window ([02] §5.1). */
  spendSince(iso: string): Promise<number>;
  /** Sessions in `state`, optionally only of these kinds. */
  countByState(state: string, kinds?: SessionKind[]): Promise<number>;
  summary(id: string): Promise<SessionSummaryDto>;
  /** Highest-priority queued sessions, FIFO within tier. */
  nextQueued(limit: number): Promise<SessionRecord[]>;
  /** Sessions in `running` state (restart recovery). */
  running(): Promise<SessionRecord[]>;
  /** All ancestor+descendant session ids (visibility for session-scoped nodes). */
  family(id: string): Promise<string[]>;
}

export interface RunListFilter {
  circuit?: string;
  status?: string;
  /** A proposal id, or `none` for runs not made on a proposal branch. */
  proposal?: string;
  limit?: number;
}

export interface EnqueueRunInput {
  circuit_uid: string;
  input: unknown;
  task_uid?: string | null;
  parent_session?: string | null;
  parent_step_id?: string | null;
  budget?: Partial<SessionBudget> | null;
  priority?: string;
  model_overrides?: Record<string, string> | null;
  kind?: 'circuit-run' | 'eval-run';
  /** Pin a config ref (branch or commit) — eval-on-branch; default main at admission. */
  config_ref?: string | null;
  /** The proposal whose branch `config_ref` is (kept in `state_detail.proposal_id`, so its runs can be listed). */
  proposal_id?: string | null;
  created_by: Actor;
  /** Pinned context for eval fixtures. */
  pinned_context?: Array<{ uid: string; revision_id: number }> | null;
}

export interface Orchestrator {
  enqueue(input: EnqueueRunInput): Promise<SessionRecord>;
  /** Execute one admitted session to its next suspension/terminal state. */
  run(sessionId: string): Promise<SessionRecord>;
  retry(sessionId: string, by: Principal): Promise<SessionRecord>;
  cancel(sessionId: string, by: Principal, reason?: string): Promise<SessionRecord>;
  resume(sessionId: string, by: Principal, opts?: { budget?: Partial<SessionBudget> }): Promise<SessionRecord>;
  /** Skip a failed step to a chosen exit (manual routing decision, [02] §5.3). */
  manualRoute(sessionId: string, exitName: string, output: unknown, by: Principal): Promise<SessionRecord>;
  /** Record a gate verdict from a targeted reviewer; auto-resolves the gate when complete ([02] §5.4). */
  gateVerdict(input: { node_uid: string; request_id: string; verdict: 'approve' | 'request-changes'; comment?: string | null; edits?: unknown; by: Principal }): Promise<{ resolved: boolean; session_id: string }>;
  /** Wait for a session to reach a non-running, non-queued state (sub-circuit/tool composition). */
  waitFor(sessionId: string, timeoutMs?: number): Promise<SessionRecord>;
  /** Restart recovery: re-queue `running` sessions from their last checkpoint ([02] §5.2). */
  recover(): Promise<number>;
  /** Signal the dispatcher that a session became queued. */
  onQueued(fn: (sessionId: string) => void): void;
  /** Is this session actively being stepped in this process? */
  isActive(sessionId: string): boolean;
}

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  /** One dispatch pass; returns admitted session ids. */
  tick(): Promise<string[]>;
  capacity(): Promise<{ running: number; max_concurrent_runs: number; spend_last_hour_usd: number; max_spend_usd_per_hour: number; queued: number }>;
}

// ---------------------------------------------------------------------------
// Subagents ([05])
// ---------------------------------------------------------------------------
export interface ResolvedSubagent {
  uid: string;
  slug: string;
  commit: string;
  definition: Subagent;
  /** Tenets + system prompt with `{{knowledge:…}}` resolved. */
  system_prompt: string;
  /** Knowledge note revisions injected (for provenance logging). */
  injected_notes: Array<{ uid: string; revision_id: number }>;
  grants: Grants;
  model_preset: string;
}

export interface ConversationHooks {
  onTurn?(turn: { role: Turn['role']; content: unknown; model_id?: string | null; usage?: TokenUsage; cost_usd?: number; latency_ms?: number; fallback_from?: string | null; username?: string | null }): Promise<void>;
  onToolCall?(call: { name: string; input: unknown; id: string }): Promise<void>;
  onToolResult?(result: { id: string; name: string; output: unknown; is_error: boolean }): Promise<void>;
  /** Budget check between turns; throw to abort. */
  checkBudget?(): Promise<void>;
}

export interface RunConversationInput {
  subagent: ResolvedSubagent;
  principal: Principal; // the subagent's principal (grants) for primitive calls
  messages: ChatMessage[];
  /** Extra tools beyond the subagent's granted surface (e.g. the finish tool). */
  extra_tools?: ToolSpec[];
  force_tool?: string;
  /** Names of tools the loop must NOT execute but return to the caller (finish tool). */
  terminal_tools?: string[];
  max_turns?: number;
  model_overrides?: Record<string, string> | null;
  session_id: string;
  step_id: string;
  attempt: number;
  hooks?: ConversationHooks;
  /** Narrow the tool surface: step tools_override ([03] §3.1). */
  tools_override?: string[] | null;
  /** Reasoning effort for this run (an LLM step's `effort`); falls back to the subagent's. */
  effort?: Effort;
  /**
   * First tool-call index to use. A conversation continued in the same attempt (finish-tool re-ask) passes the
   * previous result's `tool_calls`, so idempotency-journal keys stay unique within the attempt ([06] §4.4).
   */
  call_index_start?: number;
}

export interface ConversationResult {
  messages: ChatMessage[];
  /** The terminal tool call that ended the conversation (finish tool), if any. */
  terminal_call: { name: string; input: unknown; id: string } | null;
  final_text: string;
  usage: TokenUsage;
  cost_usd: number;
  turns: number;
  model_ids: string[];
  /** Next unused tool-call index (`call_index_start` + tool calls executed). */
  tool_calls: number;
}

export interface SubagentRuntime {
  resolve(uid: string, commit: string, opts?: { session_id?: string | null; extra_read_domains?: string[] }): Promise<ResolvedSubagent>;
  /** Build a principal for the subagent acting within a session. */
  principalFor(resolved: ResolvedSubagent, sessionId: string, stepId: string | null, visibleSessions: string[]): Principal;
  /** The tool surface (granted extensions + MCP tools + primitives) as model tool specs. */
  toolSurface(resolved: ResolvedSubagent, override?: string[] | null): Promise<ToolSpec[]>;
  runConversation(input: RunConversationInput): Promise<ConversationResult>;
}

// ---------------------------------------------------------------------------
// Toolbox ([06])
// ---------------------------------------------------------------------------
export interface SandboxRunInput {
  language: 'typescript' | 'python';
  /** Absolute dir of the tool (materialized tree). Mounted read-only at /tool. */
  toolDir: string;
  request: RunnerRequest;
  limits: Tool['limits'];
  egress: Tool['egress'];
  execution_key: string;
  tool_uid: string;
}
export interface SandboxRunResult {
  exit_code: number;
  messages: RunnerMessage[];
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
  log_ref: string | null;
}
export interface SandboxRunner {
  readonly kind: 'docker' | 'process';
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string; warm: Record<string, number> }>;
}

export interface ToolInvocation {
  tool_uid: string;
  commit?: string | null;
  input: unknown;
  settings?: Record<string, unknown>;
  principal: Principal;
  ambient: Partial<BreadboardAmbient> & { invocation: BreadboardAmbient['invocation'] };
  /** Journal coordinates ([06] §4.4). */
  session_id?: string | null;
  step_id?: string | null;
  attempt?: number | null;
  call_index?: number | null;
  /** Nesting depth for runTool/runCircuit composition. */
  depth?: number;
  export?: 'handler' | 'list' | 'fetch';
}

export interface ToolResult {
  output: unknown;
  logs: Array<{ level: string; message: string; data?: unknown; at: string }>;
  execution_key: string;
  replayed: boolean;
  cost_units: number;
  duration_ms: number;
}

export interface Toolbox {
  invoke(inv: ToolInvocation): Promise<ToolResult>;
  /** Tools exposed externally through the Breadboard MCP server ([06] §8). */
  externalTools(ref?: string): Promise<Array<{ tool: Tool; commit: string }>>;
  /** Static CI for a tool directory on a proposal: manifest validation, TS typecheck/Python compile ([06] §6). */
  ci(toolUid: string, ref: string): Promise<ValidationReport>;
  /** Execution journal rows for a session. */
  executions(sessionId: string): Promise<Array<Record<string, unknown>>>;
}

export interface CredentialBroker {
  registerCredential(input: { name: string; kind: string; secret: Record<string, string> | string; by: Principal }): Promise<{ credential_id: string; name: string }>;
  deleteCredential(name: string, by: Principal): Promise<void>;
  listCredentials(): Promise<Array<{ credential_id: string; name: string; kind: string; created_at: string }>>;
  defineCapability(input: { name: string; credential: string | null; description?: string; scope: { hosts: string[]; methods?: string[]; path_prefixes?: string[]; scopes?: string[]; rules?: Array<{ scopes: string[]; methods?: string[]; path_prefixes?: string[] }> }; by: Principal }): Promise<{ capability_id: string; name: string }>;
  deleteCapability(name: string, by: Principal): Promise<void>;
  listCapabilities(): Promise<Array<{ capability_id: string; name: string; credential: string | null; description: string; scope: Record<string, unknown> }>>;
  /** Execute an outbound request on behalf of tool code ([12] §5): validate, attach credential, audit. */
  fetch(input: { capability: string; request: { url: string; method?: string; headers?: Record<string, string>; body?: string | null }; tool: Tool; principal: Principal; execution_key?: string | null }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** Credential material for MCP server auth ([06] §9) — internal use only, never over the API. */
  credentialFor(capability: string): Promise<Record<string, string> | null>;
  /**
   * Authenticate a repository mirror's git fetch ([06] §7.1): check `url` against the capability's scope, pass the
   * auth headers (CodeCommit's SigV4 password for AWS credentials) to `fn`, and audit the outcome. Internal only.
   */
  withRepoAuth<T>(input: { capability: string; url: string; principal: Principal }, fn: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  audit(limit?: number): Promise<Array<Record<string, unknown>>>;
}

/** A repository mirror's state ([06] §7.1). */
export interface RepoMirrorStatus {
  name: string;
  description: string;
  url: string;
  branch: string;
  phase: 'absent' | 'cloning' | 'ready' | 'failed';
  commit: string | null;
  fetched_at: string | null;
  last_attempt_at: string | null;
  fetching: boolean;
  /** The last fetch failed; searches answer from `commit`. */
  stale: boolean;
  last_error: string | null;
}

export interface RepoSearchInput {
  repo?: string;
  pattern: string;
  regex?: boolean;
  ignore_case?: boolean;
  word?: boolean;
  paths?: string[];
  exclude?: string[];
  context?: number;
  max_results?: number;
  max_per_file?: number;
  files_only?: boolean;
  commit?: string;
  max_chars?: number;
}

export interface RepoReadInput {
  repo?: string;
  path?: string;
  commit?: string;
  start_line?: number;
  end_line?: number;
  raw?: boolean;
  max_chars?: number;
}

/** Server-side git mirrors behind `search_repo` / `read_repo_file` ([06] §7.1). */
export interface RepoMirrors {
  start(): void;
  stop(): Promise<void>;
  /** Mirrors `by` may read (all of them when omitted). */
  status(by?: Principal): Promise<RepoMirrorStatus[]>;
  search(input: RepoSearchInput, by: Principal): Promise<Record<string, unknown>>;
  read(input: RepoReadInput, by: Principal): Promise<Record<string, unknown>>;
}

export interface McpClientManager {
  /** Tool specs offered by an onboarded server (filtered by its default allowlist and the grant allowlist). */
  tools(serverUid: string, allow: string[] | null, ref?: string): Promise<ToolSpec[]>;
  call(serverUid: string, toolName: string, args: unknown, ref?: string): Promise<{ content: string; is_error: boolean; raw: unknown }>;
  stop(): Promise<void>;
}

/** The closed set of Breadboard primitives — one implementation behind REST, MCP, and in-process tool loops. */
export interface Primitives {
  readonly names: readonly string[];
  spec(name: string): ToolSpec;
  call(name: string, args: unknown, principal: Principal, ctx?: { session_id?: string | null; step_id?: string | null; attempt?: number | null; call_index?: number | null; depth?: number }): Promise<unknown>;
  /** Specs for the names a principal may call. */
  specsFor(principal: Principal): ToolSpec[];
}

// ---------------------------------------------------------------------------
// Knowledge ([07])
// ---------------------------------------------------------------------------
export interface NoteRead {
  uid: string;
  title: string;
  markdown: string;
  base_revision: number;
  domains: string[];
  read_only: boolean;
  tags: string[];
  properties: Record<string, unknown>;
}
export interface NoteEditResult {
  applied: boolean;
  had_concurrent_edits: boolean;
  merged_markdown: string;
  new_head_revision: number;
  pre_ai_edit_revision: number;
  blocks_changed: number;
}
/** `createNote` result: the stored node plus its first revision (a `propose_note_edit` base) and AI-create dedup hits. */
export type CreatedNote = NodeRecord & { revision_id: number; possible_duplicates: Array<{ uid: string; title: string; score: number }> };
export interface KnowledgeSearchHit {
  uid: string;
  title: string;
  snippet: string;
  score: number;
  domains: string[];
  tags: string[];
  source: 'text' | 'semantic' | 'hybrid';
}

export interface KnowledgeService {
  /** AI callers must write every listed domain; the note is tagged `origin:<kind>`, deduped ([08] §4 style) and, from a session step, linked by a `produces` edge. */
  createNote(input: { title: string; markdown: string; domains?: string[]; tags?: string[]; properties?: Record<string, unknown>; by: Principal; scope?: Scope; session_id?: string | null; step_id?: string | null }): Promise<CreatedNote>;
  /** `read_note` contract ([07] §5.2 step 1): rendered markdown + base_revision (cut on demand). */
  readNote(uid: string, by: Principal): Promise<NoteRead>;
  /** `propose_note_edit`: the three-way reconcile path ([07] §5.2). */
  proposeEdit(input: { uid: string; base_revision: number; markdown: string; by: Principal; session_id?: string | null; step_id?: string | null }): Promise<NoteEditResult>;
  revertAiEdit(input: { uid: string; pre_ai_edit_revision: number; by: Principal }): Promise<{ new_head_revision: number }>;
  search(input: { q: string; mode?: 'text' | 'semantic' | 'hybrid'; domains?: string[]; limit?: number; by: Principal; types?: string[] }): Promise<KnowledgeSearchHit[]>;
  /** Current markdown of any CRDT node's head (used by body_text mirror, viewers, templates). */
  markdownOf(uid: string): Promise<string>;
  /** Replace a document's body wholesale with a server-origin transaction (connector sync, restore). */
  replaceBody(input: { uid: string; markdown: string; by: Actor; label: NodeRevision['labels'][number] }): Promise<{ revision: number }>;
  /** Deterministic injection ([07] §4): notes matching configured rules for the given text. */
  injectionsFor(text: string, readableDomains: string[] | null): Promise<Array<{ uid: string; title: string; revision_id: number; markdown: string; rule: string }>>;
  /** Per-block attribution map for the editor. */
  attribution(uid: string): Promise<Record<string, { actor: Actor; at: string }>>;
  domains(): Promise<Array<{ slug: string; description: string; note_count: number }>>;
  /** Refresh embeddings for a node (debounced by the caller). */
  reindexEmbeddings(uid: string): Promise<void>;
  /** Compaction pass for one node or all ([07] §6). */
  compact(uid?: string): Promise<number>;
  /** Restore a prior revision as a new forward revision. */
  restoreRevision(input: { uid: string; revision_id: number; by: Principal }): Promise<{ new_head_revision: number }>;
}

export interface SyncServer {
  /** Attach the Yjs WebSocket endpoint (`/api/v1/sync`) to the Fastify app. */
  register(app: import('fastify').FastifyInstance): Promise<void>;
  /** Server-side access to the live Y.Doc for a node (authority process). */
  openDoc(uid: string): Promise<import('yjs').Doc>;
  /** Apply a server-origin update/transaction to a live doc and persist it. */
  transact(uid: string, origin: Actor & { session_id?: string }, fn: (doc: import('yjs').Doc) => void): Promise<void>;
  onChange(fn: (uid: string, origin: unknown) => void): () => void;
  stop(): Promise<void>;
}

export interface ConnectorScheduler {
  start(): void;
  stop(): Promise<void>;
  syncNow(toolUid: string, by: Principal): Promise<{ fetched: number; updated: number; errors: string[] }>;
  status(): Promise<Array<{ tool_uid: string; slug: string; last_sync_at: string | null; last_error: string | null; running: boolean; doc_count: number; schedule_minutes: number }>>;
}

// ---------------------------------------------------------------------------
// Intake ([08]) & Content ([09])
// ---------------------------------------------------------------------------
export interface TaskService {
  create(input: { title: string; body: string; priority?: string; target_circuit?: string | null; draft?: boolean; tags?: string[]; budget?: Partial<SessionBudget> | null; by: Principal; session_id?: string | null }): Promise<NodeDto>;
  accept(uid: string, by: Principal): Promise<NodeDto>;
  reject(uid: string, by: Principal, reason?: string): Promise<NodeDto>;
  promote(uid: string, by: Principal, priority?: string): Promise<NodeDto>;
  markReviewed(uid: string, by: Principal): Promise<NodeDto>;
  discard(uid: string, by: Principal): Promise<void>;
  /** Orchestrator-driven status transitions. */
  setStatus(uid: string, status: string, by: Actor, detail?: Record<string, unknown>): Promise<void>;
  similar(q: string, by: Principal, limit?: number): Promise<Array<{ uid: string; title: string; status: string; score: number }>>;
  list(filter: Record<string, unknown>, by: Principal): Promise<Page<NodeDto & { queue_age_s: number | null }>>;
  /** Dispatch pass: enqueue circuit runs for `queued` tasks whose dependencies are done ([08] §3). */
  dispatchQueued(): Promise<string[]>;
  /** Auto-archive abandoned drafts ([08] §10.1). */
  archiveStaleDrafts(): Promise<number>;
}

export interface ContentService {
  nodeDto(node: NodeRecord): Promise<NodeDto>;
  getNode(uid: string, by: Principal): Promise<NodeDto>;
  listNodes(filter: Record<string, unknown>, by: Principal): Promise<Page<NodeDto>>;
  createNode(input: { type: string; title?: string; properties?: Record<string, unknown>; body?: unknown; tags?: string[]; scope?: Scope; crdt?: boolean; by: Principal; derived_from?: ArtifactRef[]; session_id?: string | null; step_id?: string | null }): Promise<NodeDto>;
  patchNode(uid: string, patch: Record<string, unknown>, by: Principal): Promise<NodeDto>;
  deleteNode(uid: string, by: Principal): Promise<void>;
  createArtifact(input: { title: string; body: string | object; tags?: string[]; scope?: Scope; properties?: Record<string, unknown>; derived_from?: ArtifactRef[]; by: Principal; session_id?: string | null; step_id?: string | null }): Promise<ArtifactRef & { node: NodeDto }>;
  updateArtifact(input: { uid: string; body?: string | object; title?: string; properties?: Record<string, unknown>; tags_add?: string[]; tags_remove?: string[]; by: Principal; session_id?: string | null; step_id?: string | null }): Promise<ArtifactRef & { node: NodeDto }>;
  cutRevision(uid: string, labels: NodeRevision['labels'], by: Actor): Promise<NodeRevision>;
  revisions(uid: string, by: Principal, opts?: { limit?: number; before?: number }): Promise<NodeRevision[]>;
  revision(uid: string, rev: number, by: Principal): Promise<NodeRevision>;
  edges(uid: string, by: Principal, opts?: { direction?: 'in' | 'out' | 'both'; type?: string[] }): Promise<EdgeRecord[]>;
  emitEdge(input: { type: string; src: string; dst: string; dst_revision?: number | null; properties?: Record<string, unknown>; by: Principal }): Promise<EdgeRecord>;
  retractEdge(edgeId: number, by: Principal): Promise<EdgeRecord>;
  lineage(uid: string, direction: 'up' | 'down', depth: number, by: Principal): Promise<LineageDto>;
  addComment(input: { target: string; body: string; anchor?: { revision?: number | null; quote: string; context?: string | null } | null; by: Principal; session_id?: string | null; step_id?: string | null }): Promise<NodeDto & { anchor_status: 'resolved' | 'stale' | 'none' }>;
  comments(uid: string, by: Principal): Promise<Array<NodeDto & { stale: boolean; anchor_status: string }>>;
  tagNeedInput(input: { uid: string; role?: string | null; username?: string | null; prompt?: string | null; by: Principal; gate?: { session_id: string; step_id: string } | null }): Promise<NeedInputRequest>;
  resolveNeedInput(input: { uid: string; request_id: string; by: Principal; verdict?: 'approve' | 'request-changes' | null; comment?: string | null }): Promise<{ resolved: NeedInputRequest; remaining_open: number }>;
  reviewQueue(by: Principal, opts?: { limit?: number }): Promise<ReviewQueueItemDto[]>;
  reviewCount(by: Principal): Promise<number>;
  /** need-input rate health metric ([09] §3.1). */
  healthMetric(opts?: { days?: number }): Promise<{ series: Array<{ day: string; requests: number; deliverables: number; rate: number }>; by_circuit: Array<{ circuit_uid: string | null; requests: number; deliverables: number; rate: number }> }>;
  /** Re-anchor a quote against the current head: content-based, never guesses ([07] §5.4). */
  resolveAnchor(uid: string, quote: string, context?: string | null): Promise<{ status: 'resolved' | 'not_found' | 'ambiguous' | 'unmappable'; block_id?: string; offset?: number }>;
}

// ---------------------------------------------------------------------------
// Evals ([04])
// ---------------------------------------------------------------------------
export interface EvalService {
  startRun(input: { circuit: string; ref?: string | null; fixture_tags?: string[] | null; model_overrides?: Record<string, string> | null; by: Principal; proposal_id?: string | null; wait?: boolean }): Promise<Record<string, unknown>>;
  getRun(id: string): Promise<Record<string, unknown>>;
  listRuns(opts?: RunListFilter): Promise<Array<Record<string, unknown>>>;
  /** `listRuns` with offset paging and a `total` ([11] §2). */
  pageRuns(opts?: RunListFilter & { offset?: number }): Promise<{ items: Array<Record<string, unknown>>; total: number }>;
  analysis(circuitUid: string, view: 'model-regression' | 'cheapest-model' | 'circuit-regression' | 'trend' | 'dashboard', opts?: { base?: string; head?: string; circuit_commit?: string; variant?: string }): Promise<Record<string, unknown>>;
  recordScore(input: { eval_run_id: string; fixture_id: string; dimension: string; value: unknown; rationale?: string | null; by: Principal }): Promise<void>;
  getFixtureOutput(evalRunId: string, fixtureId: string): Promise<unknown>;
  promoteFixture(input: { session_id: string; fixture_title: string; tags?: string[]; notes?: string; by: Principal }): Promise<{ fixture_id: string; commit: string }>;
  dashboard(): Promise<Record<string, unknown>>;
  /** Restart recovery: resume runs still `running` (fixtures may be waiting on hard gates). */
  recover(): Promise<number>;
  /** Shutdown: stop waiting on gated fixtures; their runs resume via `recover()`. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Conversations ([08] §4, [10] §4)
// ---------------------------------------------------------------------------
export interface ConversationService {
  start(input: { kind: 'intake' | 'conversation'; subagent_uid?: string | null; context?: Record<string, unknown>; by: Principal; title?: string }): Promise<SessionRecord>;
  /** Post a user message and run the subagent to its reply. Returns the assistant turn(s). */
  post(input: { session_id: string; text: string; by: Principal; context?: Record<string, unknown> }): Promise<{ turns: Turn[]; draft_task?: Record<string, unknown> | null; proposals?: string[] }>;
  /** Accept a user message and run the reply in the background (validation errors still throw). */
  submit(input: { session_id: string; text: string; by: Principal; context?: Record<string, unknown> }): Promise<{ accepted: true; session_id: string }>;
  /** True while a posted message is queued or its reply is running (this server process). */
  busy(sessionId: string): boolean;
  /** Config proposals opened in the session, oldest first. */
  proposals(sessionId: string): Promise<string[]>;
  turns(sessionId: string, by: Principal): Promise<Turn[]>;
  /** `definition_uid`: designer chats opened on that definition; `mine`: only the caller's own. */
  list(input: { kind?: 'intake' | 'conversation'; by: Principal; limit?: number; definition_uid?: string; mine?: boolean }): Promise<SessionRecord[]>;
  /** `list` newest first with offset paging and a `total` (no own-first ordering). */
  page(input: { kind?: 'intake' | 'conversation'; by: Principal; limit?: number; offset?: number; definition_uid?: string; mine?: boolean }): Promise<{ items: SessionRecord[]; total: number }>;
  /** Draft task panel state for an intake conversation ([08] §7.1). */
  draftTask(sessionId: string): Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------------------
// Auth ([12] §3)
// ---------------------------------------------------------------------------
export interface AuthService {
  /** Resolve a bearer token to a Principal; throws `unauthorized`. */
  authenticate(token: string | null | undefined): Promise<Principal>;
  /** Mint a user session token (after local-token or OIDC login). */
  mintUserToken(user: UserRecord, ttlSeconds?: number): Promise<string>;
  /** Short-lived internal actor token for a sandbox execution/subagent ([12] §3). */
  mintActorToken(input: { principal: Principal; ttlSeconds: number; execution_key?: string | null }): Promise<string>;
  /** Local-dev login: static token → user. */
  loginLocal(token: string): Promise<{ user: UserRecord; session_token: string } | null>;
  oidc: {
    enabled(): boolean;
    authorizationUrl(state: string, nonce: string): Promise<string>;
    callback(params: Record<string, string>, expected: { state: string; nonce: string }): Promise<{ user: UserRecord; session_token: string }>;
  };
  /** Ensure static local users exist as `users` rows ([12] §3). */
  syncLocalUsers(): Promise<void>;
  /**
   * The principal an authenticating edge vouches for ([12] §3), else null: the load balancer's verified identity
   * header, else the trusted-proxy user when the headers carry the proxy secret; never for another site's request.
   * Throws `unauthorized` when a load-balancer header does not verify, or the user it names is deactivated.
   */
  proxyPrincipal?(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<Principal | null>;
  principalForUser(user: UserRecord): Promise<Principal>;
  /** Drop cached principals (after a revocation or deactivation). */
  invalidate?(): void;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------
export interface Services {
  env: Env;
  log: Logger;
  db: Db;
  team_id: string;
  objects: ObjectStore;
  identity: IdentityStore;
  nodes: NodeStore;
  edges: EdgeStore;
  graph: GraphQueries;
  linkIndexer: LinkIndexer;
  configRepo: ConfigRepo;
  config: ConfigService;
  events: EventBus;
  auth: AuthService;
  gateway: ModelGateway;
  sessions: SessionStore;
  orchestrator: Orchestrator;
  dispatcher: Dispatcher;
  subagents: SubagentRuntime;
  toolbox: Toolbox;
  sandbox: SandboxRunner;
  broker: CredentialBroker;
  mcpClients: McpClientManager;
  primitives: Primitives;
  knowledge: KnowledgeService;
  sync: SyncServer;
  connectors: ConnectorScheduler;
  mirrors: RepoMirrors;
  tasks: TaskService;
  content: ContentService;
  evals: EvalService;
  conversations: ConversationService;
  /** Public base URL for callbacks from sandboxes. */
  publicUrl: string;
}

export type { Grants, Principal, UserRecord, Page };
