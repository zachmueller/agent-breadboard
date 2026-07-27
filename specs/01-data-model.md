# 01 — Data Model

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md)
**Depended on by:** every other spec. This is the canonical definition of nodes, edges, revisions, and the two planes. Where any other spec appears to conflict with this one, this one wins.

---

## 1. Purpose & principles

Breadboard's data model separates **what the system works on** from **what shapes how the work is done**, and connects them through Sessions:

- The **content plane** is a typed graph of instances (Tasks, Artifacts, Comments, Knowledge Notes) tracked by lineage edges and addressed by UID.
- The **configuration plane** is the set of version-controlled definitions (Subagents, Circuits, Tool extensions, MCP onboarding, model presets, system tenets) tracked by git and referenced by commit hash.
- **Sessions are the join**: each run records the config versions it used and emits lineage edges to the content it produced.

Configuration may *reference* content nodes (e.g., a Subagent injecting a live Knowledge Note into its prompt), but content and config are never the same object.

The mutation models differ deliberately:

| | Content plane | Configuration plane |
|---|---|---|
| Mutation model | **CRDT** — convergence *is* the goal; no review gate; users and AI edit concurrently | **Version control with propose-review-commit** — discrete, hash-addressable versions; AI edits are gated |
| Real-time collaboration | Native (Yjs on the mutable head) | Config editors may layer presence/awareness for coordination, but the source of truth merges through commits, not CRDT |

---

## 2. Storage decision

**v1 uses PostgreSQL for everything stateful except the configuration plane:**

- Content-plane node bodies: JSONB + Yjs update log tables.
- Edge graph: a typed `edges` table queried with recursive CTEs.
- Orchestrator state, session logs, eval results: relational tables (see [02](02-sessions-orchestrator.md), [04](04-evals.md)).
- Configuration plane: a git repository on the server's filesystem (bare repo + working checkouts), managed by the Breadboard server.

Rationale: a single stateful dependency keeps self-hosting trivial; JSONB + recursive CTEs comfortably cover v1 graph workloads (lineage chains are shallow — typically < 20 hops). A dedicated graph store is a **documented future seam**: all graph access goes through a `GraphQueries` module in the server codebase so a later swap doesn't touch callers. This supersedes the earlier idea of a separate document store + graph store.

---

## 3. Shared base: Nodes

Every content-plane object is a **node** with this common shape.

### 3.1 Node fields

