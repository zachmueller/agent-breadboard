# 02 — Sessions & Orchestrator

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** [03 — Circuits](03-circuits.md) (what gets executed), [09 — Content](09-content.md) (need-input vs gates), [04 — Evals](04-evals.md) (eval runs are Sessions)

---

## 1. Purpose & principles

The orchestrator executes [Circuits](03-circuits.md) and records every execution as a **Session**. Design principles:

- **The step boundary is the universal unit of durability, revision, and replay.** Run state is checkpointed at every step boundary; the Session log is the authoritative audit trail.
- **Event-sourced on Postgres.** No external workflow engine. The run's state is derived from an append-only event log; checkpoints make recovery cheap. Self-hosters get durable execution with zero extra infrastructure.
- **Suspend, don't die.** Exhausted retries and hard gates suspend the run into a reviewable state — runs never fail silently.
- **Sessions operate asynchronously.** Nothing about a Session assumes a human is watching; humans engage via the review queue and Session explorer.
- **Humans intervene through gates and review, not by starting runs.** Dispatch is automatic within configured budgets.

## 2. Concepts & IDs

- **Session** — the recorded execution of one circuit run *or* one Intake idea-shaping conversation ([08 — Intake](08-intake.md)). ID: `ses_` + 20-char Crockford base32.
- **Step** — one executed circuit step within a Session. ID: the circuit-definition step ID plus an attempt counter (`plan-draft#2` = second attempt of step `plan-draft`). Unique within the Session.
- **Turn** — one message in an LLM step's conversation. ID: `trn_` + 20-char Crockford base32, unique globally. For user↔AI chats (e.g., Intake), the user's username is mapped into the conversation history on their turns.
- **Run states:** `queued → running → (suspended-gate | suspended-error | completed | cancelled)`. Suspended runs return to `running` on resolution/resume.

## 3. Session records

What gets captured depends on step type:

- **LLM steps** log the full chat conversation: every turn (system, user, assistant, tool calls + results), with per-turn model ID, token counts, latency, and cost. Prompt templates are logged post-interpolation (with a ref back to the template path + commit).
- **Code steps** store the logs produced by the code — log level and content are up to the tool author. Stdout/stderr are captured with a size cap (overflow to object storage).
- **Config provenance:** at Session start the orchestrator resolves the circuit from the config repo and records the **commit hash**; each step records the subagent slug, tool versions, and model IDs actually used (after preset fallback resolution). See [01 — Data Model](01-data-model.md) §6.2.
- **Lineage:** at every step boundary the orchestrator automatically emits `produces`/`updates` edges from `(session_id, step_id)` to the node revisions the step created/modified ([01](01-data-model.md) §4.3).

### 3.1 Intermediate Content

Steps pass summarized context forward as intermediate **Artifacts** (the canonical example: a plan document an LLM step writes for downstream steps). Both LLM steps and code steps can create them — a code step may run a complex analysis and programmatically summarize results into an Artifact for downstream Subagent review. Intermediates are first-class content nodes ([09 — Content](09-content.md) §2), typically `session`-scoped and tagged `intermediate`.

## 4. Postgres schema (reference DDL)

```sql
CREATE TABLE sessions (
  session_id     char(24) PRIMARY KEY,            -- 'ses_' + uid
  kind           text NOT NULL,                   -- circuit-run | intake-conversation | eval-run
  circuit_slug   text,                            -- null for pure conversations
  config_commit  char(40),                        -- git commit hash resolved at start
  task_uid       char(20) REFERENCES nodes(uid),  -- triggering Task, if any
  parent_session char(24) REFERENCES sessions(session_id),
  parent_step_id text,
  state          text NOT NULL DEFAULT 'queued',  -- queued|running|suspended-gate|suspended-error|completed|cancelled
  state_detail   jsonb NOT NULL DEFAULT '{}',     -- gate info, error info
  budget         jsonb NOT NULL,                  -- {max_cost_usd, max_tokens, spent_usd, spent_tokens}
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  ended_at       timestamptz
);
CREATE INDEX sessions_state_idx ON sessions (state, created_at);

CREATE TABLE session_events (                      -- append-only event log (source of truth)
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  seq            bigint  NOT NULL,                 -- per-session monotonic
  event_type     text    NOT NULL,                 -- session-started|step-started|turn|tool-call|tool-result|
                                                   -- step-exited|step-failed|retry-scheduled|checkpoint|
                                                   -- gate-suspended|gate-resolved|budget-exceeded|
                                                   -- session-completed|session-cancelled
  step_id        text,
  payload        jsonb   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE step_checkpoints (                    -- derived, for cheap recovery (rebuildable from events)
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  step_id        text     NOT NULL,
  attempt        integer  NOT NULL,
  status         text     NOT NULL,                -- running|exited|failed
  exit_name      text,                             -- the chosen named exit
  output         jsonb,                            -- validated against the step's output schema
  ambient        jsonb    NOT NULL,                -- ambient context snapshot at boundary
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  tokens_in      bigint NOT NULL DEFAULT 0,
  tokens_out     bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, step_id, attempt)
);

CREATE TABLE session_turns (                       -- LLM chat logs (queryable; payloads may spill to object storage)
  turn_id        char(24) PRIMARY KEY,
  session_id     char(24) NOT NULL REFERENCES sessions(session_id),
  step_id        text NOT NULL,
  role           text NOT NULL,                    -- system|user|assistant|tool
  username       text,                             -- set for human turns
  content        jsonb NOT NULL,
  model_id       text,
  tokens_in      bigint, tokens_out bigint,
  cost_usd       numeric(12,6),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX turns_session_idx ON session_turns (session_id, step_id, created_at);
```

