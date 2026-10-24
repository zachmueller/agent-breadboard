# 00 — Agent Breadboard: Architecture Overview

**Status:** v1, implemented: every roadmap phase is built ([13](13-roadmap.md)). The specs remain normative and are revised as decisions land. Implementation state and open acceptance items: [docs/status.md](../docs/status.md).
**Audience:** Contributors building Agent Breadboard; teams evaluating or operating it.
**This document:** The entry point to the spec set. It establishes the vision, the mental model, the component map, the two-plane data model, the concrete technology stack, and the shared glossary. Every other spec assumes you have read this one.

---

## 1. Vision

**Agent Breadboard is a highly extensible, open-source framework for architecting, executing, and maintaining AI circuits.**

An *AI circuit* is a user-designed flow of LLM and code steps that encodes how AI should tackle a category of work. A *Breadboard* is a team's deployment of this framework: their circuits, their subagents, their knowledge, their tools, their task queue, and the full execution history of everything the AI has done — all in one self-hosted system.

### 1.1 The metacognition thesis

The central design bet: the next phase of working with AI is not doing the work yourself, and not hand-holding an AI through the work — it is **designing the processes by which AI conducts the work**.

Software teams already made one shift: from hand-writing code to writing-code-through-AI. Breadboard targets the next shift: when you spot the AI doing something wrong, you don't nudge it in chat and move on. You go straight to the **circuit** (or the relevant **Subagent** definition, **Knowledge Note**, or **Tool**) and implement a durable fix, so every future execution benefits. Improving the circuits is an act of metacognition the team engages in continuously.

Concretely, humans interact with a Breadboard through six touchpoints, all of which are things they *maintain* rather than *operate*:

1. **Intake** — the queue of Tasks the AI will work on, and the idea-shaping conversations that produce well-formed Tasks.
2. **Circuits** — the designed flows the AI follows.
3. **Knowledge** — the durable, curated context the AI draws on.
4. **Toolbox** — the tools and MCP servers the AI can use.
5. **Subagents** — the narrowly-scoped AI expert configurations.
6. **Content review** — reading, commenting on, and unblocking what the AI produces.

Touchpoints 2–5 each have a **designer chat**: an AI that proposes changes to the definition on screen, which a human reviews and merges ([10](10-ui.md) §4). Everything else — dispatch, execution, retries, checkpointing, lineage tracking, cost accounting — is the machine's job.

### 1.2 Design principles

- **Decoupled components.** Each component (Intake, Circuits, Knowledge, Toolbox, Subagents, Sessions, Content) is deliberately decoupled so future extensions can plug into the shared ecosystem without restructuring it.
- **Humans shape, AI proposes.** Every human-maintained component can also be edited by the AI itself (a designer chat, or a meta-operating subagent proposing circuit improvements). Configuration changes are human-gated: the AI opens a **proposal**, a branch with its own review page (native diff, validation, tool checks, evals on the branch), and a human merges or discards it. Content changes converge without a gate, but every AI write is attributed, revertable, and surfaced for review where it matters (e.g., an AI-created Knowledge Note lands in the Review queue).
- **Everything is traceable.** Every execution records exactly which configuration versions it used (git commit hashes) and emits lineage edges to everything it produced. "Why did the AI do that?" is always answerable — from the UI, and from a team member's own harness (e.g., Claude Code) through the MCP server's read-only inspection tools ([11](11-api-mcp.md) §4).
- **Declarative flows, code at the leaves.** Circuit flows are introspectable, diffable graphs; arbitrary logic lives in versioned tool-extension code at the leaf steps.
- **Evaluation is first-class.** Circuits carry rubrics and fixtures the way code carries tests. Eval-driven circuit design is the intended workflow.
- **The core owns the loop.** Every model call, including those made by tool code and by sub-harnesses such as Strands, goes through the model gateway, so it is budgeted, cached, and costed on its Session. Breadboard's own agent loop records every turn, journals every tool call, and enforces budgets. Other harnesses plug in as sandboxed tools (`spawn-harness`, [06](06-toolbox.md) §3), not as replacements for that loop.
- **OSS-first.** The core is provider- and auth-agnostic. AWS Bedrock is the first-class *reference* model provider; identity is OIDC-pluggable; the whole system self-hosts on commodity infrastructure. An organization-internal deployment is the AWS reference deployment plus configuration, with any deployment-only pieces (e.g., an authenticating edge) in a separate private package; a code-level Amazon adapter package is post-v1 (see [12 — Security & Deployment](12-security-deployment.md) §8).

