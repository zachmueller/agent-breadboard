# 13 — Roadmap

**Status:** Draft v1
**Depends on:** all component specs. This spec sequences them into buildable phases with acceptance criteria and records everything deliberately deferred.

---

## 1. Sequencing logic

Dependencies drive the order: the data model underlies everything; the orchestrator is the engine every feature runs on; Subagents + Toolbox are prerequisites for any LLM step; Circuits + Evals make execution designable and measurable; Knowledge's CRDT machinery is the deepest independent subsystem; Intake and the review surfaces turn it into a product; connectors and polish complete v1.

Each phase ends **demonstrable** — a runnable increment with its acceptance criteria met — so course-correction happens between phases, not after a big bang.

**Tracer bullet before phase completion (§6).** Implementation begins with a deliberately thin end-to-end slice cutting across the Phase 1–4 territory — minimal data model, config-repo read/commit, orchestrator stepping + restart recovery, model gateway (mock + Bedrock), and one hand-authored two-step circuit, API-only — to de-risk the architectural joints early. Phases are then completed to their acceptance criteria in order, back-filling what the tracer stubbed. The tracer's code is the seed, not a throwaway.

## 2. Phases

### Phase 0 — Skeleton
Repo scaffolding (TS monorepo: `server`, `ui`, `shared`; Node 26 baseline), Fastify server, Postgres migrations harness + connection-config seam (`DATABASE_URL`, TLS/IAM options — [12](12-security-deployment.md) §1), CI (typecheck, tests, lint), compose file with local-Postgres profile, `deploy/aws/` IaC module stub (RDS + reference host; hardened in Phase 7), local-dev auth.
**Accept:** `docker compose up` serves a hello UI against Postgres; the same build boots against an externally-provided `DATABASE_URL`; CI green.

### Phase 1 — Data model & config plane ([01](01-data-model.md))
Identity tables (teams/users/roles/role_memberships) + nodes/revisions/edges/yjs_updates schema + DAL; UID generation; link indexer → `references` edges (derived-index semantics); `GraphQueries` (lineage CTEs with guards); config git repo init + read/commit/propose/merge/revert service with UID-derived paths, `INDEX.md` generation, and the `materializeTree(commitHash)` cache ([01](01-data-model.md) §6); schema validation for `breadboard/*@v1` files (incl. UID reference resolution); core REST for nodes/edges/config ([11](11-api-mcp.md) §3).
**Accept:** create/link/revise nodes via API; lineage queries answer up/down; config proposals round-trip branch→diff→merge with commit-hash reads.

