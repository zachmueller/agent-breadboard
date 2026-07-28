# 04 — Evals

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md), [02 — Sessions & Orchestrator](02-sessions-orchestrator.md), [03 — Circuits](03-circuits.md)

---

## 1. Purpose & principles

Circuit evaluation is a **first-class pattern** in Breadboard, not an afterthought:

- The analogy is unit and integration tests in software development — extended to **eval-driven circuit design**: write or update the rubric and fixtures first, then iterate the circuit until scores pass.
- The two primary purposes: **(1) spot regressions when model changes arrive**, and **(2) lower costs by identifying the cheapest model that delivers sufficient quality on a given circuit.**
- Evals are primarily *implementations of existing Breadboard components* — custom evaluation tools in the [Toolbox](06-toolbox.md), dedicated evaluator [Subagents](05-subagents.md), eval executions as Sessions. The only dedicated component is the **results store** for collating evaluation results for aggregation and analysis.
- Rubric definitions live in the **configuration plane**, versioned alongside their circuits; eval results are **data**, collated in the results store. This keeps "did the score change because the model changed or the rubric changed?" answerable.

## 2. Rubrics

Each circuit may define a rubric (`config/circuits/<uid>/rubric.yaml`). A rubric encodes how to grade or score the outputs of that circuit.

```yaml
schema: breadboard/rubric@v1
circuit: 01J8CIRCUIT0LITREV00   # circuit config UID ([01] §6.2); editor displays the slug
judge:
  subagent: 01J8SUBAG0EVALJUDGE0  # evaluator subagent UID, used for LLM-scored dimensions
  model_id: anthropic.claude-sonnet-5   # judge model pinned to an EXPLICIT model ID, never a tier;
                                        # changing it starts a new comparison baseline (§10)
dimensions:
  - key: coverage
    type: numeric               # numeric | ordinal | boolean | programmatic
    scale: { min: 0, max: 10 }
    prompt: >
      Score how completely the summary covers the significant prior art
      for the research question. 0 = major known work missing, 10 = comprehensive.
  - key: effort-size
    type: ordinal
    levels: [XS, S, M, L, XL]   # t-shirt sizing
    prompt: How much human effort would fixing this output take?
  - key: grounded
    type: boolean               # pass/fail
    prompt: Does every claim cite a source artifact?
  - key: schema-valid
    type: programmatic          # cheap code assertion, no LLM
    tool: assert-output-schema  # toolbox tool extension
  - key: citations-resolve
    type: programmatic
    tool: assert-citations-exist   # e.g., cited sources exist as content nodes
aggregate:
  method: weighted-mean          # over normalized numeric/boolean dims
  weights: { coverage: 3, grounded: 2, schema-valid: 1, citations-resolve: 1 }
  gate: { min: 0.7 }             # aggregate threshold for pass/fail summaries
```

Rules:

- **Dimension types are closed:** `numeric` | `ordinal` | `boolean` | `programmatic`. LLM-judge scoring (numeric/ordinal/boolean with `prompt`) mixes freely with cheap programmatic assertions (schema validity, cited sources exist, …).
- Quantifiable dimensions enable aggregation via summary statistics across scores; t-shirt sizing (`ordinal`) and pass/fail (`boolean`) are equally supported and aggregate via distributions rather than means unless mapped.
- Rubrics are versioned with the circuit; an eval result always records the rubric commit.

## 3. Fixtures

Each circuit maintains **curated fixture sets of pinned inputs** (`fixtures.yaml`).

- **Primary creation path: promoting notable production Sessions into fixtures, with human confirmation** — turning interesting failures into permanent regression tests. From the Session explorer, "promote to fixture" captures the Session's circuit input (plus any pinned ambient values) into the manifest.
- Fixtures pin **inputs**, not outputs: eval runs execute the circuit **fresh** against fixture inputs.
- Manifest entries: `{ fixture_id, title, source_session_id?, input: <frozen JSON>, pinned_context?: [<node UID + revision>], notes }`. `pinned_context` freezes referenced content (e.g., a Knowledge Note revision) where determinism matters.
- Fixtures may be tagged (e.g., `regression`, `smoke`) and eval runs may target a tag subset.

## 4. Eval runs

An eval run executes one circuit version against fixtures and scores results.

1. For each fixture: run the circuit as a normal Session (`kind: eval-run`, clearly excluded from production dashboards by kind) at a specified config commit, with model preset overrides if the run is a model-comparison run.
2. Score the scored session: programmatic dimensions invoke their tools against the output; judge dimensions run the evaluator Subagent with the dimension prompt, the fixture input, and the circuit output. The judge returns per-dimension `{value, rationale}` via structured output.
3. Persist one result row per (fixture × dimension) plus an aggregate row.

