# Agent Breadboard

**A highly extensible, open-source framework for architecting, executing, and maintaining AI circuits.**

An *AI circuit* is a user-designed flow of LLM and code steps encoding how AI should tackle a category of work. A *Breadboard* is a team's self-hosted deployment of this framework: their task intake, circuits, subagents, knowledge base, toolbox, and the full traceable execution history of everything the AI has done.

The core thesis: the next phase of working with AI is designing the *processes* by which AI conducts the work — when you spot the AI doing something wrong, you fix the circuit (or subagent, knowledge, or tool), not the chat.

## Quickstart

```bash
npm ci && npm run build
cp .env.example .env     # embedded Postgres, mock model provider, local sandbox — zero external dependencies
npm start                # http://localhost:4000 — log in with dev-admin-token-change-me
```

Or `docker compose -f deploy/compose.yaml --profile local-postgres up --build`. See [docs/self-hosting.md](docs/self-hosting.md) for production (AWS RDS + Bedrock + Docker sandboxes).

## Layout

| Path | What |
|---|---|
| `specs/` | the specification set — start with [00 — Overview](specs/00-overview.md) |
| `packages/shared` | UIDs, actor taxonomy, node/edge types, template engine, config schemas, API DTOs |
| `packages/server` | the monolith: REST API, orchestrator, config git repo, CRDT sync, model gateway, sandbox, broker, MCP server |
| `packages/ui` | React app: Intake, Circuits, Knowledge, Toolbox, Subagents, Content, Sessions, dashboard |
| `packages/sandbox-runtime` | the `ctx` contract tool code sees (TypeScript + Python runners) |
| `config-seed/` | the shipped configuration a fresh Breadboard starts with |
| `deploy/` | Dockerfile, compose, sandbox images, AWS Terraform |
| `docs/` | [architecture](docs/architecture.md), [self-hosting](docs/self-hosting.md), [config reference](docs/config-reference.md), [tool author guide](docs/tool-author-guide.md), [MCP](docs/mcp.md) |

## Development

```bash
npm run typecheck && npm test        # vitest across all packages (PGlite in-memory, mock provider, process sandbox)
npm run dev                          # server with tsx watch
npm run dev:ui                       # Vite dev server proxying /api to :4000
```

## License

[MIT](LICENSE)