### Phase 2 — Orchestrator core & Sessions ([02](02-sessions-orchestrator.md))
Event log + checkpoints + replay (turns derived from events); dispatcher with the three capacity controls; retry/suspend; hard gates with targeted-reviewer verdicts + auto-resolution; sub-sessions with budget draw-down; cost capture at turn level; sessions REST + scope-filtered SSE topics; model gateway with Bedrock provider (v1's only adapter) + presets/fallback ([12](12-security-deployment.md) §7, [05](05-subagents.md) §4).
**Accept:** a hand-authored two-step circuit (LLM + code stub) runs end-to-end, checkpoints, survives server restart mid-run, suspends at a gate, resumes on verdict completion, records cost and commit hash.

### Phase 3 — Subagents & Toolbox ([05](05-subagents.md), [06](06-toolbox.md))
Subagent schema + resolution (tenets injection, `{{knowledge:…}}` deferred-stub until Phase 5, grants); Docker sandbox with warm pools/limits/egress policy; idempotency journal; credential broker (capabilities, `ctx.fetch`, audit); Breadboard primitives; MCP onboarding; MCP server with core catalog; `spawn-harness` with Claude Code adapter; tool CI on proposals.
**Accept:** an LLM step runs a Subagent that calls a custom TS tool and a Python tool in sandboxes, fetches through a broker capability, and emits an explicit edge; egress off-allowlist is blocked and observable.

### Phase 4 — Circuits & Evals ([03](03-circuits.md), [04](04-evals.md))
`circuit@v1` full validation (declared circuit exits, closed step-exit graph, reachability, schemas, UID reference resolution); all four step kinds wired; ambient channel; routing capture; circuit inventory + editor (React Flow, YAML round-trip, backlinks, version history); **designer chat panel pattern ([10](10-ui.md) §4) built once and applied to all three config editors — circuit, tool, and subagent** (tool/subagent config exists from Phase 3; their editors + chats land here); rubric/fixture schemas; eval runs + results store + the five analysis views; run-evals-on-branch; fixture promotion.
**Accept:** design a three-step circuit in the editor via the designer chat, merge, run it; make a tool edit and a subagent edit through their designer chats; promote a session to a fixture; change the model preset and see a regression comparison.

### Phase 5 — Knowledge ([07](07-knowledge.md))
Block-structured Y.Doc format; Hocuspocus sync in the monolith; update-log persistence + compaction; the reconcile write path with typed failures; pre-ai-edit revisions + attribution map + AI-edit revert; wipeout guardrails; Domains + grants; deterministic injection; `{{knowledge:…}}` live injection (un-stub Phase 3); FTS + pgvector search; Note editor on the shared editor infrastructure; contradiction-pushback shipped pattern.
**Accept:** user and AI edit the same Note concurrently — human keystrokes survive an overlapping AI write; AI blocks display attributed; one-click revert works; `query_knowledge` respects grants in both modes.

### Phase 6 — Intake & Content review ([08](08-intake.md), [09](09-content.md))
Task schema/lifecycle; hierarchical triage + bypass; auto-dispatch integration; `intake-shaper` + dedup/grounded-in-code/contradiction helpers; intake conversation UI + draft Task panel; task inventory; `need-input` tagging/resolution + health metric; comments with anchoring/staleness; content inventory + review queue + content viewer; dashboard ([10](10-ui.md) §2).
**Accept:** an idea shaped in conversation becomes a queued Task, auto-dispatches through triage into a handling circuit, gates, appears in the review queue, and completes to a deliverable whose lineage traces back to the conversation.

### Phase 7 — Connectors & v1 hardening ([07](07-knowledge.md) §8 + cross-cutting)
Connector interface + scheduler + git-repo-of-Markdown reference connector; read-only enforcement; OIDC integration; webhooks; global search; docs (self-hosting guide, config reference, tool-author guide); `deploy/aws/` IaC module hardened to the reference production deployment (RDS default, [12](12-security-deployment.md) §1); load/burn-in on the orchestrator; backup/restore runbook validated.
**Accept:** external repo content syncs, is searchable/injective but not editable; fresh-machine self-host from docs in under an hour; v1 tag.

## 3. v1 cutline register (per component)

The authoritative in/out lists live in each spec's cutline section; this is the roll-up of what v1 **excludes**:

| Deferred item | Source |
|---|---|
| Stakeholder intake view (priority tiering UX, separate capacity pool, promotion flows) | [08](08-intake.md) §9 |
| Auto-pitch intake circuits | [08](08-intake.md) §9 |
| Breadboard-to-breadboard federation (incoming access permissions — blanket or scoped by circuit list/tags; connected-Breadboards UI) | [11](11-api-mcp.md) §7, §5 below |
| Purely-local Breadboards (local storage + orchestration, user-chosen LLM incl. local models) wiring into team Breadboards | §5 below |
| Gate escalation policies (v1: indefinite wait, pull-based queue) | [02](02-sessions-orchestrator.md) §9 |
| Dedicated graph store (seam behind `GraphQueries`) | [01](01-data-model.md) §9 |
| Write-back knowledge connectors; additional connector adapters | [07](07-knowledge.md) §11 |
| Multi-worker orchestrator & multi-node CRDT authority | [02](02-sessions-orchestrator.md) §9, [07](07-knowledge.md) §11 |
| Parallel fan-out/join circuit steps | [03](03-circuits.md) §9 |
| Scheduled eval sweeps, judge calibration, significance testing | [04](04-evals.md) §9 |
| Non-LLM cost capture | [02](02-sessions-orchestrator.md) §6 |
| Artifact merge tooling; digest notifications | [09](09-content.md) §6 |
| Additional node types (`workstream`, `project`, `idea`) | [01](01-data-model.md) §9 |
| Amazon adapter package | [12](12-security-deployment.md) §9 |

## 4. Deployment milestone: internal pilot

The first real deployment target is an **Amazon-internal team pilot**, stood up as soon as Phase 6's acceptance criteria pass (not waiting for Phase 7):

- **Scope is minimal:** internal container hosting + RDS Postgres + internal Bedrock account. Auth remains local-dev static users (banner-marked, [12](12-security-deployment.md) §3) for the pilot; OIDC lands on the normal Phase 7 schedule. No internal knowledge connectors or broker capabilities are pulled forward.
- **Pilot workload is deliberately undecided:** the tracer bullet and phase work stay workload-neutral (the lit-review reference circuit from [03](03-circuits.md) §2 is the running example); the team picks the first dogfood workload when onboarding is imminent.
- The Amazon adapter package proper ([12](12-security-deployment.md) §8) remains post-v1; the pilot uses only configuration, not internal-only code.

## 5. Post-v1 themes (direction, not commitment)

1. **Federation** — Breadboard-to-Breadboard access: Team A's circuits automatically gathering required inputs from stakeholder Team B's Breadboard; per-team incoming-access grants (blanket or scoped to circuit subsets by list/tags); minor UI showing which Breadboards this one can reach and with what access. The v1 seams that keep this open without migration: named capability scopes on service tokens ([11](11-api-mcp.md) §2) as the grant substrate, the multi-team-ready identity schema ([01](01-data-model.md) §8), and the reserved `external` scope ([01](01-data-model.md) §3.4). The full federation design will be written post-v1 when it is actionable.
2. **Local Breadboards** — individual, fully-local instances (storage + orchestration local; LLM = user's choice of local or API) that wire into team Breadboards. The one-deployment-one-Breadboard model and API-first design are the enablers.
3. **Meta-operation depth** — subagents that watch eval trends and need-input rates and proactively propose config improvements (all plumbing exists: proposals + evals-on-branch + metrics).
4. **Scale-out** — orchestrator worker pool, CRDT authority sharding, graph store — each behind an already-documented seam.

## 6. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Build sequencing.** **Decided:** tracer bullet first (§1), then phases 1→7 each completed to its acceptance criteria.
2. **v1 scope trims.** **Decided:** none — v1 ships exactly the per-spec cutlines. Python tool runtime, `spawn-harness`, and the designer chat panels all stay in.
3. **First deployment.** **Decided:** internal team pilot early, per §4 — minimal binding (hosting + Bedrock), static-user auth until Phase 7 OIDC.
4. **First dogfood workload.** **Decided:** deferred — tracer and phase work stay workload-neutral; chosen at pilot onboarding (§4).