### 1.3 Naming

"Breadboard" plays on the *AI circuit* terminology: a breadboard is the reusable base you prototype and rewire circuits on.

---

## 2. Component map

```
        ┌───────────────────────────────────────────┐  ┌────────────────────────────┐
        │                UI (React)                 │  │  Local harnesses (e.g.,    │
        │  Intake · Circuits · Knowledge · Toolbox  │  │  Claude Code) and API      │
        │  Subagents · Content · Sessions ·         │  │  callers                   │
        │  Proposals · Dashboard                    │  │                            │
        └─────────────────────┬─────────────────────┘  └──────────────┬─────────────┘
                              │ REST + SSE + WebSocket (Yjs sync)     │ MCP + REST (bearer tokens)
┌─────────────────────────────┴───────────────────────────────────────┴──────────────┐
│                        Breadboard Server (TypeScript/Node)                         │
│                                                                                    │
│  ┌───────────┐  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────────┐  │
│  │  Intake   │  │  Orchestrator  │  │  Knowledge      │  │  Toolbox runtime     │  │
│  │  service  │─▶│  (Sessions,    │◀─│  service        │  │  (sandboxed          │  │
│  │           │  │  dispatch,     │  │  (CRDT sync,    │  │  containers, warm    │  │
│  └───────────┘  │  gates, cost)  │  │  reconcile,     │  │  pools, egress proxy)│  │
│                 └───────┬────────┘  │  search)        │  └──────────────────────┘  │
│                         │           └─────────────────┘                            │
│  ┌───────────┐          │           ┌─────────────────┐  ┌──────────────────────┐  │
│  │  Content  │◀─────────┴──────────▶│  Model gateway  │  │  Credential broker   │  │
│  │  + Edges  │                      │  (presets,      │  │  (capabilities,      │  │
│  │           │                      │  caching, cost) │  │  audit log)          │  │
│  └───────────┘                      └─────────────────┘  └──────────────────────┘  │
│                                                                                    │
│  ┌────────────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐  │
│  │  MCP server            │  │  Event stream          │  │  Auth (OIDC, edge    │  │
│  │  (primitives,          │  │  (SSE, webhooks)       │  │  identity, tokens)   │  │
│  │  inspection catalog)   │  │                        │  │                      │  │
│  └────────────────────────┘  └────────────────────────┘  └──────────────────────┘  │
│                                                                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │  Postgres       │  │  Config git     │  │  Repository     │  │  Object       │  │
│  │  (content plane,│  │  repo (circuits,│  │  mirrors (bare  │  │  storage      │  │
│  │  edges, event   │  │  subagents,     │  │  git clones; a  │  │  (large blobs,│  │
│  │  log, sessions, │  │  tools, presets,│  │  cache)         │  │  optional)    │  │
│  │  evals, Yjs log)│  │  tenets)        │  │                 │  │               │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └───────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────┘
          │                                     │                         │
          ▼                                     ▼                         ▼
   LLM providers (Bedrock reference,     External MCP servers,     Mirrored git
   provider interface for others)        knowledge connectors      remotes
```

How the components relate at a glance:

- **[Intake](08-intake.md)** produces **Tasks** (content nodes). Tasks auto-dispatch into **[Circuits](03-circuits.md)** via hierarchical triage.
- **Circuits** are executed by the **[Orchestrator](02-sessions-orchestrator.md)**; every execution is a **Session** with step-boundary checkpoints, retries, hard gates, and cost tracking.
- Circuit LLM steps run as **[Subagents](05-subagents.md)** — configurations of system prompt, tool access, circuit access, knowledge access, repository access, model preset, and optional reasoning effort.
- Subagents act through the **[Toolbox](06-toolbox.md)**: versioned tool extensions running in sandboxed containers, centrally-onboarded MCP servers, and the built-in **Breadboard primitives**. Credentials are held by a broker, and tool code reaches models only through the gateway.
- Subagents read (and collaboratively write and create) **[Knowledge](07-knowledge.md)**: CRDT-backed Markdown notes organized into Knowledge Domains. They can also search and read **repository mirrors**, git repositories that the server keeps clones of ([06](06-toolbox.md) §7.1).
- Everything produced is **[Content](09-content.md)** — Tasks, Artifacts, Comments, Knowledge Notes — connected by typed **edges** in the **[data model](01-data-model.md)**.
- **[Evals](04-evals.md)** grade circuit outputs against versioned rubrics using pinned fixtures; hard gates in eval runs wait for human reviewers as in production.
- **Designer chats** in the circuit, tool, and subagent editors open **proposals** against the config repo; each has a review page, and a human merges it ([10](10-ui.md) §4).
- The **[UI](10-ui.md)** exposes all of it in the browser. The **[REST API and MCP server](11-api-mcp.md)** expose it programmatically: the MCP server serves the primitives (including a read-only inspection catalog) to team members' local harnesses, authenticated with personal access tokens ([12](12-security-deployment.md) §3).

---

## 3. The two-plane data model (summary)

This is the load-bearing distinction in Breadboard. Full detail in [01 — Data Model](01-data-model.md).

| | **Content plane** | **Configuration plane** |
|---|---|---|
| **What** | Instances of work: Tasks, Artifacts, Comments, Knowledge Notes | Definitions that shape how work is done: Subagents, Circuits, Tool extensions, MCP onboarding, model presets, system tenets, `breadboard.yaml` (domains, triage entry point, repository mirrors) |
| **Identity** | 20-char Crockford base32 UID | Same UID scheme; file paths in the config git repo are UID-derived ([01](01-data-model.md) §6.2). Stored references are always UIDs; agent-facing reads also resolve a slug |
| **Versioning** | CRDT live-collaborative head + immutable named **revisions** cut at meaningful boundaries | Git; referenced by **commit hash** |
| **Mutation model** | Convergence is the goal — users and AI edit concurrently, no review gate; AI writes are server-attributed and revertable | Discrete versions are the goal — AI edits go through **propose-review-commit** (a proposal branch, reviewed and merged by a human) |
| **Storage** | Postgres (JSONB documents + Yjs update log) | Git repository managed by the Breadboard server |

**Sessions are the join between the planes**: each run records the config versions (commit hashes) it used and emits lineage edges to the content it produced. Configuration may *reference* content nodes (e.g., a Subagent injecting a live Knowledge Note into its system prompt), but a content node and a config definition are never the same object.

Content nodes are connected by a typed, directional, bidirectionally-queryable edge graph (`produces`, `updates`, `derived-from`, `attached-to`, `blocks`/`depends-on`, `references`) that powers lineage navigation, comments, backlinks, and task dependencies.

---

## 4. Technology stack

Breadboard is opinionated about its stack. Swappable seams are noted where they exist, but v1 is built on exactly this:

