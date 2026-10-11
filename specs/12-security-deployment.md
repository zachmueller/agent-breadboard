# 12 — Security & Deployment

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md)
**Related:** [06 — Toolbox](06-toolbox.md) (sandbox, broker usage), [11 — API & MCP](11-api-mcp.md) (auth surface)

---

## 1. Deployment topology

**One deployment = one Breadboard** ([00](00-overview.md) §4.1). The reference topology:

```
┌─────────────────────────────────── host ───────────────────────────────────┐
│  breadboard-server container (Node monolith)                               │
│    · REST API + UI static serving      · orchestrator                      │
│    · CRDT sync (WebSocket)             · MCP server                        │
│    · connector scheduler               · credential broker (module, §5)    │
│    · egress proxy (§6)                                                     │
│    networks: default (browser-facing) + breadboard-sandbox                 │
│  tool containers  (siblings via the host Docker socket; warm pools; only   │
│                    on internal-only breadboard-sandbox → reach the server) │
│  postgres 16+     (local container for dev/quickstart, or external         │
│                    managed instance — AWS RDS recommended for prod)        │
│  config repo      (bare git repo on a host volume)                         │
│  object storage   (filesystem volume by default; S3-compatible option)     │
└────────────────────────────────────────────────────────────────────────────┘
```

- Distribution: a single container image + `docker compose up` reference file (server, a local-Postgres profile, and an override that runs tool sandboxes as sibling containers through the mounted Docker socket). Also runs bare (`node`, local Postgres, local Docker).
- **Sandbox networking.** Tool containers attach only to the internal-only `breadboard-sandbox` network (§6). The server container joins that network as well as its default one, and tools reach both the egress proxy and the API (for ctx primitives) at the server's name on it: `SANDBOX_EGRESS_PROXY_HOST` and `SANDBOX_API_URL`, the latter defaulting to `PUBLIC_URL`. Keeping the two URLs separate lets `PUBLIC_URL` stay browser-facing. This is the reference topology for both compose and the AWS host. A server running directly on the host must instead make the proxy reachable from the internal network, which not every Docker runtime allows: on Colima (macOS) the host gateway is unreachable from an internal network, so a relay container that forwards only the proxy port sits on both networks (`deploy/sandbox/README.md`).
- **Postgres placement is a deployment choice, not an architectural one.** The server reaches Postgres only through connection config (`DATABASE_URL` + TLS and IAM-auth options), so the bundled compose profile (dev/quickstart) and an external managed instance are interchangeable. **AWS RDS is the recommended production default**, and the repo ships an IaC module (`deploy/aws/`, a TypeScript CDK app) that provisions RDS plus the reference server host as the AWS reference deployment. Other managed-Postgres providers work identically through the same connection seam.
- **AWS reference deployment (`deploy/aws/`).** RDS Postgres (private, encrypted, forced TLS, IAM auth enabled, automated snapshots + PITR) and one EC2 host (IMDSv2 only) running the server container and the tool sandboxes in the topology above.
  - *Credentials:* an instance role grants Bedrock, S3, and RDS IAM access. An IMDS hop limit of 2 lets the server container reach it; tool containers have no route off the sandbox network, so they cannot.
  - *Secrets:* Secrets Manager generates the DB credentials, the token-signing key, the broker master key, and the bootstrap admin token (§3), so no secret appears in the template, the CDK output, or on the deployer's machine.
  - *Access:* inbound traffic to the server port comes from allowlisted CIDRs, or from none, in which case operators reach the server through SSM port forwarding.
  - *Upgrades happen in place.* Image references live in the host's CloudFormation::Init metadata, not its user data (which is one-time host setup). When a deploy changes them, cfn-hup on the host pulls the new images and recreates the server container. The host is neither restarted nor replaced, so the config repo on its root volume is untouched.
  - *Destroy keeps the state:* a final DB snapshot, the secrets, and the objects bucket are retained.