**Each eval run records:** eval run ID, rubric ID + commit, circuit ID + commit, fixture ID, scored session ID, judge model ID, per-dimension `{dimension, type, value, rationale}`, aggregate score, cost, and timestamp.

### 4.1 Results store (Postgres)

```sql
CREATE TABLE eval_runs (
  eval_run_id    char(24) PRIMARY KEY,
  circuit_uid    char(20) NOT NULL,       -- config UID ([01] §6.2)
  circuit_commit text NOT NULL,           -- text, not char(40): SHA-256 git repos use 64-char hashes
  rubric_commit  text NOT NULL,
  model_overrides jsonb,                 -- preset/model substitutions for comparison runs
  judge_model_id text NOT NULL,
  fixture_tags   text[],
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_results (
  eval_run_id    char(24) NOT NULL REFERENCES eval_runs(eval_run_id),
  fixture_id     text NOT NULL,
  scored_session char(24) NOT NULL,      -- the session executed for this fixture
  dimension      text NOT NULL,          -- '*' for the aggregate row
  dim_type       text NOT NULL,          -- numeric|ordinal|boolean|programmatic|aggregate
  value          jsonb NOT NULL,         -- number | level | bool | {score, detail}
  rationale      text,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eval_run_id, fixture_id, dimension)
);
```

## 5. Structured judge capture (Evals MCP)

The evaluator LLM captures findings in a standardized, structured fashion so results aggregate cleanly (e.g., as models change or circuit designs are revised). This is exposed as a small MCP tool surface available to evaluator Subagents:

- `record_score({eval_run_id, fixture_id, dimension, value, rationale})` — validated against the rubric's dimension type before persisting.
- `get_rubric({circuit_uid})`, `get_fixture_output({eval_run_id, fixture_id})` — read-side helpers.

The same tools back both in-Breadboard eval runs and (future) external harnesses that want to score against a Breadboard rubric.

## 6. Analysis workflows

Built-in queries/views over the results store:

- **Model-regression check:** same circuit commit + rubric commit, judge held constant, compare aggregate + per-dimension distributions across `model_overrides` (or across time as presets change). Surfaced when a model preset definition changes ([05](05-subagents.md) §4).
- **Cheapest-sufficient-model:** for a circuit, matrix of preset option × aggregate score × mean session cost; highlight the cheapest option above the rubric's `gate.min`.
- **Circuit-change regression:** same fixtures + rubric, compare across circuit commits — run pre-merge on AI-proposed circuit changes (§7).
- Score-over-time trend per circuit, annotated with circuit/rubric commit markers so rubric changes are never mistaken for behavior changes.

## 7. Evals as merge checks

AI-proposed configuration changes (circuits, prompts, tools — [01](01-data-model.md) §6.2) surface as reviewable diffs. The review view offers **"run evals against this branch"**: fixtures execute at the proposed commit and results render side-by-side with the current main-commit baseline. Teams may mark a circuit's eval as **required** for merging changes touching that circuit's directory.

## 8. UI

- **Per-circuit Evals tab** (inside the circuit editor): rubric editor (YAML + form view), fixture list (promote/retire, tag), run launcher (pick commit, preset overrides, fixture tags), results table + trend chart.
- **Session explorer integration:** "promote to fixture" on any Session; eval-run Sessions link back to their eval results.
- **Breadboard-level eval dashboard:** recent runs, regression alerts (aggregate dropped below gate vs. previous run on same rubric commit), cost-vs-quality matrix per circuit.

## 9. v1 cutline

**In:** rubric schema with the four dimension types; fixture promotion from Sessions; eval runs as Sessions; results store; the five analysis workflows above; judge-capture MCP tools; run-evals-on-branch in review.

**Out (future):** scheduled eval sweeps (nightly); statistical significance testing on score deltas; human-labeling queues for judge calibration; cross-circuit composite scorecards; external-harness eval federation.

## 10. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Judge stability.** **Decided:** the judge is pinned to an explicit model ID (not a tier) in `rubric.yaml`'s `judge` block (§2), and judge-model changes are treated like rubric changes — a new comparison baseline.
2. **Routing-decision scoring.** **Decided:** v1 exposes routing to programmatic dimensions (assert the path taken). A dedicated routing-accuracy dimension type is future work.