## 5. Execution semantics

### 5.1 Dispatch & capacity (auto-dispatch + budgets)

New Tasks flow into their triage circuit automatically ([08 — Intake](08-intake.md) §4). The dispatcher loop:

1. Pull the highest-priority `queued` Session (priority from the Task's `priority` property; FIFO within a priority tier).
2. Admit it if **all** capacity checks pass; otherwise leave it queued:
   - `max_concurrent_runs` (from `config/breadboard.yaml`) — count of `running` Sessions (suspended Sessions do **not** count).
   - Per-run budget available: every Session gets `{max_cost_usd, max_tokens}` from the circuit definition's `budget` block (circuit default, overridable per-Task at creation).
   - Breadboard spend rate limit: rolling-window ceiling (e.g., `max_spend_usd_per_hour`) across all Sessions; admission pauses when the window is saturated.
3. On admission, resolve config at current `main` commit, write `session-started`, and begin stepping.

Budget exhaustion mid-run: the step in flight is allowed to finish its current model/tool call, then the run suspends as `suspended-error` with `state_detail.reason = 'budget-exceeded'` and enters the review queue (a human may raise the budget and resume, or cancel).

### 5.2 Stepping, checkpointing, replay

For each step (definitions in [03 — Circuits](03-circuits.md)):

1. **Materialize inputs**: validate the upstream output against the step's input schema; assemble the **ambient context channel** (Task ref, Session ID, budget state, accumulated artifact refs — closed, system-defined; steps cannot add arbitrary keys).
2. **Execute**: LLM steps run the referenced Subagent conversation to completion (tool loop included); code steps invoke the tool extension in the sandbox ([06 — Toolbox](06-toolbox.md) §4).
3. **Collect the exit**: LLM steps return their chosen exit as a structured-output enum field; code steps return one programmatically. The exit must be one of the step's declared named exits — anything else is a step failure.
4. **Checkpoint**: validate output schema, write `step-exited` + `checkpoint` events and the `step_checkpoints` row, emit `produces`/`updates` edges, cut `step-completion` revisions on touched nodes.
5. **Route** along the exit's edge to the next step (or finish the Session).

Every routing decision is a recorded value — evals can score routing ([04 — Evals](04-evals.md)).

**Recovery/replay:** on server restart, `running` Sessions resume from their last checkpoint; the interrupted step re-executes as a new attempt (steps are therefore required to be idempotent-at-the-boundary: side effects flow through tools, and tool executions are journaled with an execution key so a replayed attempt can detect prior completion — see [06 — Toolbox](06-toolbox.md) §4.4). Deterministic replay for debugging re-derives state purely from `session_events`.

### 5.3 Retries & failure

Each step carries a retry policy (`{max_attempts, backoff: exponential(base, cap)}`, circuit-definable, default `3 attempts, 5s base, 5m cap`). Failures (model errors, tool crashes, schema-validation failures, invalid exits) consume an attempt. When retries exhaust:

- The run suspends as **`suspended-error`** (state persisted, no capacity held) and appears in the **review queue**.
- A human may: retry the step (fresh attempt, optionally after editing config — the Session records the new commit hash from that point forward), skip to a chosen exit (recorded as a manual routing decision), or cancel the Session.

### 5.4 Hard gates

Hard gates are an **orchestrator-level mechanism encoded directly in the circuit flow** — entirely distinct from `need-input` tagging on content (circuits often flag `need-input` on the artifacts produced at a gate, but the gating itself is separate; see [09 — Content](09-content.md) §3).

- At a gate step, the run suspends (`suspended-gate`): state persisted, **no capacity held**. The Session is marked gated so the Breadboard surfaces the blocked status.
- The gate declares which Artifacts it presents for review; those are typically tagged `need-input` and enter reviewers' queues.
- **Unblocking:** when all Artifacts gating the session have been reviewed, the gate can resolve. Resolution produces a structured decision object:

  ```json
  { "decision": "<one of the gate's declared exits>", "comment": "optional", "edits": { "optional": "structured amendments merged into the gate's output payload" } }
  ```

  The reviewer is choosing an edge in the flow — e.g., proceed to next steps, or punt back to a prior step. The decision is written as a `gate-resolved` event (with the resolving user), a `gate-resolution` revision is cut on the gated artifacts, and the run re-enters the dispatch queue.
- **v1:** gated runs wait indefinitely; users find pending reviews via the in-app review queue (pull-based). Escalation policies (notifications, timeouts, delegation) are future work.

### 5.5 Sub-circuits & composability

Every circuit run gets **its own Session ID** — whether initiated top-level, triggered as a step within a broader circuit, or spawned via a Subagent's tool call.

- The parent's log records the invocation (`step-started` with the child `session_id` in payload) and `parent_session`/`parent_step_id` are set on the child, enabling navigation both directions in the UI.
- All session details are recorded only within the individual session itself; the parent↔child association is how you know where to pull details. (Parent/child linkage lives in the session store; content lineage flows through edges as usual.)
- Child budgets draw down the parent's budget: a sub-session is admitted with `min(child circuit default, parent remaining)`.

## 6. Cost tracking

- Every LLM call records tokens in/out and computed cost on its turn row; step checkpoints aggregate turns; Sessions aggregate steps.
- **No double counting rule:** cost is *stored* only at the turn level (the leaf); step and session figures are materialized aggregates of leaf rows, and a parent Session's reported "total including children" is always computed by walking the session tree at query time — never stored denormalized.
- **v1 scope:** only LLM costs (i.e., model-provider spend via the gateway, Bedrock reference) are captured first-class. Sandbox compute, storage, etc. are future work.
- Purpose: support cost-vs-performance analysis (e.g., trying different model presets on the same circuit — joins against eval results, [04 — Evals](04-evals.md) §6).

## 7. API surface (summary — full contract in [11 — API & MCP](11-api-mcp.md))

- `GET /sessions` (filter: state, kind, circuit, task, date), `GET /sessions/:id`, `GET /sessions/:id/events`, `GET /sessions/:id/steps/:stepId/turns`
- `POST /sessions/:id/gate-resolution` (the structured decision object)
- `POST /sessions/:id/retry`, `POST /sessions/:id/cancel`, `POST /sessions/:id/resume` (post-budget-raise)
- Event stream: session state changes and gate suspensions are published on the Breadboard event stream (webhooks/SSE).

## 8. UI

- **Sessions history:** searchable/filterable listing of all past Sessions (state, kind, circuit, task, date, cost). Entry point for deep dives.
- **Session explorer:** the detailed execution view.
  - First layer: Session overview showing the steps taken (the executed path through the circuit graph), with per-step status, attempts, cost, and duration. Sessions suspended at a hard gate are prominently flagged so users can go unblock them.
  - Clicking a step dives into its execution details: full chat log for LLM steps (turn-by-turn, tool calls expandable), code logs for code steps.
  - If a step is a call to another Session, the UI jumps into that sub-session (and back). Throughout, edge data powers quick navigation into related content — Knowledge Notes read, Artifacts produced/updated, the triggering Task.

## 9. v1 cutline

**In:** everything above — event-sourced orchestrator, auto-dispatch with the three capacity mechanisms, retry/suspend semantics, hard gates with structured decisions (pull-based queue, indefinite wait), sub-sessions with budget draw-down, LLM-only cost tracking, both UI views.

**Out (future):** gate escalation policies; scheduled/cron dispatch; multi-worker orchestrator scale-out (v1 = one process; the event log is designed so a worker pool can be added without schema change); non-LLM cost capture; pausing/resuming individual steps mid-flight.

## 10. Open questions

1. **Mid-conversation checkpointing for very long LLM steps.** v1 checkpoints only at step boundaries; a crashed 40-turn step replays from its start. Recommendation: accept for v1; revisit with turn-level checkpoint markers if long steps prove common.
2. **Priority aging.** Should long-queued low-priority Tasks age upward? Recommendation: no aging in v1; surface queue-age in the Task inventory instead.