- v1 is a **single server process**; the event-sourced orchestrator and single-authority CRDT design are the two things that would shard first, and both have documented seams ([02](02-sessions-orchestrator.md) §9, [07](07-knowledge.md) §6).
- **Backup/DR basics:** Postgres continuous archiving or scheduled `pg_dump` for self-managed instances (use the server's major version of `pg_dump`/`pg_restore`: a newer client's dump can carry settings an older server rejects on restore); on RDS, automated snapshots + point-in-time recovery replace self-managed archiving. The config repo is a plain git repo (mirror it to any remote); object storage is rsync/bucket-versioned. Restore = restore all three from a consistent point. Sessions that were `running` re-run from their last checkpoint, and the event log makes partially-restored Sessions detectable (they suspend rather than corrupt).

## 2. Threat model (summary)

In scope for v1 protections:
1. **Prompt-injected AI actions** — content/knowledge text steering a Subagent into harmful tool use. Mitigations: narrow per-Subagent grants ([05](05-subagents.md)), config-plane changes always human-gated, sandbox egress default-deny, broker policy checks, wipeout guardrails ([07](07-knowledge.md) §6).
2. **Malicious/buggy tool code** — mitigations: per-execution containers, resource limits, no credentials in-container, capability-scoped broker, human review on all tool-code merges.
3. **Credential exfiltration** — mitigations: broker holds all secrets; tools/models never see raw credentials; broker call audit log.
4. **Runaway spend** — mitigations: per-run budgets + Breadboard spend rate limit ([02](02-sessions-orchestrator.md) §5.1); budget exhaustion suspends, never silently continues.

Out of scope v1 (documented): multi-tenant isolation (single-team deployments), malicious team insiders (all members are trusted; see §4), supply-chain hardening of tool dependencies beyond lockfiles.

## 3. Identity & authentication

