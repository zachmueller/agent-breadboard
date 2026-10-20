# Verification plan for the unverified surfaces

**Status:** working note, 2026-10-01; run completed the same day (results in the checklist).
**Scope:** the parts of the implementation that could not be exercised during the build because this machine had no Docker, no Postgres server, no AWS session, and no browser run. Everything else is covered by the automated suites (`npx vitest run` at the root: 63 files, 488 tests; `npm test` in `deploy/aws` for the CDK template) and the end-to-end test (`packages/server/test/e2e.test.ts`).

Run every command with Node 26 on the PATH:

```bash
export PATH="$HOME/.local/share/mise/installs/node/26.10.0/bin:$PATH"
cd /path/to/agent-breadboard
```

The sections are ordered so each one's prerequisites come first. Record results in the checklist at the end.

---

## 0. One-time machine setup

```bash
brew install --cask docker        # Docker Desktop; start it once so the daemon and host.docker.internal exist
brew install postgresql@16 awscli
brew services start postgresql@16
(cd deploy/aws && npm ci)         # the CDK CLI for §7 comes with the deploy package
```

Confirm:

```bash
docker info | head -5
psql --version
(cd deploy/aws && npx cdk --version)
aws sts get-caller-identity       # only needed for §5 and §7
```

---

## 1. Docker sandbox runner and images

What is untested: `DockerSandboxRunner` end to end (warm pool, `/tool` volume, limits, internal-only network, egress through the proxy), and the two sandbox images have never been built.

### 1.1 Build the images

```bash
npm run build -w @breadboard/sandbox-runtime
docker build -f deploy/sandbox/Dockerfile.ts -t breadboard-sandbox-ts:local .
docker build -f deploy/sandbox/Dockerfile.py -t breadboard-sandbox-py:local .
docker network create --internal breadboard-sandbox
```

Expected: both builds succeed; `docker run --rm breadboard-sandbox-ts:local node --version` prints Node 26; the Python image runs `python3 -c "import json"`.

Also build a derived Python image with Strands so `spawn-harness` can be exercised later. The base image has no pip, and the build context must be a dedicated directory (macOS `/tmp` holds files the builder cannot read):

```bash
mkdir -p /tmp/bb-strands && cat > /tmp/bb-strands/Dockerfile <<'EOF'
FROM breadboard-sandbox-py:local
USER root
RUN python3 -m ensurepip \
 && python3 -m pip install --no-cache-dir strands-agents \
 && python3 -m pip uninstall -y pip
USER 10001:10001
EOF
docker build -t breadboard-sandbox-py-strands:local /tmp/bb-strands
```

### 1.2 Run the toolbox suite against Docker

The toolbox tests default to the process runner; `SANDBOX_RUNNER=docker` runs the same cases (plus Docker-only isolation cases) against real containers. With the server on a macOS host and Colima, the internal sandbox network cannot reach the host gateway, so start the relay from `deploy/sandbox/README.md` first (one relay per proxy port):

```bash
cd packages/server
SANDBOX_RUNNER=docker SANDBOX_DOCKER_SOCKET=$HOME/.colima/default/docker.sock \
  SANDBOX_EGRESS_PROXY_HOST=bb-egress-relay SANDBOX_EGRESS_PROXY_PORT=4100 \
  npx vitest run src/toolbox/toolbox.test.ts
```

Outcomes the Docker-only cases assert:

- A tool that calls an off-allowlist host gets `403` from the proxy and a row in `egress_audit` with `allowed = false`.
- A tool that ignores the proxy variables and opens a raw socket cannot reach anything (internal network).
- A tool that busy-loops is killed at `limits.timeout_s`.
- A tool that allocates beyond `limits.memory_mb` is OOM-killed and the execution is journaled as `failed`.
- After one execution the container is gone (`docker ps -a --filter label=breadboard.sandbox=1` shows only warm, unused containers).

### 1.3 Run the server with Docker sandboxes

```bash
cd /path/to/agent-breadboard
cp .env.example .env
# edit .env: SANDBOX_RUNNER=docker, SANDBOX_DOCKER_SOCKET=$HOME/.colima/default/docker.sock (Colima),
#            SANDBOX_EGRESS_PROXY_HOST=bb-egress-relay; keep PUBLIC_URL=http://localhost:4000 (the proxy runs on the host)
npm run build && npm start
```

Then from another shell create a task and let it dispatch (the seed triage routes everything through lit-review, whose `quality-check` step runs the `check-citations` TypeScript tool in a container):

