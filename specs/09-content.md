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

Content comes from users, Subagents, and code steps alike. **A code step summarizing an analysis programmatically produces a first-class Artifact no different from an LLM-written report.** `created_by` records the actor (`user | subagent | code-step | system`); lineage edges let users understand the source and evolution of any node.

### 2.3 Body formats

Markdown (CRDT treatment when collaboratively editable) or structured JSON (plain revisioned storage) — see [01](01-data-model.md) §5. Large payloads (over a size threshold) spill to object storage with the node holding a content-addressed ref.

## 3. `need-input` tagging

How an agent signals it wants direction or review — attached to a **specific Artifact**, optionally with context or questions for what the review should focus on.

- **Lightweight and non-blocking:** users get to their review items when they want. This is entirely distinct from hard gates in [Circuits](03-circuits.md), which are an orchestrator-level mechanism — though gates often flag `need-input` on the Artifacts they produce, and **reviewing all gating Artifacts is what unblocks a gated session** ([02](02-sessions-orchestrator.md) §5.4).
- **Structure** (stored as a structured tag + properties entry):
  ```json
  {
    "need-input": {
      "role": "scientist",          // who should answer: team-defined role slugs (e.g. scientist, bie, manager)
      "username": null,              // optionally target a specific team member instead/in addition
      "prompt": "Is the cohort definition in §2 acceptable?",   // optional focus for the review
      "requested_by": {"kind": "subagent", "slug": "research-writer", "session_id": "ses_…"},
      "requested_at": "…"
    }
  }
  ```
  `role` routes review to the right kind of person; `username` targets a specific user. Both optional; untargeted requests appear in everyone's queue.
- **Resolution:** a reviewer marks the request resolved (optionally after commenting/editing). Resolution is recorded (who, when) and clears the tag; if the Artifact gates a suspended session, resolution feeds the gate-unblock check.

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

- **Review queue** — a built-in filter within this view: nodes with `need-input` tags relevant to the current user (matched on `role` membership or `username`), **including Artifacts gating suspended sessions** (those are badged with the blocked Session so reviewers see the stakes). This is the pull-based queue that gate review relies on ([02](02-sessions-orchestrator.md) §5.4).
- Entry point into the Content viewer.

### 5.2 Content viewer

Renders the node under its human-readable title:

- **Lineage navigation up** — into the Session chat or code log behind it (via `produces`/`updates` edges) — **and down** — where it's been consumed (`derived-from` referents, `references` backlinks).
- **Comments rail** — anchored comments beside the content, stale section at bottom, inline add-comment on text selection.
- **Jump into the Editor** ([10 — UI](10-ui.md) §3) for editable nodes.
- `need-input` banner with the request prompt and resolve action when applicable.

## 6. v1 cutline

**In:** Artifact model with intermediate/deliverable tagging; authorship parity; `need-input` with role/username routing, resolution, and the health metric; Comments with revision+quote anchoring and staleness handling; inventory with Review queue; Content viewer with lineage nav.

**Out (future):** artifact merge tooling (multi-parent `derived-from` UX); reactions/acknowledgments on comments; per-role review SLAs; digest notifications (v1 is pull-based only).

## 7. Open questions

1. **Role registry.** Where do `role` slugs live? Recommendation: declared in `config/breadboard.yaml` (`roles:` with user membership), so review-queue matching is config-driven.
2. **Resolved need-input history.** Keep resolved requests queryable for the health metric — recommendation: move the structured entry to a `need-input-history` array in properties on resolution rather than deleting.
