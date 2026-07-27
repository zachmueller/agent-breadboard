# 00 — Agent Breadboard: Architecture Overview

**Status:** Draft v1
**Audience:** Contributors implementing Agent Breadboard; teams evaluating it.
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

Everything else — dispatch, execution, retries, checkpointing, lineage tracking, cost accounting — is the machine's job.

### 1.2 Design principles

- **Decoupled components.** Each component (Intake, Circuits, Knowledge, Toolbox, Subagents, Sessions, Content) is deliberately decoupled so future extensions can plug into the shared ecosystem without restructuring it.
- **Humans shape, AI proposes.** Every human-maintained component can also be edited by the AI itself (e.g., a meta-operating subagent proposing circuit improvements) — with human gating on configuration changes.
- **Everything is traceable.** Every execution records exactly which configuration versions it used (git commit hashes) and emits lineage edges to everything it produced. "Why did the AI do that?" is always answerable.
- **Declarative flows, code at the leaves.** Circuit flows are introspectable, diffable graphs; arbitrary logic lives in versioned tool-extension code at the leaf steps.
- **Evaluation is first-class.** Circuits carry rubrics and fixtures the way code carries tests. Eval-driven circuit design is the intended workflow.
- **OSS-first.** The core is provider- and auth-agnostic. AWS Bedrock is the first-class *reference* model provider; identity is OIDC-pluggable; the whole system self-hosts on commodity infrastructure. Amazon-internal specifics live in a thin adapter (see [12 — Security & Deployment](12-security-deployment.md)).

### 1.3 Naming

"Breadboard" plays on the *AI circuit* terminology: a breadboard is the reusable base you prototype and rewire circuits on.

---

## 2. Component map

```
                         ┌─────────────────────────────────────────────┐
                         │                   UI (React)                │
                         │  Intake · Circuits · Knowledge · Toolbox ·  │
                         │  Subagents · Content · Sessions             │
                         └───────────────┬─────────────────────────────┘
                                         │ REST + WebSocket (Yjs sync)
┌────────────────────────────────────────┴────────────────────────────────────┐
│                        Breadboard Server (TypeScript/Node)                  │
│                                                                             │
│  ┌───────────┐  ┌────────────────┐  ┌───────────────┐  ┌────────────────┐  │
│  │  Intake   │  │  Orchestrator  │  │  Knowledge    │  │  Toolbox       │  │
│  │  service  │─▶│  (Sessions,    │◀─│  service      │  │  runtime       │  │
│  │           │  │  dispatch,     │  │  (CRDT sync,  │  │  (sandboxed    │  │
│  └───────────┘  │  gates, cost)  │  │  reconcile)   │  │  containers)   │  │
│                 └───────┬────────┘  └───────────────┘  └────────────────┘  │
│  ┌───────────┐          │           ┌───────────────┐  ┌────────────────┐  │
│  │  Content  │◀─────────┴──────────▶│  Model        │  │  Credential    │  │
│  │  + Edges  │                      │  gateway      │  │  broker        │  │
│  └───────────┘                      └───────────────┘  └────────────────┘  │
│                                                                             │
│  ┌──────────────────────┐  ┌─────────────────────┐  ┌───────────────────┐  │
│  │  Postgres             │  │  Config git repo    │  │  Object storage  │  │
│  │  (content plane,      │  │  (configuration     │  │  (large blobs,   │  │
│  │  edges, sessions,     │  │  plane: circuits,   │  │  optional)       │  │
│  │  eval results,        │  │  subagents, tools,  │  └───────────────────┘  │
│  │  Yjs update log)      │  │  presets, tenets)   │                         │
│  └──────────────────────┘  └─────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────────────┘
          │                                     │
          ▼                                     ▼
   LLM providers (Bedrock reference,     External MCP servers,
   provider interface for others)        knowledge connectors
```

How the components relate at a glance:

- **[Intake](08-intake.md)** produces **Tasks** (content nodes). Tasks auto-dispatch into **[Circuits](03-circuits.md)** via hierarchical triage.
- **Circuits** are executed by the **[Orchestrator](02-sessions-orchestrator.md)**; every execution is a **Session** with step-boundary checkpoints, retries, hard gates, and cost tracking.
- Circuit LLM steps run as **[Subagents](05-subagents.md)** — configurations of system prompt, tool access, circuit access, knowledge access, and model preset.
- Subagents act through the **[Toolbox](06-toolbox.md)**: versioned tool extensions running in sandboxed containers, plus centrally-onboarded MCP servers, with credentials held by a broker.
- Subagents read (and collaboratively write) **[Knowledge](07-knowledge.md)**: CRDT-backed Markdown notes organized into Knowledge Domains.
- Everything produced is **[Content](09-content.md)** — Tasks, Artifacts, Comments, Knowledge Notes — connected by typed **edges** in the **[data model](01-data-model.md)**.
- **[Evals](04-evals.md)** grade circuit outputs against versioned rubrics using pinned fixtures.
- The **[UI](10-ui.md)** exposes all of it in the browser; the **[API and MCP server](11-api-mcp.md)** expose it programmatically.

