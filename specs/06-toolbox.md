# 06 — Toolbox

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** [05 — Subagents](05-subagents.md) (access config), [03 — Circuits](03-circuits.md) (code steps), [12 — Security & Deployment](12-security-deployment.md) (broker, sandbox posture)

---

## 1. Purpose & principles

The Toolbox equips Subagents across the Breadboard with a mix of **tool extensions** (built directly within Breadboard) and **centrally onboarded MCP servers**. Access to and configuration of each tool varies by context (per Subagent, per Circuit step).

- **Don't build an MCP server for simple functionality.** Users (and AI) create custom tools inside Breadboard — TypeScript or Python — to standardize functionality and behavior, with the code maintained in the config plane and edited in the browser.
- **Versioned like everything else.** Tool code is version controlled; each execution records the tool version, so inspecting a historical Session tells you precisely what tooling code ran.
- **Isolated by default.** Tool execution runs in per-execution containers with genuine isolation, resource limits, and default-deny egress — all declared in the tool definition and therefore reviewable in any change diff.
- **Tools hold no credentials.** All credentialed actions go through a broker service enforcing policy per capability declaration.

## 2. Tool extensions

A tool extension is a directory in the config repo: `config/tools/<uid>/` with a `tool.yaml` manifest and `src/`.

```yaml
# config/tools/01J8TOOL0CHKCITATION0/tool.yaml
schema: breadboard/tool@v1
uid: 01J8TOOL0CHKCITATION0      # permanent config UID ([01] §6.2); names the directory
slug: check-citations           # display metadata only; renames never move files
title: Citation checker
description: Verifies that every citation in an artifact resolves to a content node.
language: typescript            # typescript | python
entrypoint: src/index.ts        # exports handler(input, ctx)

input:                          # JSON Schema for the tool's parameters
  type: object
  required: [artifact]
  properties:
    artifact: { type: string, description: "Artifact UID" }
output:
  type: object
  required: [ok, missing]
  properties:
    ok:      { type: boolean }
    missing: { type: array, items: { type: string } }

settings:                       # per-grant configurable knobs (05-subagents.md §2.2)
  strict:
    type: boolean
    default: false
    hidden: false               # hidden: true => enforced server-side, invisible to model

limits:                         # enforced by the runtime; visible in every diff
  timeout_s: 120                # wall-clock
  memory_mb: 512
  max_cost_units: 10            # per-run aggregate execution budget contribution

egress:                         # default-deny; explicit allowlist
  allow:
    - host: api.crossref.org
      ports: [443]

capabilities:                   # credentialed actions via the broker (12-security-deployment.md §5)
  - name: crossref-api
    scope: read

exposure:
  external_mcp: false           # opt-in: expose via the Breadboard MCP server (§8)
```

### 2.1 Runtime contract

The entrypoint exports a single handler:

```ts
// TypeScript
export async function handler(input: Input, ctx: BreadboardContext): Promise<Output | StepResult>
```
```python
# Python
def handler(input: dict, ctx: BreadboardContext) -> dict
```

`BreadboardContext` provides the **Breadboard primitives** (§7): content read/write, edge emission, circuit invocation, tool invocation, broker-mediated fetch, model turns through the gateway, logging, and the ambient channel (Session ID, step ID, budget remaining). When invoked as a circuit **code step**, the handler returns `{ exit, output }` ([03](03-circuits.md) §3.2); when invoked as an LLM's tool call, it returns just the output payload.

### 2.2 Composability

