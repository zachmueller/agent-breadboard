# 07 — Knowledge

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** [05 — Subagents](05-subagents.md) (access + dynamic injection), [06 — Toolbox](06-toolbox.md) (knowledge primitives), [10 — UI](10-ui.md) (shared editor)

---

## 1. Purpose & principles

Knowledge is the durable, curated context Subagents draw on — both **built-in Knowledge Domains** maintained inside Breadboard and (read-only) **connectors** into teams' existing knowledge sources.

- **Humans actively curate.** LLMs don't learn the way humans do; the intended behavior is users constantly pruning and refining what the AI captures. The system is built for *joint* maintenance: users and AI edit the same living documents.
- **Live collaboration, no review gate.** Knowledge Notes are content plane: CRDT convergence is the goal ([01](01-data-model.md) §1). AI edits are attributed and revertible, not gated.
- **Narrow access.** Subagents and Circuits see only the Domains they're granted — keeping each scope focused on exactly what it needs in the moment.

## 2. Knowledge Notes

A Knowledge Note is a `knowledge`-type content node ([01](01-data-model.md) §5):

- **Markdown only** — restricting to Markdown syntax keeps formatting simple. No rich-text schema.
- **Identity:** the Note's UID is a 20-char Crockford base32 string; it is the filename/primary key. The human-readable title lives in frontmatter and may change over time without breaking links.
- **Linking:** Obsidian-style `[[UID|title]]` links ([01](01-data-model.md) §3.2); backlinks are materialized as `references` edges and surfaced in the editor.
- **CRDT structure:** the body is a block-structured Yjs document — a `Y.Array` of blocks, each `{ id: server-minted stable 10-char ID, ytext: Y.Text of Markdown source }`; frontmatter/properties are a **separate `Y.Map`** (clean per-key merge semantics instead of interleaved text conflicts). One `Y.Doc` per Note.
- **Revisions** per the shared model ([01](01-data-model.md) §3.3), including the `pre-ai-edit` trigger (§5.4).

## 3. Knowledge Domains

Each Domain is a named, **arbitrary subset** of the team's Knowledge Notes. Examples: a glossary of key terms; detailed insights about each dataset in the data lake; production-code knowledge; conceptual expertise for the team's area; accumulated learnings about stakeholders' priorities and preferences.

- Domains are defined in the content plane as a property on Notes (`domains: [glossary, datasets]`); a Note may belong to multiple Domains; Domain slugs are declared centrally (in `config/breadboard.yaml`) so grants can be validated.
- **Selective access:** Subagents and Circuits (or steps within circuits) are granted read/write per Domain ([05](05-subagents.md) §2.4). All knowledge primitives (`query_knowledge`, `read_note`, `propose_note_edit`) enforce grants server-side.

## 4. Deterministic context injection

Beyond retrieval, Breadboard supports **deterministic inclusion** of Domain content: rule-based injection configured per Domain.

```yaml
# in config/breadboard.yaml
knowledge_injection:
  - domain: dataset-insights
    trigger: { kind: reference-match, pattern: "table:([a-z_]+)" }   # e.g., a specific table being referenced
    inject: { notes_tagged: "table:$1" }                            # auto-inject matching Notes into context
    max_notes: 3
```

When a step's input or conversation references a matching pattern (e.g., a specific table name), the matching Notes are injected into the context window automatically — no retrieval roulette for known-critical context. Injections are recorded in the Session log (Note UID + revision).

(The other deterministic path is Subagent-level `{{knowledge:UID}}` system-prompt injection — [05](05-subagents.md) §2.1.)

## 5. The AI edit mechanism (LLM ↔ CRDT)

This section resolves the note's open item on translating LLM text edits into CRDT operations. The design adopts a **snapshot-based three-way merge**: the AI edits a pinned snapshot of the document as plain Markdown; the server reconciles the result into minimal CRDT operations against that snapshot; CRDT semantics merge the result with any concurrent human edits.

### 5.1 Why not the alternatives

- *LLM emits raw CRDT ops:* models are unreliable at positional operations against a moving document; rejected.
- *LLM string-replace applied directly to storage:* bypasses merge semantics; concurrent human edits get clobbered or duplicated; rejected — every AI write goes through the reconcile path below, regardless of how the LLM expressed the edit.
- *Full-rewrite diffed against the live head:* racing the head makes attribution and conflict semantics ambiguous; diffing against a **pinned base** is strictly better and equally simple for the model.

### 5.2 Write protocol

The `propose_note_edit` primitive (tool/MCP surface) implements:

1. **Read pinned.** The AI first reads the Note via `read_note`, which returns the rendered Markdown **plus a `base_revision`** (a revision is cut on demand if the head has moved since the last one). The AI edits freely — full revised Markdown is the wire format (find/replace-style tool interfaces may be offered to the model for convenience, but they are applied to the *snapshot text* server-side and normalized to a full revised document before reconcile).
2. **Pre-AI-edit revision.** On write, the server cuts a `pre-ai-edit` revision of the current head ([01](01-data-model.md) §3.3) — this is both the audit point and the one-click revert target.
3. **Reconcile (three-way).** In a worker, the server:
   - parses the AI's revised Markdown into blocks (same block segmentation as the stored structure);
   - runs a **block-level LCS diff** between the *base revision's* blocks and the AI's blocks, fingerprinting blocks by normalized content;
   - classifies each block as retain / delete / replace / insert, **preserving stable block IDs** for retained and edited blocks (an edited block keeps its ID; only true inserts mint new IDs);
   - applies the resulting operations to a Y.Doc reconstructed from the base revision, inside a single transaction tagged with the AI origin;
   - encodes **only the delta since the base revision's state vector** as a Yjs update.
4. **Merge onto live head.** The update is applied to the live document on the authority process. Because the delta is expressed against the base revision, **concurrent human edits merge via normal CRDT semantics** — the AI's update only touches the blocks it changed; same-block concurrent edits resolve by CRDT ordering (last-writer-wins at the character level within the block).
5. **Respond with reality.** The response returns `{ applied: true, had_concurrent_edits, merged_markdown, new_head_revision }` — the AI always receives the actual post-merge document so its mental model re-syncs before any follow-up edit.

Failure modes are typed and instructive (the AI must be able to self-correct): `base-revision-too-old` (compaction removed the base; re-read), `parse-failed` (with reason), `grant-denied`, `note-not-found`.

### 5.3 Attribution & revert