---

## 3. The two-plane data model (summary)

This is the load-bearing distinction in Breadboard. Full detail in [01 — Data Model](01-data-model.md).

| | **Content plane** | **Configuration plane** |
|---|---|---|
| **What** | Instances of work: Tasks, Artifacts, Comments, Knowledge Notes | Definitions that shape how work is done: Subagents, Circuits, Tool extensions, MCP onboarding, model presets, system tenets |
| **Identity** | 20-char Crockford base32 UID | File path in the config git repo |
| **Versioning** | CRDT live-collaborative head + immutable named **revisions** cut at meaningful boundaries | Git; referenced by **commit hash** |
| **Mutation model** | Convergence is the goal — users and AI edit concurrently, no review gate | Discrete versions are the goal — AI edits go through **propose-review-commit** |
| **Storage** | Postgres (JSONB documents + Yjs update log) | Git repository managed by the Breadboard server |

**Sessions are the join between the planes**: each run records the config versions (commit hashes) it used and emits lineage edges to the content it produced. Configuration may *reference* content nodes (e.g., a Subagent injecting a live Knowledge Note into its system prompt), but a content node and a config definition are never the same object.

Content nodes are connected by a typed, directional, bidirectionally-queryable edge graph (`produces`, `updates`, `derived-from`, `attached-to`, `blocks`/`depends-on`, `references`) that powers lineage navigation, comments, backlinks, and task dependencies.

---

## 4. Technology stack

Breadboard is opinionated about its stack so implementation can start immediately. Swappable seams are noted where they exist, but v1 builds exactly this:

| Layer | Choice | Notes / seam |
|---|---|---|
| Server runtime | **Node.js 22+, TypeScript** | Single monolith process (API, orchestrator, CRDT sync). Horizontal scale is a future seam; v1 is one server process. |
| API framework | **Fastify** | REST API + WebSocket upgrade handling. |
| Database | **PostgreSQL 16+** | The only required stateful dependency. Content plane (JSONB), edges, orchestrator event log, sessions, eval results, Yjs update log. A dedicated graph store is a documented future seam if edge-traversal performance demands it. |
| CRDT | **Yjs** | Knowledge Notes and other collaboratively-edited content. Sync via **Hocuspocus** server embedded in the monolith; browser clients use `@hocuspocus/provider`. Persistence = Yjs update log in Postgres with periodic snapshot compaction. |
| Config plane | **Git** (repo managed by the server; system git binary behind a `ConfigRepo` seam — [01](01-data-model.md) §10) | Circuits, Subagents, Tools, presets, tenets. Commit-hash provenance. |
| Tool sandbox | **Docker** (per-execution containers, warm pools) | Runtime seam: any OCI runtime. Resource limits + default-deny egress enforced here. |
| Tool languages | **TypeScript and Python** | Tool extensions may be written in either. |
| Model access | **Model gateway abstraction**; **AWS Bedrock** is the reference provider | Provider interface (`invoke`, `stream`, structured output, token/cost reporting). Additional providers (Anthropic API, OpenAI, local) implement the same interface. |
| UI | **React + TypeScript**, Vite | Flow editor via **React Flow**; collaborative editor via **CodeMirror 6 + Yjs** (Markdown-native). |
| Identity | **OIDC-pluggable**; local-dev static users mode | See [12 — Security & Deployment](12-security-deployment.md). |
| Object storage | **Filesystem by default; S3-compatible optional** | Only for large blobs (artifacts over a size threshold, container logs). |

### 4.1 Tenancy and deployment model

**One deployment = one Breadboard.** Each team self-hosts (or is provisioned) a single-Breadboard instance: one server process, one Postgres, one config repo, one team. This keeps the data model and permission story simple. Cross-team composition happens later via Breadboard-to-Breadboard API federation (future work, see [13 — Roadmap](13-roadmap.md)), not multi-tenancy.

### 4.2 Execution model

**Auto-dispatch with budgets.** New Tasks flow into triage circuits automatically as capacity allows. Capacity is bounded by three mechanisms (detailed in [02 — Sessions & Orchestrator](02-sessions-orchestrator.md)):

