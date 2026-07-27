# 12 — Security & Deployment

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md)
**Related:** [06 — Toolbox](06-toolbox.md) (sandbox, broker usage), [11 — API & MCP](11-api-mcp.md) (auth surface)

---

## 1. Deployment topology

**One deployment = one Breadboard** ([00](00-overview.md) §4.1). The reference topology:

```
┌─────────────────────────── host / small cluster ───────────────────────────┐
│  breadboard-server (Node monolith)                                          │
│    · REST API + UI static serving      · orchestrator                       │
│    · CRDT sync (WebSocket)             · MCP server                         │
│    · connector scheduler               · credential broker (module, §5)     │
│  postgres:16          (the one required stateful dependency)                │
│  docker daemon        (tool sandbox; warm pools)                            │
│  config repo          (bare git repo on server volume)                      │
│  object storage       (filesystem volume by default; S3-compatible option)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Distribution: a single container image + `docker compose up` reference file (server, Postgres, a Docker-in-Docker or socket-mounted sandbox runner). Also runs bare (`node`, local Postgres, local Docker).
- v1 is a **single server process**; the event-sourced orchestrator and single-authority CRDT design are the two things that would shard first, and both have documented seams ([02](02-sessions-orchestrator.md) §9, [07](07-knowledge.md) §6).
- **Backup/DR basics:** Postgres continuous archiving or scheduled `pg_dump`; the config repo is a plain git repo (mirror it to any remote); object storage is rsync/bucket-versioned. Restore = restore all three from a consistent point; the event log makes partially-restored Sessions detectable (they suspend rather than corrupt).

## 2. Threat model (summary)

In scope for v1 protections:
1. **Prompt-injected AI actions** — content/knowledge text steering a Subagent into harmful tool use. Mitigations: narrow per-Subagent grants ([05](05-subagents.md)), config-plane changes always human-gated, sandbox egress default-deny, broker policy checks, wipeout guardrails ([07](07-knowledge.md) §6).
2. **Malicious/buggy tool code** — mitigations: per-execution containers, resource limits, no credentials in-container, capability-scoped broker, human review on all tool-code merges.
3. **Credential exfiltration** — mitigations: broker holds all secrets; tools/models never see raw credentials; broker call audit log.
4. **Runaway spend** — mitigations: per-run budgets + Breadboard spend rate limit ([02](02-sessions-orchestrator.md) §5.1); budget exhaustion suspends, never silently continues.

Out of scope v1 (documented): multi-tenant isolation (single-team deployments), malicious team insiders (all members are trusted; see §4), supply-chain hardening of tool dependencies beyond lockfiles.

## 3. Identity & authentication

- **OIDC-pluggable:** any standard OIDC provider (Okta, Entra, Google, Keycloak, Cognito). The server consumes `sub`/`email`/`name` and maintains its own user records; group→role mapping is configurable.
- **Local-dev mode:** static user list in `breadboard.yaml` (name + token) — no OIDC required to run the stack locally. Clearly banner-marked in the UI.
- **Token kinds** ([11](11-api-mcp.md) §2): user session tokens (OIDC-derived), long-lived **service tokens** (admin-issued, for team pipelines/API callers, scoped to allowed endpoints), and short-lived **internal actor tokens** minted by the orchestrator for sandbox executions (scoped to the calling Subagent's grants, TTL = execution).

## 4. Authorization model

v1 is deliberately coarse — one team, high trust:

- **Roles:** `admin` (instance settings, broker credentials, service tokens, user management) and `member` (everything else). Review-routing `role` slugs ([09](09-content.md) §7) are orthogonal labels, not permissions.
- **Scope enforcement:** node `scope` ([01](01-data-model.md) §3.4) is enforced on every read path (REST, search, RAG, MCP) — `session`-scoped nodes only surface in their session context.
- **Subagent grants are the real permission system for AI:** tools, MCP allowlists, knowledge domains, circuit read/execute — all enforced server-side at the API layer regardless of how the call arrived ([05](05-subagents.md) §2).
- Config-plane merges: any `member` may merge (v1); a per-directory required-reviewers rule (CODEOWNERS-like) is a future hook.

## 5. Credential broker

The broker is a module inside the server process (v1) with a strict internal boundary — its storage and API are designed so it can be split out later:

- **Storage:** credentials encrypted at rest (libsodium sealed boxes) with a master key from env/KMS; never written to the config repo, never returned by any API.
- **Capabilities:** admins register credentials and define **capabilities** — named grants binding a credential + allowed scope (host patterns, methods, path prefixes). Tool manifests declare required capabilities ([06](06-toolbox.md) §2); the manifest diff is where reviewers see them.
- **Execution:** the sandbox `ctx.fetch(capability, request)` calls the broker; the broker validates (tool actually declares the capability ∧ request within scope), attaches the credential, executes the outbound request itself, returns the response. Audit-logged per call (tool, session, capability, target host).
- MCP server auth configs reference broker capabilities the same way ([06](06-toolbox.md) §9).

## 6. Sandbox posture

Per [06 — Toolbox](06-toolbox.md) §4, restated as security requirements: per-execution containers (never reused after running user code); non-root, read-only root filesystem, tmpfs workdir; CPU/memory/pids limits from the manifest; **default-deny egress** via per-container network policy with the manifest allowlist compiled to it; only implicit destinations are the broker and the Breadboard API (with the short-lived actor token); host Docker socket never mounted into tool containers.

## 7. Model gateway

All LLM traffic flows through one gateway module:

```ts
interface ModelProvider {
  invoke(req: ModelRequest): Promise<ModelResponse>       // messages, tools, structured-output schema
  stream(req: ModelRequest): AsyncIterable<ModelChunk>
  capabilities(modelId: string): ModelCapabilities         // tool-use, structured-output, context, embeddings
  cost(modelId: string, usage: TokenUsage): Cost           // powers per-turn cost capture (02 §6)
}
```

- **Reference provider: AWS Bedrock** (Converse API; SigV4 via standard AWS credential chain). Additional adapters (Anthropic API, OpenAI, local/OpenAI-compatible) implement the same interface — presets already support cross-provider fallback lists ([05](05-subagents.md) §4).
- The gateway owns: preset resolution + fallback walking (skipping entries whose `capabilities` don't meet the request's `requires`), retry/backoff on provider throttles, token usage extraction, cost computation, and per-call logging to Session turns.
- Embeddings ([07](07-knowledge.md) §9) route through the same interface.

## 8. Amazon adapter (appendix)

The OSS core stays provider/auth-agnostic; an Amazon-internal deployment is a thin composition of existing seams — no core changes:

| Seam | Internal binding |
|---|---|
| Model gateway | Bedrock (already the reference); internal account/region + any internal gateway endpoint via provider config |
| OIDC | Internal IdP federation; group→role mapping from team directory |
| Knowledge connectors | Internal wiki/doc adapters implementing the connector interface ([07](07-knowledge.md) §8) |
| Broker capabilities | Internal service credentials (e.g., ticketing, code search) registered as capabilities; internal MCP servers onboarded normally ([06](06-toolbox.md) §9) |
| Object storage | S3 with the S3-compatible option |
| Deployment | Internal container hosting; Postgres via RDS |

Internal-only code lives in a separate adapter package, not in the OSS tree.

## 9. v1 cutline

**In:** compose-based single-instance deployment; OIDC + local-dev auth; admin/member + scope + grant enforcement; in-process broker with capability model + audit log; the sandbox posture; the model gateway with Bedrock reference + preset fallback; backup guidance.

**Out (future):** broker as a separate service; per-directory config review requirements; SSO-provisioned user lifecycle (SCIM); secrets rotation automation; network policy beyond the host (service mesh); the Amazon adapter package itself (documented here, built when needed).

## 10. Open questions

1. **Sandbox runtime hardening tier.** Plain Docker vs gVisor/Firecracker. Recommendation: plain Docker with the §6 posture for v1 (self-hosted, single-team trust); document gVisor as the drop-in hardening step.
2. **Broker request signing.** Should sandbox→broker calls be signed beyond the actor token? Recommendation: actor token + per-execution nonce is sufficient at v1's trust level.