- **OIDC-pluggable:** any standard OIDC provider (Okta, Entra, Google, Keycloak, Cognito). The server consumes `sub`/`email`/`name` and maintains its own user records (`users` table, [01](01-data-model.md) §8). Group mapping is configurable at two levels: OIDC groups → the `admin`/`member` permission role, and OIDC groups → review-role memberships (`role_memberships` table) applied at login. Review roles themselves live in the DB, managed via API/UI — not in the config repo.
- **Local-dev mode:** static user list in `breadboard.yaml` (name + token) — no OIDC required to run the stack locally. Static users are **real `users` rows** (created at startup), so the identity schema is exercised identically in dev and prod; OIDC is a login-method swap. Clearly banner-marked in the UI.
- **Production refuses well-known tokens.** With `NODE_ENV=production` (as in the shipped image), a static user whose token is one of the seed's well-known `*-change-me` values never authenticates, and the refusal is logged at startup. Operator-set tokens still work, so static-user auth stays usable in production once its tokens are real.
- **Production refuses to start without real secrets.** With `NODE_ENV=production`, the server exits at startup if `TOKEN_SIGNING_KEY` is unset, still one of the repo's well-known `*-change-me` values, or shorter than 32 characters; if `BROKER_MASTER_KEY` is unset (§5); or if the bootstrap admin token is a well-known value. The default signing key is public, so it would let anyone forge admin sessions, and without a broker key, credentials would be encrypted with a key derived from the signing key. The AWS reference deployment generates all three secrets (§1); compose and other hosts must supply them.
- **Bootstrap admin.** `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` signs in as the admin user `bootstrap-admin` in any auth mode. It is the break-glass path into a fresh deployment, whose seed tokens are refused and whose config repo cannot be edited before first boot: the operator signs in with it, then configures OIDC or real static tokens. The user is created on first use; deactivating it in Admin (from another admin account) revokes the token for good (it is never re-enabled). Leaving the token unset or empty disables it instead, reversibly, and also ends the sessions it started. Startup logs an error when no admin could then sign in: no admin static user with an accepted token, and no OIDC admin. An authenticating proxy in front of the server does not replace it. Such a proxy decides who may reach Breadboard but does not tell Breadboard who the user is, so some in-app admin sign-in must remain. The AWS reference deployment generates the token in Secrets Manager (§1) and turns it off in place with `bootstrapAdmin=false`. The secret is kept, so turning it back on is the break-glass path.
- **Trusted proxy.** Some authenticating proxies (a CDN with a signed-cookie gate, an access proxy) decide who may reach Breadboard but send no identity. For a proxy whose audience is a single person, `BREADBOARD_TRUSTED_PROXY_SECRET` and `BREADBOARD_TRUSTED_PROXY_USER` remove the second sign-in. A request carrying the secret in `BREADBOARD_TRUSTED_PROXY_HEADER` (default `x-breadboard-proxy-auth`) signs in as that user, who is created as an admin on first use (`token_kind: proxy`). Only the proxy may know the secret: it must be at least 32 random characters, and startup refuses a half or weak configuration in every environment. An explicit credential still wins, and a stale one falls back to the proxy user. Requests that bypass the proxy get no trust, which covers the host's own tunnel and tool sandboxes, whose environment never holds the secret. Deactivating the user turns the path off. The server cannot tell the proxy's users apart, so widening the proxy's audience gives everyone that one identity; use OIDC for a team. The AWS reference deployment generates the secret with `trustedProxyUser` (§1).
- **Token kinds** ([11](11-api-mcp.md) §2): user session tokens (OIDC-derived), long-lived **service tokens** (admin-issued, for team pipelines/API callers, carrying **named capability scopes** — [11](11-api-mcp.md) §2), and short-lived **internal actor tokens** minted by the orchestrator for sandbox executions (scoped to the calling Subagent's grants, TTL = execution).

## 4. Authorization model

v1 is deliberately coarse — one team, high trust:

- **Roles:** `admin` (instance settings, broker credentials, service tokens, user management) and `member` (everything else). Review-routing `role` slugs ([09](09-content.md) §7, DB-backed) are orthogonal labels, not permissions — they route review work and gate verdicts, never grant or deny data access.
- **Scope enforcement:** node `scope` ([01](01-data-model.md) §3.4) is enforced on every read path — REST, search, RAG, MCP, **the SSE event stream (per-subscriber filtering, [11](11-api-mcp.md) §5), and the CRDT `WS /sync` channel (doc-open requires the same read grant as `GET /nodes/:uid`)**. `session`-scoped nodes only surface in their session context.
- **Subagent grants are the real permission system for AI:** tools, MCP allowlists, knowledge domains, circuit read/execute — all enforced server-side at the API layer regardless of how the call arrived ([05](05-subagents.md) §2).
- Config-plane merges: any `member` may merge (v1); a per-directory required-reviewers rule (CODEOWNERS-like) is a future hook.

## 5. Credential broker

The broker is a module inside the server process (v1) with a strict internal boundary — its storage and API are designed so it can be split out later:

- **Storage:** credentials encrypted at rest (libsodium sealed boxes) with a master key from env/KMS; never written to the config repo, never returned by any API.
- **Capabilities:** admins register credentials and define **capabilities** — named grants binding a credential + allowed scope (host patterns, methods, path prefixes). Tool manifests declare required capabilities ([06](06-toolbox.md) §2); the manifest diff is where reviewers see them.
- **Execution:** the sandbox `ctx.fetch(capability, request)` calls the broker; the broker validates (tool actually declares the capability ∧ request within scope), attaches the credential, executes the outbound request itself, returns the response. Audit-logged per call (tool, session, capability, target host).
- MCP server auth configs reference broker capabilities the same way ([06](06-toolbox.md) §9).

## 6. Sandbox posture

Per [06 — Toolbox](06-toolbox.md) §4, restated as security requirements: per-execution containers (never reused after running user code); non-root, read-only root filesystem, tmpfs workdir; CPU/memory/pids limits from the manifest; **default-deny egress via an egress proxy** — tool containers attach to an internal-only Docker network with no external route; the only way out is an HTTP(S) forward proxy that enforces the per-execution allowlist (compiled from the tool manifest's `egress.allow`) and logs every call. Non-HTTP protocols are blocked by construction. Only implicit destinations are the broker and the Breadboard API (with the short-lived actor token, reached through the proxy at `SANDBOX_API_URL` — §1); host Docker socket never mounted into tool containers.

Runtime tier: **plain Docker in v1** with the posture above (self-hosted, single-team trust); gVisor (`runsc`) is documented as the drop-in hardening step for lower risk appetites — the runner takes a configurable OCI runtime, so no architectural change is needed.

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

- **Reference provider: AWS Bedrock** (Converse API; SigV4 via standard AWS credential chain). **v1 ships Bedrock only**; additional adapters (Anthropic API, OpenAI, local/OpenAI-compatible) are post-v1 and implement the same interface — the preset schema's `provider` field already admits cross-provider fallback lists, though v1 lists are Bedrock-internal by construction ([05](05-subagents.md) §4), and the `ModelProvider` seam is the documented extension point.
- The gateway owns: preset resolution + fallback walking (skipping entries whose `capabilities` don't meet the request's `requires`), retry/backoff on provider throttles, token usage extraction, cost computation, and per-call logging to Session turns.
- **Structured output:** LLM steps end via a **forced finish-tool** compiled from the step's output schema + exit enum ([03](03-circuits.md) §10) — portable across all providers/models. The gateway may substitute a provider-native structured-output mode when `capabilities(modelId)` reports support; the step contract is identical either way.
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
| Deployment | The AWS reference deployment (`deploy/aws/`, §1) in an internal AWS account, or internal container hosting running the same image in the §1 topology; Postgres via RDS (the standard managed-Postgres path, §1 — nothing adapter-specific) |

Internal-only code lives in a separate adapter package, not in the OSS tree.

## 9. v1 cutline

**In:** compose-based single-instance deployment; the AWS IaC module (`deploy/aws/`: RDS + reference host); OIDC + local-dev auth; admin/member + scope + grant enforcement; in-process broker with capability model + audit log; the sandbox posture; the model gateway with Bedrock reference + preset fallback; backup guidance.

**Out (future):** broker as a separate service; per-directory config review requirements; SSO-provisioned user lifecycle (SCIM); secrets rotation automation; network policy beyond the host (service mesh); the Amazon adapter package itself (documented here, built when needed).

## 10. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Sandbox runtime hardening tier.** **Decided:** plain Docker with the §6 posture (egress proxy) for v1; gVisor documented as the drop-in hardening step (§6).
2. **Broker request signing.** **Decided:** actor token + per-execution nonce is sufficient at v1's trust level.
3. **Postgres hosting.** **Decided:** connection-config seam (`DATABASE_URL` + TLS/IAM options) with **RDS as the recommended production default**, provisioned by a shipped IaC module (`deploy/aws/`); the compose local-Postgres profile remains the dev/quickstart path (§1). Rejected: making RDS the quickstart default (first-run would require an AWS account).

*(Decided 2026-10-01, during the first live deployment.)*

4. **Image upgrades on the AWS reference host.** **Decided:** in place: image references live in CloudFormation::Init metadata and cfn-hup applies changes (§1). User data runs once per instance, so with the images there, a deploy changed the template while the host kept running the old container.
5. **First sign-in to a production deployment.** **Decided:** production refuses the seed's well-known tokens, and a generated bootstrap admin token is the break-glass sign-in (§3). Before this, the shipped image accepted the seed's `dev-admin-token-change-me` as an admin, and operators could not replace it before first boot.

*(Decided 2026-10-10.)*

6. **Secrets in production.** **Decided:** production refuses to start without a real `TOKEN_SIGNING_KEY` and `BROKER_MASTER_KEY` (§3), the same way it refuses the seed's user tokens. Before this, a deployment outside the AWS stack that forgot either key signed sessions with the repo's default key and only logged a warning about the broker.
