# 09 — Content

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** [02 — Sessions & Orchestrator](02-sessions-orchestrator.md) (gates), [07 — Knowledge](07-knowledge.md), [08 — Intake](08-intake.md), [10 — UI](10-ui.md)

---

## 1. Purpose

Content is what the Breadboard **produces and works on**: Intake Tasks, Artifacts, Knowledge Notes, and Comments. Identity, linking, revisions, and lineage for all Content follow the shared base and edge treatment in [01 — Data Model](01-data-model.md). This spec covers the content-specific behaviors: the Artifact model, `need-input` tagging, Comments, authorship, and the review surfaces.

## 2. Artifacts

Artifacts are the `artifact`-typed subset of Content — **content produced by Subagents and code steps**, whether intermediate context passed between steps or deliverables intended for user review.

### 2.1 Intermediate vs deliverable

- **Intermediate Artifacts** are the AI's working context: plan docs, scratch analyses, programmatic summaries passed between circuit steps ([02](02-sessions-orchestrator.md) §3.1).
- **Deliverables** are what the AI is actively passing back to users.
- **Both are tracked identically** — same node schema, same revisions, same lineage — because inspecting intermediates is how users diagnose whether a circuit worked. **Only the default UI filtering differs** (`intermediate` / `deliverable` tags; the orchestrator applies them from the step's declaration, defaulting to `intermediate` for `session`-scoped outputs).

### 2.2 Authorship parity

Content comes from users, Subagents, and code steps alike. **A code step summarizing an analysis programmatically produces a first-class Artifact no different from an LLM-written report.** `created_by` records the actor (`user | subagent | code-step | service` — the single system-wide taxonomy, [11](11-api-mcp.md) §2; server-internal writes like connector syncs record `service`); lineage edges let users understand the source and evolution of any node.

### 2.3 Body formats

Markdown (CRDT treatment when collaboratively editable) or structured JSON (plain revisioned storage) — see [01](01-data-model.md) §5. Large payloads (over a size threshold) spill to object storage with the node holding a content-addressed ref.

## 3. `need-input` tagging

How an agent signals it wants direction or review — attached to a **specific Artifact**, optionally with context or questions for what the review should focus on.

- **Lightweight and non-blocking:** users get to their review items when they want. This is entirely distinct from hard gates in [Circuits](03-circuits.md), which are an orchestrator-level mechanism — though gates create `need-input` requests on their gating Artifacts (one per targeted reviewer), and those requests resolve via **gate verdicts** ([02](02-sessions-orchestrator.md) §5.4): when every gating request has a verdict, the gate auto-resolves.
- **Multi-request:** an Artifact may carry **several concurrent `need-input` requests** (e.g., a scientist reviewing methodology while legal reviews claims). Each request gets a **server-minted request ID** and its own target and note. Structure (stored as a structured tag + a `need-input` properties array):
  ```json
  {
    "need-input": [
      {
        "request_id": "nir_01J8FQ2ZK7XW9MBT4PVN",   // server-minted; the resolve selector
        "role": "scientist",          // who should answer: team-defined role slugs (roles/role_memberships tables, [01] §8)
        "username": null,              // optionally target a specific team member instead/in addition
        "prompt": "Is the cohort definition in §2 acceptable?",   // optional focus for the review
        "requested_by": {"kind": "subagent", "uid": "01J8SUBAG0RSRCHWRITE0", "session_id": "ses_…"},
        "requested_at": "…",
        "gate": null                   // set when the request was created by a gate: {session_id, step_id}
      }
    ]
  }
  ```
  `role` routes review to the right kind of person; `username` targets a specific user. Both optional; untargeted requests appear in everyone's queue.
- **Resolution:** a reviewer resolves a **specific request by its `request_id`** (optionally after commenting/editing; gate-created requests resolve via the gate-verdict action, which requires the reviewer to match the request's target). Resolution is recorded (who, when) and moves the entry to `need-input-history`; for gate-created requests it feeds the gate's verdict tally ([02](02-sessions-orchestrator.md) §5.4).

### 3.1 Health metric

The **`need-input` rate is tracked as a health metric, normalized against volume of useful output** (resolved deliverables), as a quantitative proxy for how well the metacognitive iteration process is functioning — expected to start high and **decline as Knowledge and Subagents absorb team context**. Surfaced on the Breadboard dashboard as a trend (rate over time, per circuit), with drill-down to the requests behind any spike.

## 4. Comments

Comments are a special kind of Content node letting users and Subagents attach discussion onto any other node **without mutating the target**.

- **Cheap to create:** no title required; body is plain Markdown (immutable-after-post + edit-replace, no CRDT — [01](01-data-model.md) §5).
- **Association** via `attached-to` edges (node-bound). The comment's own properties optionally carry an **anchor**: `{revision, quote, context}` — what text, in which revision, it targets.
- **Staleness:** comments anchor to a revision + quote and **display as possibly stale if the head has moved past their anchor** ([01](01-data-model.md) §4.2). The viewer attempts re-anchoring against the head (same content-matching as [07](07-knowledge.md) §5.4); confident matches display in place, others fall into a "possibly stale" section of the rail.
- Threading: a comment may `attached-to` another comment (one level of nesting rendered; deeper chains flatten).
- AI-authored comments follow the same anchor-resolution rules with typed failures — never guessed placement.

## 5. UI

### 5.1 Content inventory

Searchable/filterable list, **defaulting to deliverable Artifacts**. Filters on type, tag, `need-input`/`role`, originating circuit, and date.

- **Review queue** — a built-in filter within this view: nodes with open `need-input` requests relevant to the current user (matched on `role` membership or `username`), **including Artifacts gating suspended sessions** (those are badged with the blocked Session so reviewers see the stakes, and offer the approve/request-changes verdict actions). This is the pull-based queue that gate review relies on ([02](02-sessions-orchestrator.md) §5.4).
- Entry point into the Content viewer.

### 5.2 Content viewer

Renders the node under its human-readable title:

- **Lineage navigation up** — into the Session chat or code log behind it (via `produces`/`updates` edges) — **and down** — where it's been consumed (`derived-from` referents, `references` backlinks).
- **Comments rail** — anchored comments beside the content, stale section at bottom, inline add-comment on text selection.
- **Jump into the Editor** ([10 — UI](10-ui.md) §3) for editable nodes.
- `need-input` banner listing each open request (prompt + target) with per-request resolve — or approve/request-changes verdict for gate-created requests — when applicable.

## 6. v1 cutline

**In:** Artifact model with intermediate/deliverable tagging; authorship parity; multi-request `need-input` with role/username routing, per-request resolution, and the health metric; Comments with revision+quote anchoring and staleness handling; inventory with Review queue (incl. gate verdicts); Content viewer with lineage nav.

**Out (future):** artifact merge tooling (multi-parent `derived-from` UX); reactions/acknowledgments on comments; per-role review SLAs; digest notifications (v1 is pull-based only).

## 7. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Role registry.** **Decided:** roles and memberships live in **team-scoped DB tables** (`roles`, `role_memberships` — [01](01-data-model.md) §8), managed via API/UI; OIDC groups may map into them at login ([12](12-security-deployment.md) §3). The config repo stays about behavior, not people. (Supersedes the earlier `breadboard.yaml` recommendation.)
2. **Resolved need-input history.** **Decided:** resolution moves the structured entry to a `need-input-history` array in properties rather than deleting — keeping resolved requests queryable for the health metric.