| Layer | Choice | Notes / seam |
|---|---|---|
| Server runtime | **Node.js 26+, TypeScript** | Single monolith process: API, orchestrator, CRDT sync, MCP server, credential broker, sandbox egress proxy, connector scheduler, repository mirrors. Horizontal scale is a future seam; v1 is one server process. |
| API framework | **Fastify** | REST API, SSE event stream, WebSocket upgrades (CRDT sync), and the MCP streamable-HTTP endpoint, all under `/api/v1`. |
| Database | **PostgreSQL 16+** | The only external stateful dependency of a team deployment. Content plane (JSONB), edges, orchestrator event log, sessions, eval results, Yjs update log; **pgvector** for semantic search when present. Reached only through a `Db` seam and connection config (`DATABASE_URL` + TLS/IAM options). **AWS RDS is the recommended production default**: the shipped CDK app provisions it, and the server signs in with RDS IAM tokens rather than a password ([12](12-security-deployment.md) §1). A local container (compose) is the dev path; **PGlite** (in-process Postgres with pgvector) behind the same seam is the zero-dependency quickstart and test database. A dedicated graph store is a documented future seam if edge-traversal performance demands it. |
| CRDT | **Yjs** | Knowledge Notes and other collaboratively-edited content; a Note body is a Y.Array of blocks with per-block Y.Text, which keeps attribution and comment anchors stable ([07](07-knowledge.md) §2). Sync via **Hocuspocus** server embedded in the monolith; browser clients use `@hocuspocus/provider`. Persistence = Yjs update log in Postgres with periodic snapshot compaction. |
| Config plane | **Git** (repo managed by the server; system git binary behind a `ConfigRepo` seam with commit-addressed tree materialization — [01](01-data-model.md) §6.3, §10) | Circuits, Subagents, Tools, presets, tenets. UID-named definition paths; commit-hash provenance. |
| Tool sandbox | **Docker** (per-execution containers, warm pools) | Runtime seam: any OCI runtime (gVisor is the documented hardening step). Resource limits + default-deny egress enforced here: tool containers sit on an internal-only network whose only way out is the server's egress proxy. A `process` runner (no isolation) serves the quickstart and the test suites. |
| Tool languages | **TypeScript and Python** | Tool extensions may be written in either. `spawn-harness` runs other agent harnesses in the sandbox (v1: Strands Agents and Strands Harness adapters, [06](06-toolbox.md) §3). |
| Model access | **Model gateway abstraction**; **AWS Bedrock** is the reference provider | Provider interface (`invoke`, optional `stream`, capabilities, cost, embeddings). The gateway owns preset fallback, prompt caching, reasoning replay, and per-turn cost; tool code calls models only through it (`ctx.converse`, [06](06-toolbox.md) §7). **v1 ships Bedrock only** (plus a mock provider for dev and tests); additional providers (Anthropic API, OpenAI, local) are post-v1 and implement the same interface ([12](12-security-deployment.md) §7). |
| UI | **React 19 + TypeScript**, Vite, TanStack Router + Query, Tailwind | Flow editor via **React Flow**; code editing and the collaborative Note editor via **CodeMirror 6**; the Note editor uses a custom Yjs binding over the block model ([10](10-ui.md) §3). |
| Identity | **OIDC-pluggable**, or an authenticating edge's identity; local static users | Native OIDC, or a load balancer's verified OIDC identity header (for a team), or a trusted proxy (for one person). Static users must have real tokens in production, and a bootstrap admin token is the break-glass sign-in. Members mint personal access tokens (read-only by default) for their own tools; service tokens carry named scopes. See [12](12-security-deployment.md) §3. |
| Object storage | **Filesystem by default; S3-compatible optional** | Only for large blobs (artifacts over a size threshold, container logs). |
| Deployment | **One container image**; `docker compose` reference; **AWS reference deployment** as a TypeScript CDK app (`deploy/aws/`) | The CDK app provisions RDS plus one EC2 host that runs the server and tool sandboxes, with secrets generated in Secrets Manager. Image upgrades apply in place ([12](12-security-deployment.md) §1). In production, the server refuses to start without real secrets. |

### 4.1 Tenancy and deployment model

**One deployment = one Breadboard.** Each team self-hosts (or is provisioned) a single-Breadboard instance: one server process, one Postgres, one config repo, one team. This keeps the data model and permission story simple. Cross-team composition happens later via Breadboard-to-Breadboard API federation (future work, see [13 — Roadmap](13-roadmap.md)), not multi-tenancy.

### 4.2 Execution model

**Auto-dispatch with budgets.** New Tasks flow into triage circuits automatically as capacity allows. Capacity is bounded by three mechanisms (detailed in [02 — Sessions & Orchestrator](02-sessions-orchestrator.md)):

1. **Max concurrent runs** (Breadboard-level setting; only orchestrator runs, `circuit-run` and `eval-run`, hold a slot — chats and MCP connections never do),
2. **Per-run budgets** (token/cost ceilings per Session),
3. **Breadboard-level spend rate limit** (e.g., $/hour ceiling across all Sessions).

Humans intervene through gates and review — not by manually starting runs.

---

## 5. Spec index

