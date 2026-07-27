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

A tool extension is a directory in the config repo: `config/tools/<slug>/` with a `tool.yaml` manifest and `src/`.

```yaml
# config/tools/check-citations/tool.yaml
schema: breadboard/tool@v1
slug: check-citations
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

`BreadboardContext` provides the **Breadboard primitives** (§7): content read/write, edge emission, circuit invocation, tool invocation, broker-mediated fetch, logging, and the ambient channel (Session ID, step ID, budget remaining). When invoked as a circuit **code step**, the handler returns `{ exit, output }` ([03](03-circuits.md) §3.2); when invoked as an LLM's tool call, it returns just the output payload.

### 2.2 Composability

Tools are highly composable: within their logic they may call **circuits** (`ctx.runCircuit(slug, input)` → child Session, subject to grants) or **other tools** (`ctx.runTool(slug, input)` → nested sandboxed execution, sharing the parent execution's budget). Cycles are cut by a nesting-depth cap (default 8).

## 3. Pre-packaged tools

Breadboard ships with built-in tool extensions (same manifest format, maintained in the Breadboard distribution and copied into new config repos where teams may fork them):

- **`spawn-harness`** — the notable one: spawn a **sub-harness** (e.g., Claude Code) to tackle coding-heavy tasks, with **Breadboard operating as the "user"** for the sub-harness. Runs the harness CLI in a sandbox container against a workspace (e.g., a repo checkout), streams the harness transcript into the Session log as a code-step log, and captures declared outputs as Artifacts. This lets Breadboard leverage other harnesses' specialization while remaining the primary harness across circuits.
- **Content primitives** — `create_artifact`, `update_artifact`, `add_comment`, `emit_edge`, `tag_need_input` (§7).
- **Knowledge primitives** — `query_knowledge` (text + RAG), `read_note`, `propose_note_edit` (the reconcile path, [07](07-knowledge.md) §5).
- **Intake primitives** — `create_task`, `find_similar_tasks` ([08](08-intake.md) §6).
- **Session primitives** — `run_circuit`, `get_session_summary`.
- **Eval primitives** — `record_score`, `get_rubric` ([04](04-evals.md) §5).
- **Config-editing tools** (used by designer chat panels): `propose_config_change` (writes a branch + opens a review), `read_config`, `validate_config`.

## 4. Execution runtime

- **Per-execution containers with warm pools.** Each tool execution gets a fresh container (Docker in v1); warm pools per language image keep latency acceptable. No state persists between executions except through Breadboard primitives.
- **Resource limits enforced by the runtime, declared in the manifest:** wall-clock timeout, memory cap, and a per-run aggregate execution budget (`max_cost_units` contributions are summed per Session against a circuit-configurable ceiling).
- **Network egress is default-deny** with the per-tool allowlist applied at the container network layer. The broker endpoint and the Breadboard API are the only implicit destinations.
- **No credentials in the container** — see §5.

### 4.4 Idempotency journal

Every tool execution is journaled (`tool_executions` table: execution key = `session_id + step_id + attempt + call-index`, tool slug + commit, input hash, status, output ref). On orchestrator replay ([02](02-sessions-orchestrator.md) §5.2), a completed execution key returns its journaled output instead of re-executing — making step replay safe for side-effecting tools.

## 5. Credential broker

Tools hold no credentials directly. All credentialed actions go through a **broker service** that holds the credentials and enforces policy per tool **capability declaration**:

- A capability (`crossref-api` above) names a credential + allowed scope configured by an admin in the broker ([12](12-security-deployment.md) §5).
- Inside the sandbox, `ctx.fetch(capability, request)` sends the request to the broker; the broker validates the tool's declared capability + scope, attaches the credential, executes, and returns the response. The credential never enters the container.
- Broker calls are logged (tool, session, capability, target) for audit.

## 6. AI access to tool code

- By default, **Subagents have read-only access to the code behind each tool extension** — enabling them to deep-dive tooling issues and propose changes/improvements.
- **AI-proposed changes are written to a branch and surfaced as a reviewable diff; humans merge.** This also allows CI (type-check, tests, manifest validation) and evals to run against proposed tool changes before they land ([04](04-evals.md) §7).

## 7. Breadboard primitives

The closed set of built-in operations available to tool code via `ctx` (and mirrored as MCP tools for LLM steps — [11 — API & MCP](11-api-mcp.md) §4). Notable contracts:

- `emit_edge({type, src, dst, dst_revision?})` — the Toolbox primitive by which Subagents explicitly emit `derived-from` / `attached-to` / `blocks` / `depends-on` / `references` edges ([01](01-data-model.md) §4.3). `produces`/`updates` are never emitted manually — the orchestrator owns those.
- All primitives run under the **calling Subagent's grants** — a tool cannot read a Knowledge Domain its caller can't.

## 8. External exposure

Each tool extension may **opt in** (`exposure.external_mcp: true`) to being exposed outside the Breadboard via the Breadboard MCP server ([11](11-api-mcp.md) §4). This lets teams leverage shared tooling from their local harness setups (e.g., Claude Code on a laptop) without replicating functionality in a separate MCP server. External calls authenticate as a user and run under that user's permissions, in the same sandbox with the same limits.

## 9. MCP server onboarding

Central onboarding simplifies configuration: each distinct MCP server is onboarded **once** per Breadboard (`config/mcp/<slug>.yaml` — endpoint/command, transport, auth via a broker capability, default tool allowlist). Access then propagates to Subagents via their config grants ([05](05-subagents.md) §2.2), optionally narrowed per grant. MCP tool calls are logged in Session turns like any tool call; MCP servers run outside the sandbox but their credentials still live in the broker.

## 10. UI

- **Toolbox inventory:** searchable list of all tool extensions and onboarded MCP servers. From here users modify MCP configurations, onboard new MCP servers, or jump into the Tool editor for extensions.
- **Tool editor:** a browser-based code editor (CodeMirror 6) over the tool's directory — manifest + source, TypeScript and Python. Diff/commit flow against the config repo; version history with revert.
  - **Designer chat panel** — always visible: tool-designer Subagents with tool-editing context, propose-review-commit ([10 — UI](10-ui.md) §4), minimizing manual code editing.
  - Manifest lint surfaces limit/egress/capability changes prominently (they're the security-relevant part of any diff).

## 11. v1 cutline

**In:** `tool@v1` manifest; TS + Python runtimes; Docker sandbox with warm pools, limits, default-deny egress; credential broker integration; idempotency journal; pre-packaged tool set (incl. `spawn-harness` with a Claude Code adapter); read-only AI code access + branch proposals; MCP onboarding; external MCP exposure; inventory + editor UI.

**Out (future):** additional languages; long-running/daemon tools; tool-level caching layer; per-tool telemetry dashboards; harness adapters beyond Claude Code.

## 12. Open questions

1. **Warm-pool poisoning.** Warm containers must be provably unmodified; recommendation: pools hold *pre-started but unused* containers only — a container is never returned to the pool after executing.
2. **`max_cost_units` calibration.** Units are abstract in v1 (1 unit ≈ 1 CPU-minute guidance); real metering is future work.