```bash
curl -s -X POST -H "Authorization: Bearer dev-admin-token-change-me" -H "content-type: application/json" \
  -d '{"title":"Docker sandbox smoke","body":"run the citation checker in a container","priority":"p2"}' \
  http://localhost:4000/api/v1/tasks
sleep 15
curl -s -H "Authorization: Bearer dev-admin-token-change-me" http://localhost:4000/api/v1/sessions | jq '.items[] | {circuit_slug, state}'
```

Expected: the lit-review session reaches `suspended-gate`. Open `/s/<lit-review session id>` in the UI and confirm the `quality-check` step shows a journaled execution with container logs. The mock model never calls `search-scholarly`, so the Python sandbox is exercised by the §1.2 Python case and, at server level, by §3 (`gather` on Bedrock).

### 1.4 Compose with the Docker sandbox override

```bash
export TOKEN_SIGNING_KEY=$(openssl rand -hex 32) BROKER_MASTER_KEY=$(openssl rand -base64 32) BREADBOARD_BOOTSTRAP_ADMIN_TOKEN=$(openssl rand -hex 24)
docker compose -f deploy/compose.yaml -f deploy/compose.sandbox-docker.yaml --profile local-postgres up --build
```

The image runs as production, which refuses to start without those secrets and refuses the seed's dev tokens, so the smoke below signs in with the bootstrap token.

Expected: the `server` service becomes healthy, joins both the `breadboard` and `breadboard-sandbox` networks, and the same task smoke as §1.3 passes, with tool callbacks reaching the API at `SANDBOX_API_URL=http://server:4000` (an `egress_audit` row for host `server`).

---

## 2. Real Postgres through the `pg` driver

What is untested: `src/db/pg.ts` (pool, TLS options, int8/numeric parsers, multi-statement `exec`), migrations on real Postgres, pgvector on a server, and query behaviour differences between PGlite and Postgres.

### 2.1 Create a database with pgvector

```bash
createdb breadboard_test
psql breadboard_test -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

If `vector` is missing: `brew install pgvector` (Homebrew's pgvector formula targets the matching Postgres), then repeat.

### 2.2 Migrations and the full server suite

`TEST_DATABASE_URL` points every suite at a Postgres server; the harness creates a fresh database per connection and drops it afterwards, so parallel test files never share state. The URL's role needs `CREATEDB` and the right to create the `vector` extension:

```bash
cd packages/server
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npx vitest run
```

Expected: all suites pass. Pay attention to:

- `session_turns.cost_usd` arithmetic (`numeric` comes back as a JS number through the type parser).
- `bigint` columns (`seq`, `tokens_*`) compared as numbers.
- The FTS queries (`websearch_to_tsquery`) and the `knowledge_chunks` cosine ordering.
- Concurrency: the orchestrator and dispatcher tests run real parallel sessions, which PGlite serializes and Postgres does not.

### 2.3 Boot against Postgres and run the e2e

```bash
# .env: DATABASE_URL=postgres://localhost:5432/breadboard_dev  DATABASE_SSL=disable
createdb breadboard_dev && psql breadboard_dev -c 'CREATE EXTENSION vector;'
npm run migrate            # prints applied/skipped counts; run twice to confirm idempotence
npm start
```

Then repeat the task smoke from §1.3. Also open two browser tabs on the same Knowledge Note and type in both; confirm `yjs_updates` rows appear (`psql breadboard_dev -c 'select count(*) from yjs_updates'`).

### 2.4 TLS and IAM paths (optional, needs AWS)

With an RDS instance available: set `DATABASE_SSL=verify-full` plus `DATABASE_SSL_CA_FILE` pointing at the RDS bundle, then `DATABASE_IAM_AUTH=true` with a user granted `rds_iam`. Expected: the boot probe query succeeds and the log shows no password in any connection string. On the reference stack this is the default (deploy/aws README, Database authentication); there, also check that the master password is refused once `breadboard-db-grant-iam` has run.

---

## 3. Bedrock model provider

What is untested: any real call through `BedrockProvider` (Converse request mapping, tool use, forced tool choice, throttling fallback, embeddings).

### 3.1 Credentials and model access

```bash
aws bedrock list-foundation-models --region us-east-1 --query 'modelSummaries[].modelId' | grep -iE 'claude|nova|titan-embed'
```

Make sure the account has access to the model ids in `config-seed/presets/models.yaml`. Edit the presets (through the UI config editor or a direct commit) if the available ids differ.

### 3.2 Run the seed flow on Bedrock

```bash
# .env: MODEL_PROVIDER=bedrock  AWS_REGION=us-east-1   (credentials via the normal AWS chain)
npm start
```

`search-scholarly` reaches Crossref and Semantic Scholar only through broker capabilities; register them (no credential needed) or `gather` degrades to `nothing-found`:

```bash
curl -s -X POST -H "Authorization: Bearer dev-admin-token-change-me" -H "content-type: application/json" \
  -d '{"name":"crossref-api","scope":{"hosts":["api.crossref.org"],"methods":["GET"],"scopes":["read"]}}' \
  http://localhost:4000/api/v1/admin/broker/capabilities