| Spec | Covers |
|---|---|
| [00 — Overview](00-overview.md) | This document. |
| [01 — Data Model](01-data-model.md) | Content/config planes, node schema, edge taxonomy, revisions, Postgres schema, config repo layout. |
| [02 — Sessions & Orchestrator](02-sessions-orchestrator.md) | Event-sourced execution, dispatch & capacity, retries, hard gates, sub-sessions, cost tracking, session UI. |
| [03 — Circuits](03-circuits.md) | Circuit definition format, step types, typed I/O, routing, composability, gates, circuit editor UI. |
| [04 — Evals](04-evals.md) | Rubrics, fixtures, eval runs, results store, model-regression & cost-optimization workflows, Evals MCP. |
| [05 — Subagents](05-subagents.md) | Subagent config schema, model presets, reasoning effort, system tenets, subagent editor UI. |
| [06 — Toolbox](06-toolbox.md) | Tool extensions, sandbox runtime, credential broker, Breadboard primitives, repository mirrors, MCP onboarding, pre-packaged tools (incl. `spawn-harness`), tool editor UI. |
| [07 — Knowledge](07-knowledge.md) | Knowledge Domains, Note format, CRDT collaboration, the AI-edit reconcile mechanism, AI note creation, connectors, search. |
| [08 — Intake](08-intake.md) | Task lifecycle, hierarchical triage, idea-shaping conversations, injection API, intake UI. |
| [09 — Content](09-content.md) | Artifacts (intermediate vs deliverable), need-input tagging, comments, review queue, content viewer. |
| [10 — UI](10-ui.md) | App shell, shared editor infrastructure, designer-chat-panel pattern and proposal review, per-view specs. |
| [11 — API & MCP](11-api-mcp.md) | REST surface, Breadboard MCP server (primitives, inspection catalog), event stream, versioning policy. |
| [12 — Security & Deployment](12-security-deployment.md) | Topology, AWS reference deployment, identity and tokens, authorization, credential broker, sandbox posture, model gateway, Amazon adapter. |
| [13 — Roadmap](13-roadmap.md) | Build phases, milestone acceptance criteria, v1 cutlines, deferred-items register. |

The `docs/` directory holds the non-normative companions: [architecture](../docs/architecture.md) (where each spec lands in `packages/server`), [self-hosting](../docs/self-hosting.md), [config reference](../docs/config-reference.md), [tool author guide](../docs/tool-author-guide.md), [MCP](../docs/mcp.md) (connecting a local harness), and [status](../docs/status.md) (implementation state and recent decisions).

---

## 6. Glossary

Terms are used with exactly these meanings across all specs.

