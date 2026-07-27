# 03 — Circuits

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md), [02 — Sessions & Orchestrator](02-sessions-orchestrator.md)
**Related:** [04 — Evals](04-evals.md), [05 — Subagents](05-subagents.md), [06 — Toolbox](06-toolbox.md)

---

## 1. Purpose & principles

Circuits are core to the Breadboard: **user-designed flows of LLM and code steps encoding the intended behaviors for tackling any Task**. They are the procedures through which the AI does the work.

- **Metacognition, not operation.** Improving circuits is the team's primary work. Instead of repeatedly nudging the AI the same way, you spot the AI doing something incorrectly and go straight to correcting the circuit (or the relevant [Subagent](05-subagents.md) definition) — a robust fix all future instances benefit from.
- **Declarative flows, code at the leaves.** A circuit's flow is a declarative graph of steps and connections. Arbitrary logic lives in leaf code steps implemented as [Toolbox](06-toolbox.md) tool extensions. This keeps flows introspectable, diffable, and round-trippable with the visual editor.
- **Statically knowable routing.** Each step declares a closed set of named exits; the graph is always drawable, and every routing decision is a recorded value evals can score.
- **Composable.** A step may be another circuit. Sub-circuit runs get their own Sessions ([02](02-sessions-orchestrator.md) §5.5).
- **Versioned.** Circuit definitions live in the config git repo; Sessions record the commit hash used, enabling exact provenance and easy revert when a change causes regression.

## 2. Circuit definition format

A circuit is a directory in the config repo (`config/circuits/<slug>/`, [01](01-data-model.md) §6.1) whose core is `circuit.yaml`. Reference example:

```yaml
# config/circuits/lit-review/circuit.yaml
schema: breadboard/circuit@v1
slug: lit-review
title: Literature review
description: Survey prior art for a research question and produce an annotated summary.
tags: [research]

budget:                      # per-run defaults; overridable per-Task at creation
  max_cost_usd: 15
  max_tokens: 2_000_000

input:                       # typed input schema (JSON Schema subset)
  type: object
  required: [question]
  properties:
    question: { type: string }
    depth:    { type: string, enum: [quick, thorough], default: quick }

output:
  type: object
  required: [summary_artifact]
  properties:
    summary_artifact: { $ref: "#/defs/artifact-ref" }

entry: gather                # step id where execution begins

steps:
  - id: gather
    kind: llm
    subagent: research-scout            # subagent slug (05-subagents.md)
    prompt: prompts/gather.md           # template, interpolated with input + ambient
    tools_override: []                  # optional narrowing of the subagent's toolset for this step
    output:
      type: object
      required: [sources]
      properties:
        sources: { type: array, items: { $ref: "#/defs/artifact-ref" } }
    exits:
      - name: found-sources             # → structured-output enum for the LLM
        to: summarize
      - name: nothing-found
        to: report-empty
    retry: { max_attempts: 3, backoff: { base_s: 5, cap_s: 300 } }

  - id: summarize
    kind: llm
    subagent: research-writer
    prompt: prompts/summarize.md
    output:
      type: object
      required: [summary_artifact]
      properties:
        summary_artifact: { $ref: "#/defs/artifact-ref" }
    exits:
      - name: done
        to: quality-check

  - id: quality-check
    kind: code
    tool: check-citations                # tool extension slug (06-toolbox.md)
    input_map:                           # explicit wiring from prior outputs/ambient
      artifact: $steps.summarize.output.summary_artifact
    exits:
      - name: pass
        to: quality-gate
      - name: fail
        to: summarize                    # loop back with the checker's findings in scope

  - id: quality-gate
    kind: gate
    review:                              # artifacts presented for review at this gate
      artifacts: [$steps.summarize.output.summary_artifact]
      tag_need_input: { role: scientist }   # gates often flag need-input on gating artifacts
    exits:
      - name: approve
        to: $end
      - name: revise
        to: summarize

  - id: report-empty
    kind: code
    tool: emit-empty-report
    exits:
      - name: done
        to: $end
```

Normative rules:

- `schema` is versioned; the server validates every commit against the schema version it declares.
- Every step `id` is unique within the circuit; `entry` names exactly one step; `$end` is the sole terminal pseudo-target (the step whose exit routes to `$end` must produce output conforming to the circuit's `output` schema).
- The exit graph must be **closed**: every declared exit routes to an existing step or `$end`; unreachable steps are a validation error (warning-level for work-in-progress branches saved on non-main branches).
- Cycles are allowed (loops like `quality-check → summarize` above); the per-run budget is the loop bound.

## 3. Step types

### 3.1 LLM steps

An LLM conversation with: a specified **Subagent** (system prompt, tool access, knowledge access, model preset — [05](05-subagents.md)), an optional per-step `tools_override` (narrowing only, never widening), a **prompt template** (Markdown with `{{ }}` interpolation over the step input and ambient context), and a required **output schema**.

The conversation runs the standard tool loop until the model produces a final structured output containing (a) the output payload and (b) the chosen exit as an **enum field over the step's declared exit names**. Schema-invalid finals are retried within the attempt (bounded re-ask), then fail the attempt.

### 3.2 Code steps

An invocation of a [Toolbox](06-toolbox.md) tool extension in the sandbox. Input via `input_map` (explicit JSONPath-style wiring from `$input`, `$steps.<id>.output.*`, and `$ambient.*`). The tool returns `{ exit: <name>, output: <payload> }` programmatically. Code steps can create first-class Artifacts (e.g., programmatic analysis summaries) exactly like LLM steps.

### 3.3 Sub-circuit steps

`kind: circuit` with `circuit: <slug>`. Input wired like a code step; the child's circuit-level `output` becomes the step output; the child's terminal exit name is surfaced as the step's exit. Runs as its own Session ([02](02-sessions-orchestrator.md) §5.5).

### 3.4 Gate steps

`kind: gate` — the hard-gate mechanism specified in [02 — Sessions & Orchestrator](02-sessions-orchestrator.md) §5.4. The circuit declares which artifacts are presented for review and which exits the reviewer chooses among. Gate resolution `{decision, comment?, edits?}` selects the exit; `edits` merge into the gate's output payload.

## 4. Step I/O & ambient context

- Each step declares **typed input/output schemas** (JSON Schema subset). Typed boundaries make circuits genuinely composable and double as structured-output specs and eval assertion targets ([04](04-evals.md)).
- Every step additionally has read access to a **closed, system-defined ambient context channel**: `$ambient.task` (triggering Task ref), `$ambient.session_id`, `$ambient.budget` (remaining), `$ambient.artifacts` (accumulated artifact refs produced so far in this Session). Steps cannot write arbitrary ambient keys — anything a step wants to pass forward goes through its typed output or an Artifact.
- Validation failures at a boundary are step failures (consume a retry attempt) — never silent coercion.

## 5. Routing

- Each step declares a **closed set of named exits**; LLM steps return the exit as a structured-output enum, code steps return it programmatically.
- The orchestration layer executes routing: a mix of code (following the declared edge) with the *decision* made inside the step (LLM choice or code logic). There is no separate "router LLM" — the graph edge is deterministic once the exit is chosen.
- Every routing decision is recorded (`step-exited` event with `exit_name`) and scoreable by evals.

## 6. Versioning & provenance

- Circuit changes are commits in the config repo — whether made by users in the editor or by AI through propose-review-commit ([01](01-data-model.md) §6.2).
- Version control covers the circuit's *design*: expected input/output shapes, flow and connections, per-step code refs, context and prompt templates, associated eval details (rubric + fixture manifests live in the same directory).
- The in-use commit hash is tracked in Session metadata for every run — full traceability of what logic ran historically.
- **Revert** is first-class in the editor: pick a prior version, one click creates the revert commit. Eval fixtures make regressions detectable before and after ([04](04-evals.md) §6).

## 7. Evaluation hooks (summary — full spec in [04 — Evals](04-evals.md))

Each circuit may carry `rubric.yaml` (typed scoring dimensions) and `fixtures.yaml` (pinned inputs, primarily promoted from production Sessions). Eval runs execute the circuit fresh against fixture inputs and score outputs — including routing decisions — against the rubric. The analogy is unit/integration tests; the intended workflow is **eval-driven circuit design**.

## 8. UI

### 8.1 Circuit inventory
A searchable list of all circuits (slug, title, tags, last-modified, eval status summary). Primarily a means of finding circuits and navigating into the editor.

### 8.2 Circuit editor
- **Flow-chart visualization** of the graph (React Flow): steps as nodes, exits as labeled edges, gates visually distinct. Users click into a step to edit its contents (prompt template, subagent selection, schemas, exits, retry policy) and the connections between steps. Edits round-trip losslessly to `circuit.yaml` — the file is the source of truth.
- **Designer chat panel** — always visible on the side: a conversation with circuit-designer Subagents equipped with built-in circuit-editing tools ([06](06-toolbox.md) §5). Users iterate on circuits conversationally via **propose-review-commit** (AI writes a branch, user reviews the visual + textual diff, commits) to minimize manual editing of code, prompts, or flow. Follows the shared designer-chat-panel pattern ([10 — UI](10-ui.md) §4).
- **Composability navigation:** when a step is a sub-circuit, its node links straight into that circuit's editor. A **backlinks** panel shows all incoming references — every other circuit that uses the open circuit as a step (powered by a config-plane reference index maintained by the server on commit).
- Version history sidebar: commit list, diff view, one-click revert, "run evals against this version."

## 9. v1 cutline

**In:** the `circuit@v1` schema and all four step kinds; typed I/O + ambient channel; named-exit routing; retry policies; cycles-with-budget-bounds; sub-circuit composition; validation on commit; inventory + editor with designer chat and backlinks.

**Out (future):** parallel fan-out/join steps (v1 flows are single-token; parallelism happens inside a step via tools or sub-harnesses); conditional edge expressions (all branching is via named exits); circuit templates/marketplace; auto-generated circuit drafts from Task descriptions.

## 10. Open questions

1. **Loop-guard beyond budget.** Should a step declare `max_visits` to catch infinite loops before budget burn? Recommendation: yes, optional `max_visits` with default 25, failing to `suspended-error`.
2. **Prompt template language.** Recommendation: minimal `{{path.to.value}}` interpolation + `{{#if}}`/`{{#each}}` (Handlebars subset); no arbitrary expressions — logic belongs in code steps.
