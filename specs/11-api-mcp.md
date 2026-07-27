# 11 — API & MCP

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** every component spec (this is the programmatic surface over all of them), [12 — Security & Deployment](12-security-deployment.md) (auth)

---

## 1. Principles

- **One API, three consumers:** the browser UI, external integrations (team pipelines), and the Breadboard MCP server all speak the same REST API. No privileged side doors.
- **Grants are enforced at the API layer** — the same Subagent/user permission checks regardless of entry path.
- **Everything observable:** any state the UI can show is fetchable; any mutation the UI can make has an endpoint.

## 2. Conventions

- Base path `/api/v1`. JSON bodies; `snake_case` fields.
- **Auth:** `Authorization: Bearer <token>` — user tokens via OIDC session, service tokens for API callers, internal actor tokens for sandbox/tool calls ([12](12-security-deployment.md) §3). Every request resolves to an **actor** (`user | subagent | code-step | service`) recorded on all writes. This is the **single actor taxonomy** system-wide: `created_by`/authorship fields use the same four kinds ([09](09-content.md) §2.2 aligns to this; `service` replaces the earlier `system` label — server-internal writes such as connector syncs record `service` with the internal component as the ID).
- **Service-token scoping:** service tokens carry **named capability scopes** (OAuth-style strings: `tasks:write`, `sessions:read`, `config:propose`, `mcp:call`, …), enforced by a middleware map of endpoint → required scope. Scopes are human-readable in the admin UI and are the designated substrate for future federation grants (e.g., `federation:incoming` scoped by circuit tags) — no endpoint-pattern grammar needed.
- **Pagination:** cursor-based (`?cursor=…&limit=…`, default 50, max 200); responses carry `next_cursor`.
- **Filtering:** query params per resource (documented per endpoint); repeated params OR within a field, distinct params AND across fields.
- **Errors:** `{error: {code, message, detail?}}` with stable machine-readable `code`s (e.g. `grant-denied`, `base-revision-too-old`, `validation-failed`). Typed failure codes match the ones named in component specs.
- **Idempotency:** mutating endpoints accept `Idempotency-Key`; retried keys return the original result.

## 3. REST resources (by component)

### Content & edges ([01](01-data-model.md), [09](09-content.md))
```
GET    /nodes                        ?type=&tag=&scope=&need_input_role=&circuit=&q=&created_after=
POST   /nodes                        create (type, title, properties, body, tags, scope)
GET    /nodes/:uid                   head state
PATCH  /nodes/:uid                   properties/tags/scope updates (non-CRDT fields)
DELETE /nodes/:uid                   soft delete
GET    /nodes/:uid/revisions         list;  GET /nodes/:uid/revisions/:rev
POST   /nodes/:uid/revisions         cut a 'publish' revision
GET    /nodes/:uid/edges             ?direction=in|out&type=…
GET    /nodes/:uid/lineage           ?direction=up|down&depth=  (guarded traversal, 01 §8.1)
POST   /edges                        emit explicit edge (derived-from|attached-to|blocks|depends-on|references)
DELETE /edges/:id                    tombstone
POST   /nodes/:uid/comments          create comment (body, anchor?)
POST   /nodes/:uid/need-input        create request {role?, username?, prompt?} → {request_id}  (multi-request, [09] §3)
POST   /nodes/:uid/need-input/:request_id/resolve
POST   /nodes/:uid/gate-verdict      {request_id, verdict: approve|request-changes, comment?, edits?}
                                     (targeted reviewer only; gate auto-resolves when verdicts complete, [02] §5.4)
GET    /review-queue                 current user's queue (open need-input requests + gating artifacts)
```

### Knowledge ([07](07-knowledge.md))
```
GET    /knowledge/search             ?q=&mode=text|semantic|hybrid&domain=…   (grant-filtered)
GET    /knowledge/:uid               rendered markdown + base_revision   (the read_note contract)
POST   /knowledge/:uid/edits         the propose_note_edit reconcile path: {base_revision, markdown}
                                     → {applied, had_concurrent_edits, merged_markdown, new_head_revision}
POST   /knowledge/:uid/revert-ai-edit  {pre_ai_edit_revision}
WS     /sync                         Yjs sync endpoint (editor clients). Auth: opening a document requires
                                     the same read grant as GET /nodes/:uid (scope + domain checks evaluated
                                     at doc-open; write ops additionally require edit rights) — [12] §4.
```

### Tasks & intake ([08](08-intake.md))
```
POST   /tasks                        create (title, body, priority?, target_circuit?, draft?)
GET    /tasks                        inventory filters (status, priority, origin, tag, circuit, date)
POST   /tasks/:uid/accept | reject | promote
GET    /tasks/similar                ?q=   (dedup helper surface)
```

