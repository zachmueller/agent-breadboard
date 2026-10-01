# Server architecture & module conventions

This is the implementer's map of `packages/server`. The specs in `specs/` are normative; this document says where each spec lands in code and the conventions every module follows.

## Layout

```
packages/
  shared/            @breadboard/shared — UIDs, actor taxonomy, node/edge types, need-input grammar,
                     wiki links, template engine, JSON Schema helper, zod schemas for breadboard/*@v1, API DTOs
  sandbox-runtime/   @breadboard/sandbox-runtime — the ctx contract tool code sees (TS + Python runners)
  server/            @breadboard/server — the monolith
    migrations/      SQL, applied in order by src/db/migrate.ts
    src/
      core/          env, logger, object store, Principal, Services interfaces, build (wiring)
      db/            Db seam: pg (RDS/managed) + pglite (embedded dev/test)
      content/       NodeStore, EdgeStore, GraphQueries (the graph seam), LinkIndexer, scope rules, ContentService
      identity/      teams/users/roles/service tokens
      config/        ConfigRepo (system git seam), ConfigService (validation, proposals, INDEX.md), seed
      orchestrator/  SessionStore, Orchestrator (stepping/gates/retries/sub-sessions), Dispatcher
      gateway/       ModelGateway, Bedrock + Mock providers, presets/fallback, pricing
      subagents/     SubagentRuntime: resolution (tenets, {{knowledge:…}}), tool surface, conversation loop
      toolbox/       Toolbox (journal, settings), sandbox runners (docker/process), egress proxy, broker, MCP clients, primitives
      knowledge/     Y.Doc block model, Hocuspocus sync, reconcile (three-way), search, injection, connectors
      intake/        TaskService, ConversationService
      evals/         EvalService (runs, results store, analysis views, fixture promotion)
      events/        EventBus (outbox, SSE, webhooks)
      auth/          AuthService (local static users, OIDC, service tokens, actor tokens)
      mcp/           Breadboard MCP server (streamable HTTP) over the primitives + external tools
      api/           Fastify route modules, one per area, all under /api/v1
      test/          shared test harness (PGlite in-memory)
  ui/                @breadboard/ui — React 19 + Vite + TanStack Router/Query + Tailwind + React Flow + CodeMirror 6
config-seed/         the shipped configuration repo contents (copied into a fresh repo on first boot)
deploy/              compose.yaml, Dockerfile(s), aws/ CDK app (TypeScript)
docs/                self-hosting, config reference, tool-author guide
```

## Conventions

- **Interfaces first.** Every subsystem implements an interface from `src/core/services.ts` and exports a `create<Name>(deps)` factory. Cross-subsystem calls go through the `Services` container, never by importing another subsystem's class.
- **Grants are enforced in services, not routes.** Every service method that reads or writes content takes the caller's `Principal` and enforces scope + grants itself, so REST, MCP, and in-process tool loops behave identically ([11] §1).
- **Actors on every write.** `created_by` / origins use the four-kind actor taxonomy (`user | subagent | code-step | service`).
- **UIDs everywhere.** Config cross-references are UIDs; slugs are display metadata. Content links are `[[UID|title]]`.
- **Errors** are `BreadboardError(code)` with the stable codes in `@breadboard/shared`; routes never hand-roll error bodies.
- **SQL** is plain parameterized strings against the `Db` seam. Multi-statement scripts use `exec`. Bigint/numeric come back as JS numbers; bytea as Buffer.
- **Tests** use `src/test/harness.ts` (PGlite in-memory). Anything needing a model uses the `mock` provider; anything needing a sandbox uses the `process` runner.
- **Logging** via the pino child logger on `services.log`.
- **No new dependencies** without a reason; prefer Node built-ins.