1. **Max concurrent runs** (Breadboard-level setting),
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
| [05 — Subagents](05-subagents.md) | Subagent config schema, model presets, system tenets, subagent editor UI. |
| [06 — Toolbox](06-toolbox.md) | Tool extensions, sandbox runtime, credential broker, MCP onboarding, pre-packaged tools, tool editor UI. |
| [07 — Knowledge](07-knowledge.md) | Knowledge Domains, Note format, CRDT collaboration, the AI-edit reconcile mechanism, connectors, search. |
| [08 — Intake](08-intake.md) | Task lifecycle, hierarchical triage, idea-shaping conversations, injection API, intake UI. |
| [09 — Content](09-content.md) | Artifacts (intermediate vs deliverable), need-input tagging, comments, review queue, content viewer. |
| [10 — UI](10-ui.md) | App shell, shared editor infrastructure, designer-chat-panel pattern, per-view specs. |
| [11 — API & MCP](11-api-mcp.md) | REST surface, Breadboard MCP server, event stream, versioning policy. |
| [12 — Security & Deployment](12-security-deployment.md) | Topology, identity, authorization, credential broker, sandbox posture, model gateway, Amazon adapter. |
| [13 — Roadmap](13-roadmap.md) | Build phases, milestone acceptance criteria, v1 cutlines, deferred-items register. |

---

## 6. Glossary

Terms are used with exactly these meanings across all specs.

- **AI circuit / Circuit** — A declarative, versioned graph of steps (LLM or code) encoding how the AI tackles a category of work. Lives in the configuration plane.
- **Ambient context channel** — The closed, system-defined set of values (Task ref, Session ID, budget state, accumulated artifact refs) available to every circuit step alongside its typed inputs.
- **Artifact** — A content node produced by Subagents or code steps. May be **intermediate** (working context passed between steps) or a **deliverable** (intended for user review); tracked identically.
- **Breadboard** — One team's deployment of Agent Breadboard: server + Postgres + config repo + all content.
- **Comment** — A lightweight content node attached to any other node via an `attached-to` edge, optionally anchored to a revision + quote.
- **Configuration plane** — Version-controlled definitions (Subagents, Circuits, Tools, MCP onboarding, model presets, tenets) tracked in git, referenced by commit hash.
- **Content plane** — The typed graph of instances (Tasks, Artifacts, Comments, Knowledge Notes) addressed by UID and tracked by lineage edges.
- **Credential broker** — The service holding all credentials; tools never hold credentials directly and act through it per their capability declarations.
- **Deliverable** — An Artifact intended for user consumption (vs. intermediate). A default UI filter distinction, not a structural one.
- **Edge** — A typed, directional, first-class, bidirectionally-queryable link between nodes: `produces`, `updates`, `derived-from`, `attached-to`, `blocks`, `depends-on`, `references`.
- **Eval / Rubric / Fixture** — An eval grades circuit outputs. A rubric defines typed scoring dimensions. A fixture is a pinned input (usually promoted from a production Session) that eval runs execute the circuit against.
- **Gate (hard gate)** — An orchestrator-level circuit step at which a run suspends (state persisted, no capacity held) until its targeted reviewers record per-artifact `approve`/`request-changes` verdicts; the gate then auto-resolves through its declared `approve` or `changes` exit ([02](02-sessions-orchestrator.md) §5.4).
- **Intake** — The queue of new Tasks plus the machinery (conversations, API, MCP) that fills it.
- **Knowledge Domain** — A named, arbitrary subset of the team's Knowledge Notes; the unit of access scoping for Subagents and Circuits.
- **Knowledge Note / Note** — A durable, human-curated Markdown document, live-collaboratively editable by users and AI via CRDT.
- **Model gateway** — The provider-abstraction layer through which all LLM calls flow; Bedrock is the reference implementation.
- **Model preset** — A Breadboard-level named tier (e.g., `small`/`medium`/`large`) mapping to an ordered fallback list of concrete model IDs.
- **`need-input` tag** — A non-blocking signal on an Artifact that an agent wants direction or review, with optional `role` and `username` targeting. Distinct from hard gates.
- **Node** — Any content-plane object: `task`, `artifact`, `comment`, `knowledge` (extensible).
- **Revision** — An immutable named snapshot of a content node, cut at meaningful boundaries (step completion, gate resolution, explicit publish, pre-AI-edit). Provenance edges bind to revisions; the CRDT head stays mutable.
- **Session** — The recorded execution of one circuit run (or one intake conversation): step-by-step logs, config commit hashes, cost, lineage edges. The join between planes.
- **Step** — One unit within a circuit: an LLM step (subagent + prompt template + tools) or a code step (tool extension). The step boundary is the universal unit of durability, revision, and replay.
- **Subagent** — A named configuration of system prompt, tool/circuit/knowledge access, and model preset defining a narrowly-scoped AI expert.
- **Task** — A content node representing a unit of intended work, queued in Intake and executed via Circuits.
- **Tenets** — Small, strictly-limited system-wide principles injected into all Subagents (configuration plane).
- **Tool extension** — A versioned TypeScript or Python tool built and maintained inside Breadboard, executed in sandboxed containers.
- **Toolbox** — The full set of tool extensions and onboarded MCP servers, with per-Subagent/per-Circuit access configuration.
- **Triage circuit** — A circuit that routes incoming Tasks to handling circuits; hierarchical (top-level → specialized).
- **UID** — 20-character Crockford base32 identifier; immutable primary key of every content node. Links are written `[[UID|title]]`.
