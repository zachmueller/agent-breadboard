# 08 — Intake

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md), [02 — Sessions & Orchestrator](02-sessions-orchestrator.md)
**Related:** [03 — Circuits](03-circuits.md) (triage circuits), [05 — Subagents](05-subagents.md) (Intake Subagent), [09 — Content](09-content.md) (Tasks are content nodes)

---

## 1. Purpose & principles

The Intake is a **queue of new Tasks**, filled by the owning team (and, in future, by their stakeholders). Tasks in the queue are only actioned upon by the AI **via Circuits** — there is no ad-hoc "just do this" execution path outside the circuit system.

- The primary intake pipeline is a dedicated UI conversation view where the team shapes ideas *with* AI before they become Tasks.
- Direct injection via API/MCP supports custom team pipelines — and is the same tooling the Intake circuit itself uses.
- Everything about intake is built from existing components: conversations are Sessions, Tasks are content nodes, triage is circuits, helpers are Subagents.

## 2. Tasks

A Task is a `task`-type content node ([01](01-data-model.md) §5):

- **Properties:** `title`, `priority` (`p0`–`p3`, default `p2`), `origin` (`{kind: user|subagent|api, id}`), `status` (`draft | queued | triaging | active | gated | done | rejected`), optional `target_circuit` (triage bypass, §4), optional per-task `budget` override ([02](02-sessions-orchestrator.md) §5.1).
- **Body:** the shaped pitch — problem statement, context, desired outcome, links (`[[UID|title]]`) to related Tasks/Artifacts/Notes gathered during shaping.
- **Tags:** origin/status surfacing (e.g., `origin:stakeholder` in future, `origin:ai`); dedup findings (`possible-dup-of:<UID>` plus a `references` edge).
- An `intake` revision is cut when the Task is accepted into the queue ([01](01-data-model.md) §3.3).
- Dependencies use `blocks`/`depends-on` edges; the dispatcher will not admit a Task whose `depends-on` targets are not `done`.

### 2.1 Lifecycle

```
draft ──(accept)──▶ queued ──(dispatch)──▶ triaging ──▶ active ──▶ done
  │                    │                                  │
  └─(discard)          └─(reject)                         └─ gated ⇄ active
```

`draft` exists during idea shaping; `queued` Tasks are eligible for auto-dispatch; `triaging`/`active`/`gated` mirror the state of the Task's Sessions; terminal states are `done` and `rejected`. Status transitions are written by the orchestrator (not by hand) except accept/discard/reject, which are human or Intake-Subagent actions.

## 3. Dispatch

By default, **every new Task flows through a top-level triage circuit** that routes it to the appropriate handling circuit, automatically as capacity allows ([02](02-sessions-orchestrator.md) §5.1).

### 3.1 Hierarchical triage

Breadboards quickly grow too complex for a single triage circuit to know every circuit. Triage is **hierarchical**: the initial triage circuit routes into follow-on, more specialized triage circuits based on the broad category of the Task; those route onward to handling circuits (or deeper triage). Mechanically this is nothing special — triage circuits are ordinary circuits ([03](03-circuits.md)) whose steps classify (LLM step with named exits per category) and whose exits are sub-circuit steps. The top-level triage circuit slug is set in `config/breadboard.yaml` (`intake.triage_circuit`).

### 3.2 Triage bypass

Optionally, a Task may instead be **directly associated with a specific triage circuit or a specific detailed circuit at creation time** (`target_circuit` property), bypassing the default top-level triage. Set by the creating user, the Intake Subagent (when confident of the destination), or an API caller.

## 4. Idea-shaping conversations

The team engages in "idea shaping" discussion with **Intake Subagents** in the browser. These are tuned to help sharpen the initial pitch: they ask follow-up questions to clarify ambiguities, and spawn deeper helper subagents/circuits to shape the idea before adding Tasks to the queue.

- **Built-in, customizable.** One built-in Subagent (`intake-shaper`, shipped config the team customizes over time) is the initial AI users converse with; teams also develop additional Subagents callable within the conversation over time. The conversation may invoke specific Circuits as part of the discussion (via `run_circuit`, subject to grants).
- **Shaping helpers** (shipped as sub-circuits the shaper can invoke; deeper subagent calls operate as Circuits so their work is fully session-tracked):
  - **Deduplication:** searches past and pending Tasks across the Breadboard for overlap with the new idea (semantic + text over `task` nodes); overlaps are presented in-conversation and recorded as `references` edges + `possible-dup-of` tags.
  - **Grounded in code:** cross-references the idea against existing team code bases (via Toolbox tools, e.g. repo search or `spawn-harness`) to ground critiques in the actual starting point of the code.
  - **Contradiction check:** the `knowledge-checker` pattern ([07](07-knowledge.md) §7) against relevant Knowledge Domains.