curl -s -X POST -H "Authorization: Bearer dev-admin-token-change-me" -H "content-type: application/json" \
  -d '{"name":"semantic-scholar-api","scope":{"hosts":["api.semanticscholar.org"],"methods":["GET"],"scopes":["read"]}}' \
  http://localhost:4000/api/v1/admin/broker/capabilities
```

Create a task as in §1.3 with a real research question. Expected:

- The triage `classify` step records turns with a real Bedrock `model_id`, non-zero tokens, and a cost computed from `gateway/pricing.ts`.
- The LLM steps end through the `breadboard_finish` tool with schema-valid output (watch for `step-failed` events mentioning validation; if the model fails forced tool choice, the provider's auto-plus-instruction fallback should kick in).
- The `summarize` step produces a real deliverable artifact.
- Dashboard shows spend against the rate limit.

### 3.3 Fallback

Temporarily put a non-existent model id first in the `medium` preset and re-run. Expected: the turn records `fallback_from` and the dashboard lists a gateway fallback warning.

### 3.4 Embeddings and semantic search

Create a Knowledge Note, wait for the debounced embedding refresh, then:

```bash
curl -s -H "Authorization: Bearer dev-admin-token-change-me" \
  "http://localhost:4000/api/v1/knowledge/search?q=<paraphrase of the note>&mode=semantic"
