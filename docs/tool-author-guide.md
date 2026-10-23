# Tool author guide

Tool extensions are the leaves where arbitrary logic lives ([06 — Toolbox](../specs/06-toolbox.md)). They are TypeScript or Python, versioned in the config repo, and executed in per-execution sandboxes with declared limits, default-deny egress, and no credentials.

## Anatomy

```
tools/<uid>/
  tool.yaml        manifest (see docs/config-reference.md)
  src/index.ts     or src/main.py — exports/defines `handler(input, ctx)`
```

The handler receives validated `input` (per the manifest's `input` schema, defaults applied) and `ctx`, the `BreadboardContext` from `@breadboard/sandbox-runtime`.

- As a **circuit code step**, return `{ exit: '<declared exit>', output: {...} }`.
- As an **LLM tool call**, return just the output payload.

## The context (`ctx`)

Every method is an authenticated call back into the Breadboard API under the *caller's* grants — a tool cannot read a Knowledge Domain its calling Subagent can't. A code step has no calling Subagent, so it reads every Knowledge Domain and repository mirror (and only its own session family's session-scoped content).

| Area | Methods |
|---|---|
| Content | `createArtifact`, `updateArtifact`, `readNode`, `addComment`, `emitEdge` (derived-from, attached-to, blocks, depends-on, references — never produces/updates), `tagNeedInput`, `searchNodes`, `inspectNode` |
| Knowledge | `queryKnowledge`, `readNote` (returns `base_revision`), `listKnowledgeDomains`, `proposeNoteEdit` (the reconcile path), `createNote` (a new Note in writable domains; queued for review, returns `base_revision` and `possible_duplicates`) |
| Repositories | `searchRepo`, `readRepoFile` (server-side mirrors; every result cites its commit) |
| Intake | `createTask`, `findSimilarTasks` |
| Sessions | `runCircuit` (child Session, needs an execute grant), `getSessionSummary` |
| Composition | `runTool` (nested sandbox; depth-capped) |
| Network | `fetch(capability, request)` — the only way out besides the egress allowlist; the broker attaches credentials |
| Models | `converse(request)` — one model turn through the Breadboard model gateway; the manifest must declare the reserved `model` capability |
| Evals | `recordScore`, `getRubric` |
| Config | `readConfig` |
| Logging | `ctx.log(level, message, data)` → the Session code log |
| Anything else | `primitive(name, args)` calls any primitive by its catalog name with its MCP argument shape (`search_config`, `list_sessions`, `resolve_need_input`, …; [11](../specs/11-api-mcp.md) §4 lists them) |

Ambient context: `ctx.ambient` has `session_id`, `step_id`, `attempt`, `execution_key`, `tool_uid`, `budget_remaining`, `task`, `settings` (merged manifest defaults ← grant settings, including hidden ones), `invocation`.

## TypeScript example

```ts
import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';

interface Input { artifact: string }
interface Output { ok: boolean; missing: string[] }

export async function handler(input: Input, ctx: BreadboardContext): Promise<StepResult<Output>> {
  const node = await ctx.readNode(input.artifact);
  const links = [...String(node.body_text ?? '').matchAll(/\[\[([0-9A-HJKMNP-TV-Z]{20})/g)].map((m) => m[1]);
  const missing: string[] = [];
  for (const uid of links) {
    try { await ctx.readNode(uid); } catch { missing.push(uid); }
  }
  ctx.log('info', `checked ${links.length} citations`, { missing });
  return { exit: missing.length ? 'fail' : 'pass', output: { ok: missing.length === 0, missing } };
}
```

Use only erasable TypeScript syntax (no enums/namespaces/parameter properties): the sandbox runs `.ts` directly with Node's type stripping.

## Python example

```python
def handler(input, ctx):
    hits = ctx.query_knowledge(q=input["question"], mode="hybrid", limit=5)
    ref = ctx.create_artifact(title="Related notes", body="\n".join(f"- [[{h['uid']}|{h['title']}]]" for h in hits), tags=["intermediate"])
    return {"exit": "done", "output": {"notes": ref}}
```

Python methods are the snake_case twins of the table above (`read_note`, `list_knowledge_domains`, `search_repo`, `read_repo_file`, …), with keyword arguments; `ctx.primitive("search_config", {"q": "athena"})` reaches the rest.

## Egress and credentials

Declare hosts in `egress.allow`; everything else is blocked by the proxy and logged. For authenticated APIs declare a `capability` and call `ctx.fetch('<capability>', { url, method, headers, body })`; an admin binds the capability to a credential and scope (hosts, methods, path prefixes) in the broker. The credential never enters the container.

Your manifest's `scope` for the capability (`read`, `write`, `query`, …) is what the broker checks: a `read` declaration may only send GET, HEAD and OPTIONS, and an admin can add per-scope rules that narrow it further. For example, an S3 bucket behind an `aws-role` credential with `service: s3` (`POST /admin/broker/capabilities`):

```json
{
  "name": "reports-bucket",
  "credential": "s3-reports-role",
  "scope": {
    "hosts": ["my-bucket.s3.us-east-1.amazonaws.com"],
    "methods": ["GET", "DELETE"],
    "path_prefixes": ["/reports/", "/data/"],
    "scopes": ["read", "write"],
    "rules": [
      { "scopes": ["read"], "methods": ["GET"], "path_prefixes": ["/reports/", "/data/"] },
      { "scopes": ["write"], "methods": ["DELETE"], "path_prefixes": ["/data/tmp/"] }
    ]
  }
}
```

A tool declaring it `read` may then GET objects (a `range` header passes through and `content-range` comes back, which is how to read objects larger than the broker's 4 MB response cap), and one declaring `write` may DELETE only under `/data/tmp/`. The broker matches the URL path, so use virtual-hosted URLs (`https://<bucket>.s3.<region>.amazonaws.com/<key>`). Response bodies come back as UTF-8 text.

To call a model, do not add a provider endpoint to `egress.allow` or ship provider credentials: declare `capabilities: [{ name: model, scope: invoke }]` and call `ctx.converse({ messages, system?, tools?, preset?, model_id?, max_tokens?, temperature?, effort?, force_tool? })` (Python: `ctx.converse(messages, system=..., preset=...)`). Messages and the reply use the gateway's chat format (`text`, `tool_use`, `tool_result` and `reasoning` blocks); append the reply's content to your history unchanged, `reasoning` blocks included, so the next turn replays them and hits the prompt cache. The turn resolves the preset (default `medium`) with fallback, counts against the Session's budget, and shows up in the Session's cost; the seeded `spawn-harness` is the worked example.

## Idempotency

Executions are journaled by `(session, step, attempt, call index)`. If the orchestrator replays a step after a crash, a completed execution returns its journaled output instead of re-running — so side effects should flow through `ctx` primitives, not external state.

## Connectors

A connector tool adds a `connector:` block to its manifest and defines `list(cursor, ctx)` → `{items:[{external_id,title,updated_at}], next_cursor}` and `fetch(external_id, ctx)` → `{markdown, metadata}`. The scheduler materializes documents as read-only `knowledge` nodes tagged `connector:<uid>`.

## Testing and CI

Edit in the Tool editor (or ask the tool-designer in the chat panel). Each proposal has a review page, `/proposals/<id>`, reached from the proposal card's **Review changes**, the editor's open-proposals badge, or **Proposals** in the left rail. For every tool the proposal touches it runs manifest validation plus a syntax check (TypeScript type stripping, Python `ast.parse`) at the proposal head, and the designer sees the same result as `tool_checks`. Type-checking and tests do not run yet. Evals of circuits that use the tool can run against the proposal branch with `POST /evals/runs {circuit, proposal_id}`; the review page offers the button only for circuits the proposal itself changes.