Tools are highly composable: within their logic they may call **circuits** (`ctx.runCircuit(uid, input)` → child Session, subject to grants) or **other tools** (`ctx.runTool(uid, input)` → nested sandboxed execution, sharing the parent execution's budget). References are by config UID ([01](01-data-model.md) §6.2). Cycles are cut by a nesting-depth cap (default 8).

## 3. Pre-packaged tools

Breadboard ships with built-in tool extensions (same manifest format, maintained in the Breadboard distribution and copied into new config repos where teams may fork them):

- **`spawn-harness`** — the notable one: spawn a **sub-harness** to tackle coding-heavy tasks, with **Breadboard operating as the "user"** for the sub-harness. Runs the harness in a sandbox container against a workspace (e.g., a repo checkout), streams the harness transcript into the Session log as a code-step log, and captures declared outputs as Artifacts. This lets Breadboard leverage other harnesses' specialization while remaining the primary harness across circuits.
  - **v1 adapter: [Strands Agents](https://strandsagents.com/)** (open-source AWS agent SDK). Being open source, the adapter can integrate at the SDK level rather than scraping a CLI: the sandbox runs a thin Strands driver script that constructs the agent, feeds it the step's task prompt as the user, forwards its event stream (turns, tool calls, results) into the Session log, and maps declared outputs to Artifacts. The driver gives Strands a model provider backed by `ctx.converse` (§7), so every model turn the harness makes goes through the Breadboard model gateway: it resolves the tool's `preset` setting (default `medium`) with fallback, counts against the Session's budget, and appears in the Session's cost like any LLM step. The sandbox holds no model-provider credentials, and the manifest's egress allowlist covers only the workspace clone. Verified live 2026-10-01: an implement step ran Strands in the sandbox with its turns recorded on the session.
  - **Second adapter: [Strands Harness](https://strandsagents.com/blog/introducing-strands-harness/)** (`harness: strands-harness`; `strands` stays the default until eval comparisons favour it). The same driver builds `create_harness(...)` instead of a bare `Agent`: the harness's shell/read/write/edit tools, context management (tool-result offloading, compaction), todo tracking and helper subagent run in the sandbox against the workspace, while the features Breadboard already owns are off — long-term memory (Knowledge is the durable memory, and the container is discarded), sessions (the step boundary is the unit of durability), skills, interventions (gates and `need-input` do this at circuit level), web tools (egress is default-deny), and the harness's own prompt caching (the gateway places cache points). The model is the same gateway-backed provider; it replays reasoning blocks verbatim and passes the tool's `effort` setting. The harness's agent contract ships in the pinned `strands-harness` package, so the pin is part of what a run used.
  - Other harnesses (e.g., Claude Code) are future adapters behind the same `spawn-harness` manifest; the adapter is a per-harness `src/` implementation, not a new tool.
- **Content primitives** — `create_artifact`, `update_artifact`, `add_comment`, `emit_edge`, `tag_need_input` (§7).
- **Knowledge primitives** — `query_knowledge` (text + RAG), `read_note`, `propose_note_edit` (the reconcile path, [07](07-knowledge.md) §5).
- **Intake primitives** — `create_task`, `find_similar_tasks` ([08](08-intake.md) §6).
- **Session primitives** — `run_circuit`, `get_session_summary`.
- **Eval primitives** — `record_score`, `get_rubric` ([04](04-evals.md) §5).
- **Config-editing tools** (used by designer chat panels): `propose_config_change` (writes a branch + opens a review), `read_config`, `search_config`, `validate_config`. `read_config` takes a UID, a slug (or `<kind>:<slug>` when kinds share one), or a repo path, and a miss lists the closest definitions; `search_config` finds definitions by slug, title, UID or path and returns metadata only, so an agent can get the UID that references need ([01](01-data-model.md) §6.2).

## 4. Execution runtime

- **Per-execution containers with warm pools.** Each tool execution gets a fresh container (Docker in v1); warm pools per language image keep latency acceptable — pools hold **pre-started but never-used** containers only; a container is never returned to the pool after executing user code. No state persists between executions except through Breadboard primitives.
- **Resource limits enforced by the runtime, declared in the manifest:** wall-clock timeout, memory cap, and a per-run aggregate execution budget (`max_cost_units` contributions are summed per Session against a circuit-configurable ceiling).
- **Network egress is default-deny, enforced via an egress proxy** ([12](12-security-deployment.md) §6): containers sit on an internal-only network whose sole route out is an HTTP(S) proxy that enforces the per-execution allowlist compiled from the tool manifest, logging every call. Non-HTTP protocols are simply blocked. The broker endpoint and the Breadboard API are the only implicit destinations.
- **No credentials in the container** — see §5.

### 4.4 Idempotency journal

Every tool execution is journaled (`tool_executions` table: execution key = `session_id + step_id + attempt + call-index`, tool UID + commit, input hash, status, output ref). On orchestrator replay ([02](02-sessions-orchestrator.md) §5.2), a completed execution key returns its journaled output instead of re-executing — making step replay safe for side-effecting tools.

## 5. Credential broker

Tools hold no credentials directly. All credentialed actions go through a **broker service** that holds the credentials and enforces policy per tool **capability declaration**:

- A capability (`crossref-api` above) names a credential + allowed scope configured by an admin in the broker ([12](12-security-deployment.md) §5).
- Inside the sandbox, `ctx.fetch(capability, request)` sends the request to the broker; the broker validates the tool's declared capability + scope, attaches the credential, executes, and returns the response. The credential never enters the container.
- Broker calls are logged (tool, session, capability, target) for audit.
- **One capability name is reserved: `model`.** It names no credential. A tool declaring it may call `ctx.converse` (§7); the model gateway grants it, not the broker, so admins never register it. It is the only sanctioned way for tool code to call a model: provider credentials and provider endpoints in `egress.allow` are both the wrong tool.

## 6. AI access to tool code

- By default, **Subagents have read-only access to the code behind each tool extension** — enabling them to deep-dive tooling issues and propose changes/improvements.
- **AI-proposed changes are written to a branch and surfaced as a reviewable diff; humans merge.** This also allows CI (type-check, tests, manifest validation) and evals to run against proposed tool changes before they land ([04](04-evals.md) §7).
- **v1 tool CI** is manifest validation plus a syntax check (TypeScript type stripping, Python `ast.parse`) for every tool a proposal touches, at its head commit (`GET /config/proposals/:id/checks`, [11](11-api-mcp.md) §3). The review page and the proposal card show it ([10](10-ui.md) §4), and `propose_config_change` returns it to the designer as `tool_checks` so it can amend before handing over. Type-checking and tests are not run yet.

## 7. Breadboard primitives

The closed set of built-in operations available to tool code via `ctx` (and mirrored as MCP tools for LLM steps — [11 — API & MCP](11-api-mcp.md) §4). Notable contracts:

- `emit_edge({type, src, dst, dst_revision?})` — the Toolbox primitive by which Subagents explicitly emit `derived-from` / `attached-to` / `blocks` / `depends-on` / `references` edges ([01](01-data-model.md) §4.3). `produces`/`updates` are never emitted manually — the orchestrator owns those.
- All primitives run under the **calling Subagent's grants** — a tool cannot read a Knowledge Domain its caller can't.
- The **inspection primitives** ([11](11-api-mcp.md) §4: `list_sessions`, `read_session_transcript`, `read_session_events`, `list_session_executions`, `search_nodes`, `inspect_node`, `get_config_history`, `list_proposals`, `read_proposal`, `diff_config`, …) are read-only and part of the same catalog: a Subagent sees them only when its `primitives` grant lists them (a designer that should learn from real runs, for instance), and they enforce session visibility and knowledge grants like every other read.
- `model_converse({messages, system?, tools?, preset?, model_id?, max_tokens?, temperature?, effort?, force_tool?})` (`ctx.converse`) — one model turn through the model gateway ([12](12-security-deployment.md) §7), for tool code only: it is never offered to a model directly or over MCP, and the calling tool must declare the reserved `model` capability (§5). Messages, tool definitions, and the reply use Breadboard's chat format (text, `tool_use`, `tool_result`, `reasoning` blocks; pass `reasoning` blocks back unchanged on the next turn), so the gateway's preset resolution, fallback walking, prompt caching, and the Session's `model_overrides` apply. `effort` is the reasoning effort; `force_tool` makes the model call a tool (forced where the model allows it, an instruction otherwise). The reply's usage carries prompt-cache reads/writes. The call needs a Session, is refused once the Session's cost or token budget is spent, and is recorded as a turn on the calling step (model, tokens, cost, fallback), so sandboxed model use is visible and accounted exactly like an LLM step's.

## 8. External exposure

Each tool extension may **opt in** (`exposure.external_mcp: true`) to being exposed outside the Breadboard via the Breadboard MCP server ([11](11-api-mcp.md) §4). This lets teams leverage shared tooling from their local harness setups (e.g., Claude Code on a laptop) without replicating functionality in a separate MCP server. External calls authenticate as a user and run under that user's permissions, in the same sandbox with the same limits.

## 9. MCP server onboarding

Central onboarding simplifies configuration: each distinct MCP server is onboarded **once** per Breadboard (`config/mcp/<uid>.yaml` — endpoint/command, transport, auth via a broker capability, default tool allowlist). Access then propagates to Subagents via their config grants ([05](05-subagents.md) §2.2), optionally narrowed per grant. MCP tool calls are logged in Session turns like any tool call; MCP servers run outside the sandbox but their credentials still live in the broker.

## 10. UI

- **Toolbox inventory:** searchable list of all tool extensions and onboarded MCP servers. From here users modify MCP configurations, onboard new MCP servers, or jump into the Tool editor for extensions.
- **Tool editor:** a browser-based code editor (CodeMirror 6) over the tool's directory — manifest + source, TypeScript and Python. Diff/commit flow against the config repo; version history with revert.
  - **Designer chat panel** — always visible: tool-designer Subagents with tool-editing context, propose-review-commit ([10 — UI](10-ui.md) §4), minimizing manual code editing.
  - Manifest lint surfaces limit/egress/capability changes prominently (they're the security-relevant part of any diff).
  - An **open-proposals badge** in the header (and on the tool's inventory row) leads to the review page of any proposal changing the tool ([10](10-ui.md) §4).

## 11. v1 cutline

**In:** `tool@v1` manifest; TS + Python runtimes; Docker sandbox with warm pools, limits, default-deny egress; credential broker integration; idempotency journal; pre-packaged tool set (incl. `spawn-harness` with Strands Agents and Strands Harness adapters); read-only AI code access + branch proposals; MCP onboarding; external MCP exposure; inventory + editor UI.

**Out (future):** additional languages; long-running/daemon tools; tool-level caching layer; per-tool telemetry dashboards; harness adapters beyond Strands (e.g., Claude Code).

## 12. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Warm-pool poisoning.** **Decided:** pools hold *pre-started but unused* containers only — a container is never returned to the pool after executing (§4).
2. **`max_cost_units` calibration.** **Decided:** units stay abstract in v1 (1 unit ≈ 1 CPU-minute guidance); real metering is future work.
3. **First `spawn-harness` adapter.** **Decided 2026-09-30:** Strands Agents (§3), replacing the earlier Claude Code choice — it is open source, so the adapter integrates at the SDK level (event stream, tool calls, outputs) instead of wrapping a closed CLI, and it defaults to Bedrock. Claude Code and others are future adapters.

*(Decided 2026-10-01, during the first live run.)*

4. **Model calls from tool code.** **Decided:** through the gateway, via `model_converse` / `ctx.converse` under the reserved `model` capability (§5, §7), never through provider credentials or a provider endpoint in the sandbox's egress allowlist. Before this, `spawn-harness` declared a Bedrock egress host and region settings, which would have needed AWS credentials inside the container, and the harness's spend never reached the Session.

*(Decided 2026-10-15.)*

5. **Strands Harness.** **Decided:** a second `spawn-harness` adapter, not a replacement for the Subagent tool loop. Inside the sandbox it adds what the hand-built Strands driver lacked (an edit tool, context management, todos, a helper subagent); as the core loop its value would mostly be switched off or duplicated (sandbox, Knowledge, event-sourced Sessions, gates, presets), and the loop that records every turn, journals every tool call, and enforces budgets is what Breadboard is meant to own. The efficiency it brings (prompt caching, reasoning replay) went into the gateway instead, so every step type gets it ([12](12-security-deployment.md) §7).
