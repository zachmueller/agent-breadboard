# Self-hosting guide

One deployment = one Breadboard: a single server process, one Postgres, one config git repo, one team. This guide gets a Breadboard running in under an hour on a fresh machine.

## 1. Quickstart (no Docker, embedded Postgres)

Requirements: Node 26+, git, python3 (for Python tool extensions in the local-process sandbox).

```bash
git clone <this repo> && cd agent-breadboard
npm ci
npm run build
cp .env.example .env            # defaults: DATABASE_URL=pglite://./var/db, MODEL_PROVIDER=mock, SANDBOX_RUNNER=process
npm start                       # http://localhost:4000
```

On first boot the server runs migrations, creates the config repo at `CONFIG_REPO_DIR` from `config-seed/`, creates the local-dev users from `breadboard.yaml`, and serves the UI. Log in with the dev token `dev-admin-token-change-me` (the banner reminds you this is local-dev auth).

`pglite://` runs Postgres in-process (WASM) with pgvector — fine for trying things out and for tests, not for a team deployment.

## 2. Docker Compose (bundled Postgres)

```bash
export TOKEN_SIGNING_KEY=$(openssl rand -hex 32) BROKER_MASTER_KEY=$(openssl rand -base64 32)
export BREADBOARD_BOOTSTRAP_ADMIN_TOKEN=$(openssl rand -hex 24)   # your first login: the seed's dev tokens are refused
docker compose -f deploy/compose.yaml --profile local-postgres up --build
```

The image runs with `NODE_ENV=production`, which refuses to start unless `TOKEN_SIGNING_KEY` and `BROKER_MASTER_KEY` hold real values (see the table in §3). Point `DATABASE_URL` at an external Postgres 16+ (RDS recommended) to drop the `local-postgres` profile. Add `-f deploy/compose.sandbox-docker.yaml` to run tool sandboxes as sibling containers via the Docker socket; build the sandbox images first (see `deploy/sandbox/README.md` for the egress posture and images).

## 3. Production on AWS

`deploy/aws/` is a TypeScript CDK app provisioning RDS + a reference host (see its README). Set these in production:

| Variable | Why |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL=require` (or `verify-full` + `DATABASE_SSL_CA_FILE`) | managed Postgres over TLS |
| `DATABASE_IAM_AUTH=true` | RDS IAM tokens instead of a password |
| `MODEL_PROVIDER=bedrock`, `AWS_REGION` | the reference model provider; credentials via the standard AWS chain |
| `SANDBOX_RUNNER=docker` | isolated per-execution containers; `process` is an unisolated dev fallback |
| `TOKEN_SIGNING_KEY` | HMAC key for user/actor tokens: at least 32 random characters (`openssl rand -hex 32`). Production refuses to start with the default `dev-only-change-me`, which anyone can read from this repo and use to forge admin sessions. |
| `BROKER_MASTER_KEY` | 32-byte base64 key encrypting broker credentials at rest (`openssl rand -base64 32`). Production refuses to start without it; development falls back to a key derived from `TOKEN_SIGNING_KEY`. |
| `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` | break-glass admin sign-in (`bootstrap-admin`). Production (`NODE_ENV=production`, as in the image) refuses the seed's `*-change-me` tokens, so this is how you first sign in to configure OIDC. Deactivate `bootstrap-admin` in Admin to revoke it. |
| `PUBLIC_URL` | the browser-facing base URL (OIDC redirect, links) |
| `SANDBOX_EGRESS_PROXY_HOST`, `SANDBOX_API_URL` | how sandbox containers reach the egress proxy and the API; set both to the server's name on `breadboard-sandbox` when the server runs in a container (`SANDBOX_API_URL` defaults to `PUBLIC_URL`) |
| `OBJECT_STORE=s3`, `OBJECT_STORE_S3_BUCKET` | large blobs off the host disk |

Then switch auth to OIDC in `breadboard.yaml` (`auth.mode: oidc`, issuer, client id, secret env var, group mappings) through the Subagents/Config editor or a direct commit.

## 4. Operations

- **Health:** `GET /api/v1/health`; admins get `GET /api/v1/admin/health/detail` (sandbox, gateway fallbacks, dispatcher capacity, connectors) and the dashboard.
- **Capacity:** `breadboard.yaml` → `capacity.max_concurrent_runs`, `capacity.max_spend_usd_per_hour`; per-circuit `budget` blocks.
- **Config repo:** a plain bare git repo at `CONFIG_REPO_DIR`. Admins may clone/mirror it; every change the server makes is a commit on `main` or a `proposals/*` branch.
- **Logs:** pino JSON (`LOG_PRETTY=false`) to stdout.

## 5. Backup & restore runbook

Three things hold state: Postgres, the config repo, object storage.

Backup:
1. Postgres: RDS automated snapshots + PITR, or `pg_dump -Fc` on a schedule for self-managed.
2. Config repo: `git clone --mirror /var/breadboard/config-repo` to a remote, or push on a cron.
3. Objects: S3 versioning, or `rsync` of `OBJECT_STORE_DIR`.

Restore (to a consistent point):
1. Stop the server.
2. Restore Postgres to the chosen time; restore the config repo mirror; restore objects.
3. Start the server. Sessions that were `running` are re-queued from their last checkpoint; a session whose config commit is missing from the restored repo suspends as `suspended-error` rather than corrupting (the event log makes partial restores detectable). Review them in Sessions → suspended.

Validate the runbook on a staging instance after any schema migration.

## 6. Connecting external harnesses (MCP)

See `docs/mcp.md`: the Breadboard MCP server lives at `/api/v1/mcp` (Streamable HTTP) and authenticates with a user or service token.
