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

Every method is an authenticated call back into the Breadboard API under the *caller's* grants — a tool cannot read a Knowledge Domain its calling Subagent can't.

| Area | Methods |
|---|---|
| Content | `createArtifact`, `updateArtifact`, `readNode`, `addComment`, `emitEdge` (derived-from, attached-to, blocks, depends-on, references — never produces/updates), `tagNeedInput` |
| Knowledge | `queryKnowledge`, `readNote` (returns `base_revision`), `proposeNoteEdit` (the reconcile path) |
| Intake | `createTask`, `findSimilarTasks` |
| Sessions | `runCircuit` (child Session, needs an execute grant), `getSessionSummary` |
| Composition | `runTool` (nested sandbox; depth-capped) |
| Network | `fetch(capability, request)` — the only way out besides the egress allowlist; the broker attaches credentials |
| Evals | `recordScore`, `getRubric` |
| Config | `readConfig` |
| Logging | `ctx.log(level, message, data)` → the Session code log |

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

## Egress and credentials

Declare hosts in `egress.allow`; everything else is blocked by the proxy and logged. For authenticated APIs declare a `capability` and call `ctx.fetch('<capability>', { url, method, headers, body })`; an admin binds the capability to a credential and scope (hosts, methods, path prefixes) in the broker. The credential never enters the container.

## Idempotency

Executions are journaled by `(session, step, attempt, call index)`. If the orchestrator replays a step after a crash, a completed execution returns its journaled output instead of re-running — so side effects should flow through `ctx` primitives, not external state.

## Connectors

A connector tool adds a `connector:` block to its manifest and defines `list(cursor, ctx)` → `{items:[{external_id,title,updated_at}], next_cursor}` and `fetch(external_id, ctx)` → `{markdown, metadata}`. The scheduler materializes documents as read-only `knowledge` nodes tagged `connector:<uid>`.

## Testing and CI

Edit in the Tool editor (or ask the tool-designer in the chat panel). Proposals run manifest validation plus a syntax check (`node --check` / `py_compile`) before merge. Evals that cover circuits using the tool can run against the proposal branch from the review view.