- **AI circuit / Circuit** — A declarative, versioned graph of steps (LLM or code) encoding how the AI tackles a category of work. Lives in the configuration plane.
- **Ambient context channel** — The closed, system-defined set of values (Task ref, Session ID, budget state, accumulated artifact refs) available to every circuit step alongside its typed inputs.
- **Artifact** — A content node produced by Subagents or code steps. May be **intermediate** (working context passed between steps) or a **deliverable** (intended for user review); tracked identically.
- **Breadboard** — One team's deployment of Agent Breadboard: server + Postgres + config repo + all content.
- **Breadboard primitives** — The closed set of built-in operations (content, knowledge, intake, sessions, evals, config editing, read-only inspection, repository mirrors) offered to tool code via `ctx`, to Subagents through their `primitives` grant, and to MCP clients. Each runs under the caller's grants and token scopes ([06](06-toolbox.md) §7).
- **Comment** — A lightweight content node attached to any other node via an `attached-to` edge, optionally anchored to a revision + quote.
- **Configuration plane** — Version-controlled definitions (Subagents, Circuits, Tools, MCP onboarding, model presets, tenets) tracked in git, referenced by commit hash.
- **Content plane** — The typed graph of instances (Tasks, Artifacts, Comments, Knowledge Notes) addressed by UID and tracked by lineage edges.
- **Credential broker** — The service holding all credentials; tools never hold credentials directly and act through it per their capability declarations.
- **Deliverable** — An Artifact intended for user consumption (vs. intermediate). A default UI filter distinction, not a structural one.
- **Designer chat** — The always-visible chat panel in the circuit, tool, and subagent editors: a `conversation` Session with a designer Subagent that reads the open definition and opens proposals against it ([10](10-ui.md) §4).
- **Edge** — A typed, directional, first-class, bidirectionally-queryable link between nodes: `produces`, `updates`, `derived-from`, `attached-to`, `blocks`, `depends-on`, `references`.
- **Effort** — The optional reasoning effort (`low` … `max`) set on a Subagent and overridable per LLM step; models that do not reason ignore it ([05](05-subagents.md) §3).
- **Eval / Rubric / Fixture** — An eval grades circuit outputs. A rubric defines typed scoring dimensions. A fixture is a pinned input (usually promoted from a production Session) that eval runs execute the circuit against.
- **Gate (hard gate)** — An orchestrator-level circuit step at which a run suspends (state persisted, no capacity held) until its targeted reviewers record per-artifact `approve`/`request-changes` verdicts; the gate then auto-resolves through its declared `approve` or `changes` exit ([02](02-sessions-orchestrator.md) §5.4).
- **Intake** — The queue of new Tasks plus the machinery (conversations, API, MCP) that fills it.
- **Knowledge Domain** — A named, arbitrary subset of the team's Knowledge Notes; the unit of access scoping for Subagents and Circuits.
- **Knowledge Note / Note** — A durable, human-curated Markdown document, live-collaboratively editable by users and AI via CRDT. An AI may also create one; it is live at once and flagged for review ([07](07-knowledge.md) §5.5).
- **Model gateway** — The provider-abstraction layer through which all LLM calls flow, those of tool code and sub-harnesses included. It owns preset fallback, prompt caching, reasoning replay, and per-turn cost. Bedrock is the reference implementation.
- **Model preset** — A Breadboard-level named tier (e.g., `small`/`medium`/`large`) mapping to an ordered fallback list of concrete model IDs.
- **`need-input` tag** — A non-blocking signal on a content node (usually an Artifact; an AI-created Note gets one too) that an agent wants direction or review, with optional `role` and `username` targeting. Distinct from hard gates, which create gate-flagged requests of their own.
- **Node** — Any content-plane object: `task`, `artifact`, `comment`, `knowledge` (extensible).
- **Personal access token** — A `bbu_…` token a member mints on their Account page for their own tools (e.g., a local harness over MCP): read-only by default, expiring, revocable ([12](12-security-deployment.md) §3).
- **Proposal** — A pending configuration change (`prp_…`): commits on a branch of the config repo, opened by a designer chat, the AI, or the API, with a review page (native diff, validation, tool checks, evals on the branch). A human merges or discards it. A **draft** proposal is staged outside the review queue so its author can run and evaluate the branch first, then submit it for review ([01](01-data-model.md) §6.3).
- **Repository mirror** — A git repository declared in `breadboard.yaml` `repos:` that the server keeps a bare clone of. Subagents with a `repos` grant search and read it with `search_repo` / `read_repo_file`, and every result cites the commit it was read at ([06](06-toolbox.md) §7.1).
- **Revision** — An immutable named snapshot of a content node, cut at meaningful boundaries (step completion, gate resolution, explicit publish, pre-AI-edit). Provenance edges bind to revisions; the CRDT head stays mutable.
- **Session** — The recorded execution of one circuit run or one user↔AI conversation (Intake idea shaping, designer chat, an external MCP connection): step-by-step logs, config commit hashes, cost, lineage edges. The join between planes. Kinds: `circuit-run`, `intake`, `conversation`, `eval-run` ([02](02-sessions-orchestrator.md) §2).
- **Step** — One unit within a circuit: an LLM step (subagent + prompt template + tools) or a code step (tool extension). The step boundary is the universal unit of durability, revision, and replay.
- **Subagent** — A named configuration of system prompt, tool/circuit/knowledge/repository access, model preset, and optional reasoning effort defining a narrowly-scoped AI expert.
- **Task** — A content node representing a unit of intended work, queued in Intake and executed via Circuits.
- **Tenets** — Small, strictly-limited system-wide principles injected into all Subagents (configuration plane).
- **Tool extension** — A versioned TypeScript or Python tool built and maintained inside Breadboard, executed in sandboxed containers.
- **Toolbox** — The full set of tool extensions, onboarded MCP servers, and Breadboard primitives, with per-Subagent/per-Circuit access configuration.
- **Triage circuit** — A circuit that routes incoming Tasks to handling circuits; hierarchical (top-level → specialized).
- **UID** — 20-character Crockford base32 identifier; immutable primary key of every content node, and the identity (and file path) of every config definition ([01](01-data-model.md) §6.2). Links are written `[[UID|title]]`. Runtime records use prefixed IDs instead (`ses_` sessions, `trn_` turns, `prp_` proposals, `nir_` need-input requests, `evr_` eval runs).