| Field | Definition |
|---|---|
| **UID** | 20-character [Crockford base32](https://www.crockford.com/base32.html) string (uppercase canonical form, e.g. `01J8FQ2ZK7XW9MBT4PVN`). Immutable. The primary key. Generated server-side from 100 random bits (no embedded timestamp — UIDs must not leak creation ordering). |
| **Team** | The owning team (`team_id`). v1 deployments operate a single team, but the column exists from day one so multi-team and federation need no schema migration (see §8 identity tables). |
| **Title** | Human-readable; stored in the node's frontmatter/properties; may change freely without breaking links (links use UID). |
| **Type** | One of `task` \| `artifact` \| `comment` \| `knowledge`. The set is extensible (future: `workstream`, `project`, `idea`, …); extensions register a type name and optional JSON Schema for type-specific properties. |
| **Tags** | Arbitrary string labels. Also the mechanism for type-specific flags — e.g. `need-input`, `intermediate`, `deliverable` are tags, not columns. Structured tags use `key:value` form (e.g. `need-input:role=scientist`); see [09 — Content](09-content.md) §3 for the `need-input` grammar. |
| **Scope / visibility** | Who/what can see the node. See §3.4. |
| **Properties** | A key→value map (the "frontmatter"): title lives here, plus type-specific fields (e.g. a Task's `priority`, `origin`). Collaboratively edited as a CRDT map (per-key merge). |
| **Body** | The main content. For `knowledge` and long-form artifacts: Markdown text under CRDT treatment. For small structured artifacts: JSON. |
| **Lineage** | *Not* node fields — captured entirely as edges (§4). |
| **Revisions** | See §3.3. |

### 3.2 Linking

References between nodes — in bodies, properties, comments, anywhere — use Obsidian-style wiki links with the UID as the target and an optional display title:

```
[[01J8FQ2ZK7XW9MBT4PVN|Q3 latency analysis]]
```

- The UID is authoritative; the display title is cosmetic and may go stale without breaking the link.
- The server maintains a link index: whenever a node revision is cut or the head is persisted, `[[…]]` targets are extracted and materialized as `references` edges (§4), replacing that node's previously-materialized `references` edges.
- Rendering resolves the UID to the node's current title; broken links (UID not found) render distinctly.

### 3.3 Revisions

Each node pairs a **stable identity** (the UID and its mutable, CRDT-edited head) with **immutable named revisions**.

- A revision is a full snapshot of the node (properties + body) at a moment, with: `revision_id` (monotonic integer per node), `labels` (the trigger(s) that cut it — an array, since dedup can attach later triggers to an existing revision), `created_at`, `created_by` (user, subagent, or system), and for CRDT bodies the encoded Yjs state + state vector.
- Revisions are cut at **meaningful boundaries**, not on every keystroke:
  - `step-completion` — an orchestrator step that produced or updated the node finished (cut automatically; this is what `produces`/`updates` edges bind to).
  - `gate-resolution` — a hard gate involving this node was resolved.
  - `publish` — a user explicitly published/named a revision.
  - `pre-ai-edit` — cut automatically immediately before an AI write is merged into a CRDT body (this is both the merge base and the one-click "revert the AI edit" target; see [07 — Knowledge](07-knowledge.md) §5).
  - `intake` — a Task was accepted into the queue.
- CRDT live collaboration always operates on the **mutable head**; revisions give lineage something permanent to point at.
- Revisions are content-deduplicated: if the node state is byte-identical to the latest revision, no new revision is written — the new trigger is appended to the existing revision's `labels` array.

### 3.4 Scope / visibility

Scope answers "who/what can see this node." v1 keeps it deliberately small:

- `team` (default) — visible to all members of the owning team (the node's `team_id`) and all Subagents.
- `session` — intra-run scratch; visible within the producing Session (and its parent/child Sessions) and to team members inspecting that Session, but excluded from cross-session search/RAG surfaces.
- `external` — reserved marker for future stakeholder-visible content (unused in v1 behavior; stored so data doesn't need migration when the stakeholder view lands).

Scope **propagates along lineage edges**: a node derived from a `session`-scoped node defaults to `session` unless explicitly widened at creation. Widening is allowed (scratch → deliverable); silent narrowing is not (a node can't become more secret than something derived from it already exposed — the server rejects narrowing when a wider-scoped `derived-from` descendant exists).

---

## 4. Shared base: Edges

Each edge is **typed, directional, first-class, and queryable both ways**.

### 4.1 Edge taxonomy

| Type | From → To | Meaning |
|---|---|---|
| `produces` | Session/step → node | The step created this node. |
| `updates` | Session/step → node | The step modified this node (append-only history of edits). |
| `derived-from` | node → node(s) | This node was built on those (artifact→artifact, including future merges). |
| `attached-to` | comment → target node | The comment annotates the target (any node type). |
| `blocks` | task → task \| task → artifact | Blocking relationship for prioritization/gating. |
| `depends-on` | task → task \| task → artifact | Dependency for prioritization/gating (inverse framing of `blocks`; both exist so intent is explicit). |
| `references` | node → node | Soft link: a `[[…]]` mention that isn't strict lineage. Materialized from link extraction (§3.2) or emitted explicitly. |

### 4.2 Revision binding

- **Provenance edges** (`produces`, `updates`, `derived-from`) bind to a specific node **revision** — they record what the world looked like, immutably.
- **Currency edges** (`references`, `attached-to`, `blocks`, `depends-on`) bind to the **node** — they track the living object.
- Exception detail: Comments additionally carry their own anchor (revision + quote) in the comment node's properties; the `attached-to` edge itself is node-bound. A comment whose anchor revision is behind the target's head displays as **possibly stale** (see [09 — Content](09-content.md) §4).

### 4.3 Emission rules

- The **orchestrator emits `produces` and `updates` edges automatically at every step boundary** — subagents and tool code cannot forget lineage.
- `derived-from`, `attached-to`, `blocks`/`depends-on`, and explicit `references` are emitted by **Subagents' tool calls via a Toolbox primitive** (`emit_edge`; see [06 — Toolbox](06-toolbox.md) §7 and [11 — API & MCP](11-api-mcp.md)) or by users via the UI/API.
- Implicit `references` edges are materialized by the server's link indexer (§3.2).
- Edges are never deleted by ordinary operations; retracting a mistake writes a tombstone (`retracted_at`, `retracted_by`), and queries exclude tombstoned edges by default.
- **Exception — indexer-owned `references` edges.** Link-indexer-materialized `references` edges are a **derived index** of body content, not provenance: the indexer may true-delete/upsert them on re-index (every revision cut would otherwise tombstone-and-recreate them, bloating the table without adding information). Nothing is lost — historical link state is always recoverable from the immutable revisions the links were extracted from. Explicitly-emitted `references` edges (via `emit_edge` or the UI) and all other edge types keep the tombstone-only rule.

### 4.4 What edges power

Lineage navigation up/down from any node ("jump from Artifact to the Session chat that spawned it"; "where has this been consumed?"), the Comments rail, circuit-editor backlinks, Task dependency views, and Knowledge backlink panels. Both AI and users use the same queries to explore how content originated, evolved, and connects.

---

## 5. Content plane

Four main node types (extensible):

| Type | Definition | Detailed in |
|---|---|---|
| `task` | Unit of intended work | [08 — Intake](08-intake.md) |
| `artifact` | Content produced by Subagents or code steps (intermediate or deliverable) | [09 — Content](09-content.md) |
| `comment` | Lightweight annotation attached to any node; no title required | [09 — Content](09-content.md) |
| `knowledge` | Durable, human-curated context | [07 — Knowledge](07-knowledge.md) |

All content-plane bodies that are collaboratively edited get **CRDT treatment** (Yjs) on the mutable head:

- **Body**: a block-structured Yjs document — a `Y.Array` of blocks, each block = `{ id: stable 10-char nanoid (server-minted), ytext: Y.Text of Markdown source }`. Markdown-native: no rich-text schema round-trip. Stable block IDs enable identity-preserving AI merges, attribution, and block-anchored comments (see [07 — Knowledge](07-knowledge.md) §5).
- **Properties/frontmatter**: a separate `Y.Map` — clean per-key merge semantics instead of interleaved text conflicts.
- Not everything needs live collab: small machine-written artifacts (e.g., a JSON summary from a code step) may be stored as plain JSONB with revisions only; the `crdt` flag on the node record says which regime applies. `comment` bodies are immutable-after-post (plus edit-replace), never CRDT.

---

## 6. Configuration plane

Version-controlled definitions shaping how work is done:

- **Subagent configs** — system prompt, tool/knowledge/circuit access, model preset ([05](05-subagents.md)).
- **Circuits** — flow graphs and step definitions ([03](03-circuits.md)).
- **Tool extensions** — TS/Python code + tool manifests; **MCP onboarding** configs ([06](06-toolbox.md)).
- **Model presets** — tier → ordered model-ID fallback lists ([05](05-subagents.md) §4).
- **System tenets** — the strictly-limited system-wide rules ([05](05-subagents.md) §5).
- **Eval rubrics + fixture manifests** — versioned alongside their circuits ([04](04-evals.md)).

### 6.1 Git repo layout

One git repository per Breadboard, managed by the server (users never need direct git access, but the repo is a plain repo — inspectable and cloneable by admins):

```
config/
  breadboard.yaml            # instance settings: capacity, budgets, scope defaults
  tenets.md                  # system-wide tenets (strictly size-limited)
  presets/
    models.yaml              # model presets: tier -> ordered fallback list
  subagents/
    <slug>.yaml              # one file per subagent
  circuits/
    <slug>/
      circuit.yaml           # declarative flow: steps, connections, exits, gates
      prompts/               # prompt templates referenced by steps
        <step-id>.md
      rubric.yaml            # optional eval rubric
      fixtures.yaml          # fixture manifest (fixture inputs pinned by content ref)
  tools/
    <slug>/
      tool.yaml              # manifest: language, entrypoint, limits, egress, capabilities
      src/                   # tool source (TS or Python)
  mcp/
    <slug>.yaml              # onboarded MCP server config (endpoint, auth capability ref, tool allowlist)
```

### 6.2 Config UIDs & cross-references

Every config definition (subagent, circuit, tool, MCP onboarding, model preset) is minted a **permanent UID** at creation — same 20-char Crockford base32 generator as content nodes — stored in a `uid:` field in its YAML. **All cross-references use the UID**, never the slug or path:

- step → sub-circuit, step → subagent, subagent grants → tools/circuits/knowledge domains, `breadboard.yaml` → triage circuit, MCP onboarding → credential capabilities;
- content-plane references to config (a Task's `target_circuit`, Session rows' circuit/subagent identifiers) likewise store the UID.

Slugs and file paths are **display and file-layout metadata only** — renames and directory moves never break references. The server maintains a UID→path index per commit (rebuilt on commit validation); commit validation rejects a change that would delete or duplicate a UID in the tree.

### 6.3 Versioning & provenance rules

- Every mutation is a **commit** authored either by a user (via UI editors) or by the AI through **propose-review-commit**: AI writes to a branch, the change surfaces as a reviewable diff, a human merges. CI/evals may run against proposed changes before merge ([06 — Toolbox](06-toolbox.md) §6, [04 — Evals](04-evals.md) §7).
- Every Session records, at start and at any mid-run config resolution, the **commit hash** of the config tree it resolved definitions from (stored as `text`, not `char(40)` — SHA-256 git repos produce 64-char hashes). Historical runs are exactly reproducible in configuration terms. Mid-run re-resolutions are recorded as session events ([02](02-sessions-orchestrator.md) §4), not extra columns.
- Version control covers the *design* of each definition: input/output shapes, flow and connections, step code/context/prompt templates, associated eval details. It does **not** cover run state or content (that's the content plane).
- Reverting a regression = `git revert` surfaced as a first-class "revert to this version" action in the editors.

---

## 7. Sessions as the join

Defined fully in [02 — Sessions & Orchestrator](02-sessions-orchestrator.md). For the data model, the contract is:

- Every Session row records: the triggering Task UID (if any), the circuit UID + **config commit hash**, per-step subagent UIDs + the same hash, model IDs actually used, and cost (slugs may be denormalized alongside for display, but the UID is authoritative; see §6.2).
- Every step boundary automatically writes `produces`/`updates` edges from `(session_id, step_id)` to the node **revisions** it created/modified.
- Sub-circuit invocations create child Sessions linked by parent→child association in the session store *and* navigable both directions.

---

## 8. Postgres schema (reference DDL)

Names are normative; exact column tuning is implementation detail. All timestamps are `timestamptz`.

```sql
-- Identity ---------------------------------------------------------------
-- v1 deployments run a single team, but the schema is multi-team-ready from
-- day one so multi-team/federation needs no migration. Local-dev static users
-- ([12] §3) are ordinary rows in `users`.
CREATE TABLE teams (
  team_id        char(20) PRIMARY KEY,           -- Crockford base32, same generator as node UIDs
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id        char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  handle         text NOT NULL,                  -- login/display handle
  display_name   text NOT NULL DEFAULT '',
  oidc_subject   text,                           -- NULL for local-dev static users
  is_admin       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  UNIQUE (team_id, handle)
);

-- Review roles ([09] §3, gate reviewer targeting): team-scoped DB records
-- managed via API/UI, not config-repo entries. OIDC groups may map into
-- role memberships at login ([12] §3). This supersedes the earlier
-- breadboard.yaml roles registry idea.
CREATE TABLE roles (
  role_id        char(20) PRIMARY KEY,
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  slug           text NOT NULL,                  -- e.g. 'scientist'; referenced by need-input/gate targeting
  description    text NOT NULL DEFAULT '',
  UNIQUE (team_id, slug)
);

CREATE TABLE role_memberships (
  role_id        char(20) NOT NULL REFERENCES roles(role_id),
  user_id        char(20) NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, user_id)
);

-- Content plane ---------------------------------------------------------
CREATE TABLE nodes (
  uid            char(20) PRIMARY KEY,          -- Crockford base32
  team_id        char(20) NOT NULL REFERENCES teams(team_id),
  type           text NOT NULL,                 -- task|artifact|comment|knowledge|...
  title          text NOT NULL DEFAULT '',
  properties     jsonb NOT NULL DEFAULT '{}',   -- frontmatter head (mirror of Y.Map)
  body           jsonb,                          -- non-CRDT bodies (plain artifacts, comments)
  body_text      text,                           -- rendered-Markdown mirror of CRDT head (search/RAG)
  crdt           boolean NOT NULL DEFAULT false,
  tags           text[] NOT NULL DEFAULT '{}',
  scope          text NOT NULL DEFAULT 'team',   -- team|session|external
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,                 -- actor: {kind: user|subagent|code-step|service, id} ([11] §2 taxonomy)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz                     -- soft delete only
);
CREATE INDEX nodes_type_idx  ON nodes (type) WHERE deleted_at IS NULL;
CREATE INDEX nodes_tags_idx  ON nodes USING gin (tags);
CREATE INDEX nodes_props_idx ON nodes USING gin (properties jsonb_path_ops);
CREATE INDEX nodes_fts_idx   ON nodes USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body_text,'')));

CREATE TABLE node_revisions (
  uid            char(20) NOT NULL REFERENCES nodes(uid),
  revision_id    integer  NOT NULL,              -- monotonic per node
  labels         text[]   NOT NULL,              -- trigger(s): step-completion|gate-resolution|publish|pre-ai-edit|intake
                                                 -- array: content-dedup appends later triggers to the existing revision (§3.3)
  properties     jsonb    NOT NULL,
  body           jsonb,
  body_text      text,
  ydoc_state     bytea,                          -- encoded Yjs state (CRDT nodes)
  ydoc_vector    bytea,                          -- state vector (merge base for AI edits)
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,
  PRIMARY KEY (uid, revision_id)
);

CREATE TABLE yjs_updates (                        -- fine-grained CRDT history
  uid            char(20) NOT NULL REFERENCES nodes(uid),
  seq            bigserial,
  update         bytea NOT NULL,                  -- one Yjs update
  origin         jsonb NOT NULL,                  -- actor + connection/session attribution
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, seq)
);
-- Compaction: updates older than the latest revision snapshot may be folded
-- into that snapshot and pruned, per the policy in spec 07 §6.

-- Edges ------------------------------------------------------------------
CREATE TABLE edges (
  edge_id        bigserial PRIMARY KEY,
  type           text NOT NULL,                  -- produces|updates|derived-from|attached-to|blocks|depends-on|references
  -- Source: either a content node or a session step (provenance edges)
  src_uid        char(20) REFERENCES nodes(uid),
  src_session_id char(24) REFERENCES sessions(session_id),  -- 'ses_' + 20 chars ([02] §4); with src_step_id for produces/updates
  src_step_id    text,
  dst_uid        char(20) NOT NULL REFERENCES nodes(uid),
  dst_revision   integer,                        -- set for provenance edges (revision-bound)
  properties     jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     jsonb NOT NULL,
  retracted_at   timestamptz,
  retracted_by   jsonb,
  CHECK (src_uid IS NOT NULL OR src_session_id IS NOT NULL)
);
CREATE INDEX edges_src_idx ON edges (src_uid, type) WHERE retracted_at IS NULL;
CREATE INDEX edges_dst_idx ON edges (dst_uid, type) WHERE retracted_at IS NULL;
CREATE INDEX edges_session_idx ON edges (src_session_id) WHERE retracted_at IS NULL;
```

(Session, orchestrator, and eval tables are specified in [02](02-sessions-orchestrator.md) and [04](04-evals.md).)

### 8.1 Traversal patterns

Lineage queries use recursive CTEs behind the `GraphQueries` module. Reference shape ("everything upstream of node X via provenance"):

```sql
WITH RECURSIVE up AS (
  SELECT e.* FROM edges e
   WHERE e.dst_uid = $1 AND e.type IN ('produces','updates','derived-from') AND e.retracted_at IS NULL
  UNION ALL
  SELECT e.* FROM edges e JOIN up ON e.dst_uid = up.src_uid
   WHERE e.type IN ('produces','updates','derived-from') AND e.retracted_at IS NULL
)
SELECT * FROM up LIMIT 500;   -- depth/row guards are mandatory on all traversals
```

All traversal endpoints enforce depth and row limits and return a truncation flag rather than unbounded results.

---

## 9. v1 cutline

**In v1:** everything above — four node types, seven edge types, revisions with the five trigger labels, scope with propagation checks, identity tables (multi-team-ready schema, single-team UI), JSONB + edges + Yjs-update-log schema, config git repo with propose-review-commit and UID-based cross-references, link indexer, `GraphQueries` seam.

**Explicitly out (future work):**
- Additional node types (`workstream`, `project`, `idea`) — schema supports registration; none ship in v1.
- Artifact **merges** (multi-parent `derived-from` is stored, but no merge UX/tooling).
- Dedicated graph store (seam documented; adopt only if recursive-CTE traversal becomes a measured bottleneck).
- Cross-Breadboard edges (federation; see [13 — Roadmap](13-roadmap.md)).

## 10. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Per-block vs per-document Y.Doc granularity.** **Decided:** one Y.Doc per node (body array + properties map inside it) — simplest sync unit; revisit if very large Notes strain update-log compaction.
2. **UID collision policy.** **Decided:** 100 random bits makes collision negligible; the insert path retries once on primary-key conflict. No further mitigation.
3. **`body_text` mirror freshness.** **Decided:** refresh on revision cut and on a debounced (≤10 s) head-change listener; search may lag the live head by that much.
4. **Config-repo git backend.** **Decided:** shell out to the **system git binary behind a `ConfigRepo` seam** (an interface the rest of the server codes against, testable with a temp-dir fake). Full merge/diff/revert fidelity is required by propose-review-commit (§6.3), and `isomorphic-git`'s merge support (weak conflict handling, no rename detection) is not up to it; the git binary ships in the server image. This resolves the `isomorphic-git`-or-system-git option left open in [00 — Overview](00-overview.md) §4.
