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
docker compose -f deploy/compose.yaml --profile local-postgres up --build
```

Point `DATABASE_URL` at an external Postgres 16+ (RDS recommended) to drop the `local-postgres` profile. Add `--profile sandbox-docker` to run tool sandboxes as sibling containers via the Docker socket (see `deploy/sandbox/README.md` for the egress posture and images).

## 3. Production on AWS

`deploy/aws/` is a Terraform module provisioning RDS + a reference host (see its README). Set these in production:

| Variable | Why |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL=require` (or `verify-full` + `DATABASE_SSL_CA_FILE`) | managed Postgres over TLS |
| `DATABASE_IAM_AUTH=true` | RDS IAM tokens instead of a password |
| `MODEL_PROVIDER=bedrock`, `AWS_REGION` | the reference model provider; credentials via the standard AWS chain |
| `SANDBOX_RUNNER=docker` | isolated per-execution containers; `process` is an unisolated dev fallback |
| `TOKEN_SIGNING_KEY` | HMAC key for user/actor tokens — long and random |
| `BROKER_MASTER_KEY` | 32-byte base64 key encrypting broker credentials at rest |
| `PUBLIC_URL` | reachable from sandbox containers (they call back into the API) |
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