### Sessions & orchestrator ([02](02-sessions-orchestrator.md))
```
GET    /sessions                     ?state=&kind=&circuit=&task=&created_after=
GET    /sessions/:id                 summary (incl. cost aggregates, parent/children)
GET    /sessions/:id/events          ?after_seq=
GET    /sessions/:id/steps/:step/turns
POST   /sessions/:id/retry | cancel | resume
POST   /sessions/:id/promote-fixture {fixture_title}
```

### Configuration plane ([03](03-circuits.md), [05](05-subagents.md), [06](06-toolbox.md))
```
GET    /config/tree                  ?ref=commit|branch      list definitions (uid, slug, path, title per entry)
GET    /config/search                ?q=          search definitions by slug/title (backs global search, [10] §2)
GET    /config/definitions/:uid      parsed + validated definition, resolved via the UID→path index
                                     ([01] §6.2; same shape for circuits, subagents, tools, mcp, presets, tenets)
POST   /config/proposals             {changes: [{path, content}], message}  → branch + proposal id
GET    /config/proposals/:id         diff, validation results, eval results
POST   /config/proposals/:id/merge | discard
POST   /config/revert                {path, to_commit}
GET    /config/history               ?path=
```

### Evals ([04](04-evals.md))
```
POST   /evals/runs                   {circuit, ref?, fixture_tags?, model_overrides?}
GET    /evals/runs                   ?circuit=;  GET /evals/runs/:id  (results incl. per-dimension)
GET    /evals/analysis/:circuit      ?view=model-regression|cheapest-model|circuit-regression|trend
```

## 4. The Breadboard MCP server

A built-in MCP server exposing Breadboard to LLM consumers — both **internal** (Subagent tool loops call these same tools, mediated by grants) and **external** (a team member's local harness, e.g. Claude Code, connecting with their user token).

**Core tool catalog** (mirrors the Toolbox primitives, [06](06-toolbox.md) §3/§7):

| Tool | Backs |
|---|---|
| `create_task`, `find_similar_tasks` | Intake injection ([08](08-intake.md) §5) |
| `create_artifact`, `update_artifact` | Content production |
| `add_comment` | Comments w/ anchor resolution (typed failures) |
| `emit_edge` | Explicit lineage ([01](01-data-model.md) §4.3) |
| `tag_need_input`, `resolve_need_input` | Review signaling (per-request IDs, [09](09-content.md) §3) |
| `query_knowledge`, `read_note`, `propose_note_edit` | Knowledge incl. the reconcile path ([07](07-knowledge.md) §5) |
| `run_circuit`, `get_session_summary` | Session composition (grant-gated) |
| `record_score`, `get_rubric` | Evals MCP ([04](04-evals.md) §5) |
| `propose_config_change`, `read_config`, `validate_config` | Designer chats / meta-operation |

Plus: **tool extensions with `exposure.external_mcp: true` are appended to the external catalog** dynamically ([06](06-toolbox.md) §8) — shared team tooling usable from local harnesses without re-implementing MCP servers.

External connections authenticate per-user; all calls execute under that user's grants and are logged (as `service`-actor Sessions) like everything else.

## 5. Event stream

Push channel for state changes (the UI's live updates and teams' automation hooks):

- **SSE** `GET /api/v1/events?topics=…` (UI, simple consumers) and **webhooks** (`config/breadboard.yaml` registrations with HMAC signing) for server-to-server.
- Topics: `session.state` (queued/running/suspended-gate/suspended-error/completed/cancelled transitions — gate suspensions are the flagship use), `task.status`, `need-input.tagged` / `need-input.resolved`, `config.committed`, `eval.run-completed`.
- **Scope-filtered per subscriber:** SSE events are filtered against the subscriber's visibility before delivery — events about `session`-scoped nodes or Sessions the subscriber can't read are not delivered, consistent with "scope enforced on every read path" ([12](12-security-deployment.md) §4). Webhook registrations are admin-configured and receive team-visible events only.
- Payloads carry IDs + minimal summary; consumers fetch detail via REST (where grants are enforced again). Delivery is at-least-once; consumers dedupe on event id.

## 6. Versioning policy

- Path-versioned (`/api/v1`). **Additive changes** (new fields, endpoints, event topics, tool parameters with defaults) do not bump the version; clients must tolerate unknown fields.
- Breaking changes require `/api/v2` with a deprecation window running both.
- The MCP tool catalog follows the same rule: tool schemas only gain optional parameters within a major version.
- Config schemas (`breadboard/*@v1`) version independently; the server reads all schema versions it has migrations for.

## 7. v1 cutline

**In:** everything in §2–§6 (the REST surface, MCP server with the core catalog + dynamic exposure, SSE + webhooks, v1 versioning).

**Out (future):** GraphQL/read-model layer; bulk import/export endpoints; federation APIs (Breadboard-to-Breadboard access — designed atop this same surface with scoped service tokens; see [13 — Roadmap](13-roadmap.md)); rate-limit tiers per token (v1: one global default).