```

Expected: the note ranks first with a Titan-embedding-derived score; `knowledge_chunks.model_id` is `amazon.titan-embed-text-v2:0`.

### 3.5 Evals on Bedrock

From the lit-review circuit's Evals tab, run the smoke fixture. Eval sessions gate like production: the run stays `running` until a `scientist` resolves the `quality-gate` request in the review queue (marked "eval run"). Expected: one `eval-run` session, judge dimensions scored through the pinned `judge.model_id` after the verdict, the verdict on the aggregate row, and a point on the trend chart. Then run again with `model_overrides: {"medium": "us.amazon.nova-pro-v1:0"}` to see the model-regression view populate.

---

## 4. Browser walkthrough of the UI

What is untested: the UI was typechecked, unit tested, and built, but never driven in a browser against the server.

Start `npm run dev` (server) and `npm run dev:ui` (Vite on :5173 proxying `/api`). Log in with `dev-admin-token-change-me`, then walk each area against the acceptance criteria in `specs/13-roadmap.md`:

1. **Shell:** dev-mode banner visible; ⌘K finds both nodes and config definitions; `g` + letter jumps areas; review badge count matches `/api/v1/review-queue/count`.
2. **Intake:** start a conversation, exchange two messages (mock or Bedrock), confirm the Draft Task panel fills in once the shaper calls `create_task`, click **Accept into queue**, see the task in `/tasks` with a queue age.
3. **Sessions:** open the triage session; step path shows attempts, cost, and the sub-circuit link into lit-review; the LLM step drawer shows turn-by-turn tool calls; the code step drawer shows the journaled execution and logs; live-follow updates while a run is in progress.
4. **Content / review queue:** as `member` (`dev-member-token-change-me`, role scientist) the gated summary appears with approve / request-changes; request changes with feedback and confirm the loop back into `summarize` re-interpolates the prompt with the feedback (visible in the turn log); approve on the second pass and confirm the task goes to `done`.
5. **Knowledge:** open the same note in two tabs; presence cursors appear; type in both and confirm neither loses keystrokes; trigger an AI edit through `POST /knowledge/:uid/edits` and confirm the AI blocks highlight and **Revert AI edit** restores the human text while keeping the human's own edits; `[[` autocomplete inserts `[[UID|title]]`; delete nearly everything in one keystroke and confirm the wipeout dialog.
6. **Circuits:** open lit-review, drag an exit to a different step, confirm the YAML tab reflects it and the validation panel flags anything broken; commit; History shows the commit with a flow diff; **Revert to this version** works. In the designer chat ask for a prompt change, confirm the proposal card renders a diff, **Run evals on this branch**, then **Merge**.
7. **Toolbox:** open `check-citations`, widen `egress.allow`, confirm the security lint and the commit dialog highlight it; open an MCP onboarding form and save one.
8. **Subagents:** open `research-scout`, change the preset, add a knowledge domain, confirm inline validation and commit; the designer chat proposes a system-prompt edit and the form diff shows it.
9. **Admin:** create a role and assign `member`; create a service token and use it with `curl`; register a broker credential and capability, then run a tool that calls `ctx.fetch` with it.
10. **Dark mode and keyboard:** toggle the OS theme; tab through a form and a table.

Note anything that renders wrong, any 4xx in the network panel, and any console error.

---

## 5. Credential broker with a real capability

Register a credential and a capability for a public API that needs a key (for example GitHub), bind it to the `repo-search` tool's `github-api` capability, then invoke the tool through a subagent or directly:

```bash
curl -s -X POST -H "Authorization: Bearer dev-admin-token-change-me" -H "content-type: application/json" \
  -d '{"name":"github","kind":"bearer","secret":"<token>"}' http://localhost:4000/api/v1/admin/broker/credentials
curl -s -X POST -H "Authorization: Bearer dev-admin-token-change-me" -H "content-type: application/json" \
  -d '{"name":"github-api","credential":"github","scope":{"hosts":["api.github.com"],"methods":["GET"],"scopes":["read"]}}' \
  http://localhost:4000/api/v1/admin/broker/capabilities
```

Expected: the tool's request succeeds, `broker_audit` records the call with the target host, and the credential never appears in the tool's logs or in any API response.

---

## 6. `spawn-harness` with Strands

Needs §1.1's Strands image and §3's Bedrock access. Set `sandbox.images.python` in `breadboard.yaml` to `breadboard-sandbox-py-strands:local`, create a task that triage routes to `code-task` (title starting "Engineering:", body asking for a code change), and watch the `implement` step. Expected: the Strands event stream appears as the step's code log, declared outputs become artifacts, the step exits `done`, and the harness's model turns appear on the session under `implement` (they go through the gateway via `ctx.converse`; no AWS credentials in the sandbox).

---

## 7. AWS reference deployment (CDK)

What is untested: the CDK app in `deploy/aws/` has only been synthesized against a fake VPC and AMI lookup. Its `npm test` checks the template, including CloudFormation schema validation. It has never been synthesized against a real account or deployed. Everything in this section needs AWS credentials.

### 7.1 Synth and diff against a real VPC

Build and push the three images for `linux/amd64` first (the host is x86_64; see `deploy/aws/README.md`), into an ECR repository you create (`aws ecr create-repository --repository-name agent-breadboard`). In zsh, write `${R}:tag`, not `$R:tag` (the `:s` history modifier mangles it).

```bash
cd deploy/aws
npm ci
npx cdk bootstrap                 # once per account and region
R=<account>.dkr.ecr.<region>.amazonaws.com/agent-breadboard
CTX="-c name=verify -c vpcId=<vpc> -c dbSubnetIds=<a>,<b> -c serverSubnetId=<c> -c serverImage=${R}:server-<tag> -c sandboxImageTs=${R}:sandbox-ts-<tag> -c sandboxImagePy=${R}:sandbox-py-<tag> -c allowedCidrs=none"
npx cdk synth $CTX > /dev/null    # zsh: ${=CTX}
npx cdk diff $CTX
```

`allowedCidrs=none` opens no port; reach the server with `aws ssm start-session --document-name AWS-StartPortForwardingSession --parameters portNumber=4000,localPortNumber=14000 --target <instance>` (needs the Session Manager plugin).

Expected:
- Synth resolves the VPC and AMI lookups into `cdk.context.json` and prints no template validation warnings.
- The subnet IDs resolve. Try one bad run with a subnet outside the VPC, and one with `serverPublicIp` true on a private subnet; both should fail synth with a named error.
- `diff` lists only new resources.

### 7.2 Deploy and smoke

```bash
npx cdk deploy $CTX
```

Through the tunnel, repeat the §1.3 task smoke (register the §3.2 broker capabilities first). Production refuses the seed's `*-change-me` tokens: sign in with the `breadboard-verify/admin-token` secret. The stack sets `MODEL_PROVIDER=bedrock`, and the instance role has Bedrock permissions. Then open a shell on the host (`aws ssm start-session --target <instance id>`) and confirm:

- `/etc/breadboard.env` has a `DATABASE_URL` built from the `breadboard-verify/db` secret and the RDS endpoint.
- `docker logs breadboard` shows the DB connecting with `DATABASE_SSL=require`, and no `BROKER_MASTER_KEY is not exactly 32 bytes` warning.
- `/etc/breadboard/deploy.env` holds the deployed images, `cfn-hup` is active, and the dev token gets 401 while the admin token gets 200.
- Upgrade in place: deploy again with a new `serverImage` tag. Expected: no replacement and no reboot; within a minute or two cfn-hup recreates the `breadboard` container on the new image (`/var/log/cfn-hup.log`).
- The server container reaches the instance role through IMDSv2 (hop limit 2): Bedrock turns record real model ids, and with `OBJECT_STORE=s3` a large artifact lands in the objects bucket.
- A sandboxed tool cannot reach `http://169.254.169.254/` (the sandbox network is internal), so tools never see the instance role.
- With `publicUrl` left empty, `PUBLIC_URL` resolved to the instance's public IP from IMDS.

### 7.3 Change behaviour

- Redeploy with `-c dbInstanceClass=db.t4g.large`. Note whether the change applies during the deploy or waits for the maintenance window. The `deploy/aws/README.md` states the expected behaviour as unconfirmed; correct it either way.
- Run `npx cdk diff $CTX` with no input changes. Expected: no diff, and in particular no instance replacement, because the AMI is pinned.

### 7.4 Destroy

```bash
npx cdk deploy $CTX -c dbDeletionProtection=false
npx cdk destroy $CTX
```

Expected:
- The stack deletes. A final DB snapshot, the four `breadboard-verify/*` secrets, and the objects bucket remain.
- A fresh `cdk deploy` with the same `name` fails on those retained names until they are removed.
- Remove them by hand: `aws secretsmanager delete-secret --force-delete-without-recovery` for each secret; empty all versions from the bucket, then delete it; delete the snapshot when no longer needed.

---

## 8. OIDC login

Spin up a local identity provider:

```bash
docker run --rm -p 8080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:latest start-dev
```

Create a realm, a confidential client with redirect `http://localhost:4000/api/v1/auth/oidc/callback`, a `groups` mapper (`oidc-group-membership-mapper`, claim `groups`, full path off), and two groups. Start the server with `OIDC_CLIENT_SECRET` and `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` set: once `auth.mode` is `oidc`, the bootstrap token is the only token-based way back in. Commit `auth.mode: oidc` with the issuer, client id, `client_secret_env: OIDC_CLIENT_SECRET`, and `group_mappings` (one group → admin, one → the `scientist` role). Expected: **Sign in** redirects to Keycloak and back, the user row is created from `sub`, admin and role memberships follow the groups, and the dev-mode banner disappears.

---

## 9. Backup and restore runbook

With the §2.3 Postgres deployment running and a few sessions completed:

```bash
pg_dump -Fc breadboard_dev > /tmp/bb.dump
git clone --mirror var/config-repo /tmp/config-mirror.git
rsync -a var/objects/ /tmp/objects/
```

Use `pg_dump`/`pg_restore` of the server's major version: an 18 client dumping a 16 server emits `SET transaction_timeout`, which the 16 server rejects on restore (one ignorable error). `var/objects` exists only once a blob has spilled. Stop the server, drop and recreate the database, restore all three, start the server. Expected: sessions that were `running` at the snapshot are re-queued from their last checkpoint; everything else is intact; the config tree resolves at the same `main` commit.

---

## Checklist

Run of 2026-10-01 (macOS, Colima, Postgres 16 + pgvector in Docker, Bedrock us-east-1, a dedicated test account). "Fixed" commits are on `cdk-aws-deploy`.

| # | Area | Result | Notes |
|---|---|---|---|
| 1.1 | Sandbox images build | Pass | Strands recipe needed `ensurepip` (base image has no pip); fixed above. |
| 1.2 | Toolbox suite on Docker runner | Pass | 19/19 incl. raw-socket, OOM, removal, stale-image cases. Colima needs the egress relay (host gateway unreachable from `--internal`). Fixed: `.env` comment parsing (`SANDBOX_OCI_RUNTIME`), warm pool reusing a superseded image. |
| 1.3 | Server with Docker sandboxes (TS + Python tool) | Pass | TS `check-citations` in a container; Python `search-scholarly` via §3 (the mock never calls it). |
| 1.4 | Compose `sandbox-docker` profile | Pass after fixes | Profile started two servers on :4000 → override file. Fixed: image crashed (nested `ajv`), missing `.dockerignore`, healthcheck `localhost`→`::1`, `PUBLIC_URL` overwritten → `SANDBOX_API_URL`. |
| 2.2 | Full suite on Postgres | Pass | 38 files / 298 tests. Fixed: pgvector never detected on Postgres; `real[]`→`vector` upgrade for existing installs. |
| 2.3 | Boot + e2e on Postgres, CRDT persistence | Pass | Migrations idempotent; `yjs_updates` 0→268→493 rows during the two-tab edit (§4). |
| 2.4 | TLS / IAM (optional) | Pass after fix | `verify-full` with the RDS bundle: TLSv1.3, fails without the CA, no password in logs. IAM auth (2026-10-20, the instance behind a load balancer): found broken in review before any run (pg dropped the token function when also given a `connectionString`; fixed with `poolConfig`). Before the grant, the token was refused as a password (28P01, with the hint); after `GRANT rds_iam`, the server booted on tokens and the master password was refused (`PAM authentication failed`). |
| 3.2 | Seed flow on Bedrock | Pass after fixes | Fixed: seed model ids did not exist (now `us.*` inference profiles). Needs the Crossref / Semantic Scholar capabilities. `summarize` on Opus 5 costs ~$1–1.5 per run. |
| 3.3 | Preset fallback | Pass | Turn records `fallback_from`; dashboard lists the event. |
| 3.4 | Embeddings + semantic search | Pass after fix | Fixed: notes created via REST/connectors were never embedded. Titan v2, 1024 dims, `vector` column. |
| 3.5 | Evals on Bedrock | Pass after fixes | Fixed: eval sessions now wait for the human gate (decided 2026-10-01) and resume after restart; assertion tools got the wrong input shape; Nova failed all tool use (hyphenated tool names). |
| 4 | Browser walkthrough (10 items) | Pass with fixes | Headless Playwright on an isolated instance. Fixed: designer could not read its circuit, Logs tab never populated, AI-edit revert lost human edits, Accept-into-queue unusable, parent stuck "awaiting review", 11 UI bugs. Open: step drawer merges visits as attempts; ActorLabel shows subagent UIDs; running steps show $0.00; YAML editor squeezed with two side panels; AI-block highlight only for subagent authors. |
| 5 | Broker with a real capability | Pass | `github-api` via `gh auth token`: 10 audited calls; token absent from API responses, logs, DB dump, objects. |
| 6 | spawn-harness with Strands | Pass after change | Harness had no AWS credentials; model turns now go through the gateway (`model_converse`, decided 2026-10-01) and land on the session. Fixed: root-level capture glob. |
| 7.1 | CDK synth / diff against a real VPC | Pass | Clean synth after acknowledging the pinned-AMI lint; both bad-subnet cases fail with named errors; diff only new resources. |
| 7.2 | CDK deploy + smoke (IMDS, secrets, sandbox isolation) | Pass after fixes | First deploys failed or served nothing. Fixed: DB secret rejected by Secrets Manager, retained secrets blocking retries, no ECR login/pull grant, no sandbox images on the host, server not on the sandbox network / non-root, malformed image accepted, well-known admin token live in production (bootstrap token now), no upgrade path (cfn-hup, verified in place). IMDS reachable from the server, not from tools; S3 spill works. |
| 7.3 | RDS modification timing, no-op diff | Pass | Class change applied during the deploy (6.5 min, two short restarts). No-op diff empty. |
| 7.4 | CDK destroy retains snapshot, secrets, bucket | Pass | Destroy kept the final snapshot, four secrets, and the bucket; a same-name redeploy failed at change-set validation (bucket exists) before creating anything. All removed by hand afterwards, plus the ECR repo. |
| 8 | OIDC login | Pass | Keycloak: users from `sub`, admin and `scientist` from groups, no dev banner. |
| 9 | Backup and restore | Pass | Interrupted `running` sessions re-run from their last checkpoint; `main` unchanged. 18-client/16-server `pg_restore` warning noted above. |

Fixes found during this pass should go in as normal commits with a test where the suites can cover them (the `TEST_DATABASE_URL` switch from §2.2 is the first such change).