- **Server-authoritative attribution.** Every Yjs transaction carries an origin; AI writes are tagged with `{kind: subagent, uid, session_id}` **by the server** (the subagent's config UID; display slug resolvable from it) — clients are never trusted to self-report authorship. Origins are persisted per update in the `yjs_updates` log ([01](01-data-model.md) §8) and stamped per changed block into a sibling attribution map (`Y.Map`: block ID → `{actor, at}`) so the editor can render per-block authorship.
- **Users can see and revert AI edits:** the editor renders AI-attributed spans/blocks distinctly (toggleable), and each AI write's `pre-ai-edit` revision enables one-click revert of that write (revert = server-computed reverse delta applied as a new transaction — history is never rewritten).

### 5.4 Comment/quote anchoring for AI

When the AI attaches a Comment with a quote anchor ([09 — Content](09-content.md) §4), anchor resolution is content-based (quote + surrounding context matched against the head, tiered from exact to fuzzy) and **never guesses on ambiguity**: resolution returns typed failures `not_found | ambiguous | unmappable`, surfaced to the AI so it can retry with more context.

## 6. Sync & persistence

- **Single authority process** (the Breadboard monolith) runs the CRDT sync server (Hocuspocus). Browser clients connect via WebSocket provider; presence/awareness included. v1 explicitly avoids multi-node document authority — a doc lives in one process's memory.
- **AI writes go through the server directly** (the reconcile path above operates on the authority's live doc) — the AI is never a fake WebSocket client. Broadcasts to connected editors and persistence flow through the same pipeline as human edits.
- **Persistence:** every incoming update is appended to `yjs_updates` (with origin) — fine-grained history, not just snapshots. Debounced full-state snapshots are written into node revisions on the standard triggers, plus a periodic compaction revision when the update log since the last snapshot exceeds a threshold. Compaction folds updates older than the latest revision into it and prunes them; `read_note` base revisions are guaranteed retrievable for a configurable window (default 24h) so in-flight AI edits don't lose their merge base.
- Guardrails (cheap, high value): content-wipeout detection (a single transaction deleting >90% of a Note flags and requires confirm when human-originated, auto-suspends and surfaces to review when AI-originated); document size warning threshold.

## 7. Contradiction pushback (aspirational, spec'd as a pattern)

The goal: some Subagents **proactively push back on user input that contradicts existing Knowledge** — surfacing whether the knowledge base is outdated or the user's decision should change based on the resurfaced knowledge. Not a special subsystem — a Subagent pattern:

- A shipped `knowledge-checker` Subagent config + prompt pattern: given a claim/decision from a conversation, `query_knowledge` for related Notes, compare, and if contradiction is detected, respond with the conflicting Note excerpts (`[[UID|title]]` links) and ask the human to resolve: update the Note or reconsider the input.
- Wired in two places by default: the Intake idea-shaping circuit ([08](08-intake.md) §5) and available as a step in any circuit.
- Resolution is human: either edit the Note (possibly via the AI) or proceed with the decision (optionally leaving a Comment on the Note recording the exception).

## 8. Knowledge connectors (read-only, v1)

Connectors let Breadboard read and ingest context from knowledge sources teams already have. **v1 is read-only** — Breadboard prioritizes maintaining any modifications within its internal Knowledge Domains; external sources are references, not write targets.

- **Connector interface** (implemented as a special class of tool extension with a scheduler):
  ```
  list(cursor) -> [{external_id, title, updated_at}]     # incremental enumeration
  fetch(external_id) -> {markdown, metadata}             # content normalized to Markdown
  ```
- **Sync model:** per-connector schedule (default: 6h incremental). Fetched documents are materialized as `knowledge` nodes tagged `connector:<uid>` (the connector's config UID, per [01](01-data-model.md) §6.2; UI renders the slug) and `read-only`, in Domains configured per connector, with `external_id`/`source_url` in properties. Re-sync updates the node (server-origin transaction); local edits to connector-owned Notes are blocked in the editor and via `propose_note_edit` (typed failure `read-only-source`).
- Connector-sourced Notes participate fully in search, RAG, deterministic injection, and linking.
- **v1 ships one reference connector** (generic: a Git-repo-of-Markdown connector — covers wikis-as-repos and docs-as-code) plus the interface for building more (Confluence/SharePoint/Quip-style connectors are future adapters).

## 9. Search

- **Text search:** Postgres FTS over title + aliases + `body_text` ([01](01-data-model.md) §3.1, §8), filtered by Domain grants.
- **RAG-style querying:** embedding index (pgvector) over Note chunks, same grant filtering; `query_knowledge` exposes `mode: text | semantic | hybrid`. Embedding refresh piggybacks on the `body_text` mirror refresh.

## 10. UI

- **Knowledge Domains search:** a simple search interface (text or RAG mode) surfacing relevant Notes; results allow quick preview or opening in the editor. Domain and tag filters; connector-sourced content visibly badged.
- **Knowledge Note editor:** fully-in-browser live-collaboration editor (CodeMirror 6 + Yjs; shared editor infrastructure, [10 — UI](10-ui.md) §3):
  - Markdown editing with live preview; frontmatter/properties panel (the `Y.Map`).
  - Live presence/awareness; per-block attribution display with AI-edit highlighting and one-click AI-edit revert (§5.3).
  - `[[…]]` autocomplete (search-as-you-type over titles, inserts `[[UID|title]]`); backlinks panel (incoming `references` edges).
  - Revision history browser with diff view and restore.

## 11. v1 cutline

**In:** Notes with block-structured CRDT + separate properties map; Domains + grant enforcement; deterministic injection; the full AI-edit reconcile mechanism with attribution + revert; single-authority sync with update-log persistence + compaction; contradiction-pushback shipped pattern; read-only connectors with one reference connector; text + semantic search; both UI views.

**Out (future):** write-back connectors; multi-node document authority; per-Domain embedding models; knowledge graph auto-extraction; scheduled knowledge-gardening circuits (AI proposing prunes/merges of stale Notes — composes from existing pieces, deferred as a shipped pattern).

## 12. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Block segmentation rule.** **Decided:** a "block" for reconcile purposes is a top-level Markdown block (paragraph, heading, list item group, code fence, table) per CommonMark AST — deterministic and matches editor structure.
2. **Same-block conflict UX.** **Decided:** accept CRDT character-level interleave within a block for v1 (rare in practice); rely on attribution highlighting + revisions for recovery.
3. **Embedding model choice.** **Decided:** embeddings route through the model gateway like everything else (Bedrock reference); local option post-v1.
4. **Editor ↔ block-CRDT binding.** **Decided:** keep the Y.Array-of-blocks model (§2) and build a **custom CodeMirror 6 binding** that presents one concatenated Markdown document and maps editor changes back to the per-block Y.Texts (splitting/merging blocks on boundary edits, minting IDs only for true inserts — same classification as the reconcile path, §5.2). This preserves per-block attribution, stable block IDs, and comment anchoring exactly as specified; the off-the-shelf `y-codemirror` binding (single Y.Text) was rejected because it would forfeit all three. Acknowledged as the priciest single UI component ([10 — UI](10-ui.md) §3); lands with this spec's phase ([13 — Roadmap](13-roadmap.md) Phase 5).