- **Conversations are Sessions** (`kind: intake-conversation`, [02](02-sessions-orchestrator.md) §2) — full observability/debugging benefits: every turn logged with the username, helper invocations navigable as child Sessions.
- **Primary outcome:** the shaper's goal is creating well-formed Tasks into the queue via the `create_task` primitive. The resulting Task is persisted as a content node with `produces` lineage from the shaping Session — a Task's full origin story is always navigable.

## 5. Direct injection (API + MCP)

Breadboard facilitates direct injection of Intake items via API and MCP:

- REST: `POST /tasks` (full contract in [11 — API & MCP](11-api-mcp.md) §3) — creates a `queued` Task (or `draft` with `?draft=true`), honoring `target_circuit` and `priority`.
- MCP: `create_task` and `find_similar_tasks` tools ([06](06-toolbox.md) §3).
- **These are optionally leveraged by the owning team to build custom Task-creation pipelines** (ticket-system bridges, alert-driven task creation, etc.).
- **The same tooling is what the Intake circuit has in its Toolbox config** to insert new items resulting from user discussions — there is exactly one write path for Task creation.

## 6. Priority model

v1 keeps priority simple while laying the base for future stakeholder tiering:

- `priority` ∈ `p0..p3`; dispatcher orders by priority then FIFO ([02](02-sessions-orchestrator.md) §5.1).
- `origin` is always recorded. In v1 all creators are team members or team-configured API callers; the future stakeholder view (§9) will map non-team origins to a lower default tier with team **promotion** actions — the data model (origin + priority as separate fields) already supports this.

## 7. UI

### 7.1 Intake conversations
The stereotypical AI chat interface — operating atop the Breadboard backend:

- Chat with the `intake-shaper` Subagent; helper invocations render inline with expandable detail (they're child Sessions).
- Draft Task panel: as shaping progresses, the emerging Task (title, pitch body, priority, target circuit, linked references) builds up beside the chat; "Accept into queue" finalizes (cuts the `intake` revision, sets `queued`).
- Because conversations are Sessions, past shaping conversations are revisitable in the Session explorer.

### 7.2 Task inventory
Visibility into **all Tasks captured throughout the infrastructure**:

- Default filter: pending + active Tasks (i.e., `queued`, `triaging`, `active`, `gated`); users can adjust filters to see any past completed Task, plus filters on priority, origin, tags, circuit, and date.
- Opening a pending/queued Task allows editing its contents in the shared Editor ([10 — UI](10-ui.md) §3) — Tasks are CRDT content like any other node.
- Where non-team or AI origins exist (API callers now; stakeholders/auto-pitch later), origin tags surface them for review with quick **promote / reject / mark-reviewed** actions (mark-reviewed keeps the origin's priority in place).
- Queue-age is displayed (no priority aging in v1, [02](02-sessions-orchestrator.md) §10).

## 8. v1 cutline

**In:** Task node schema + lifecycle; auto-dispatch through hierarchical triage; `target_circuit` bypass; idea-shaping conversations with the three shipped helpers; one write path (`create_task`) across UI/API/MCP; priority + origin model; both UI views.

**Out (future — see §9):** stakeholder intake view; auto-pitch circuits; priority aging; SLA tracking on queue latency.

## 9. Future work

- **Stakeholder intake view.** A separate dedicated view for stakeholders when the owning team opts in: stakeholder-created Tasks automatically get a lower priority tier than team-created ones; the team may action the stakeholder queue via a separate AI capacity pool or rely on prioritization ordering; team members may **promote** a stakeholder Task to higher priority or to team-created handling. The v1 origin/priority model and the `external` scope marker are designed so this lands without migration.
- **Auto-pitch circuits.** The owning team constructs Circuits that automatically pitch new Intake Tasks based on reviewing Content or as part of intermediate work — optionally with human-gated review before the Task becomes available in the queue for the AI to work. (Composes entirely from existing pieces: a circuit + `create_task` with `draft` status + a gate.)

## 10. Open questions

1. **Draft retention.** How long do abandoned `draft` Tasks live? Recommendation: 30-day auto-archive (soft delete), surfaced in a "drafts" filter until then.
2. **Dedup threshold.** When is similarity high enough to block vs. merely warn? Recommendation: never block — always create with `possible-dup-of` tags and let humans merge; blocking creates worse failure modes than duplication.
