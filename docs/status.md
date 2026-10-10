# Implementation status

**As of:** 2026-10-10.
**Branch:** `main`; the `cdk-aws-deploy` work was merged on 2026-10-10. The verification pass and its follow-ups start at `467a8b1` (`git log 467a8b1..HEAD`).
**Read first when resuming:** this file, then the checklist at the end of [verification-plan.md](verification-plan.md).

## Summary

Every roadmap phase (0–7) is implemented. The automated suites pass. On 2026-10-01 the surfaces that had never run (Docker sandboxes, real Postgres, Bedrock, the browser UI, the broker, Strands, the AWS deployment, OIDC, backup/restore) were exercised for real, which found and fixed roughly 40 bugs. The Phase 6 acceptance path, which gates the internal pilot ([13](../specs/13-roadmap.md) §4), ran end to end on Bedrock. On 2026-10-10 the branch was pushed, the specs were brought in line with the decisions made during the pass (04, 06, 12, 13), and production hardening landed: the server refuses to start without real secrets. The remaining work is a small set of verification gaps, minor UI issues, and the Phase 7 acceptance items that were not exercised.

## Roadmap phases

| Phase | Built | Acceptance evidence | Not yet demonstrated |
|---|---|---|---|
| 0 Skeleton | Yes | CI workflow (typecheck, lint, test, build): its first GitHub Actions run (2026-10-10, the branch's first push) failed because nothing built the library packages before typecheck; the root scripts now do. Compose against bundled Postgres; boot against an external `DATABASE_URL` and RDS | |
| 1 Data model & config plane | Yes | Unit suites; config propose/merge/revert driven from the UI | |
| 2 Orchestrator & Sessions | Yes | e2e test; restart mid-run re-runs from the checkpoint (§9); gates, budgets, fallback on Bedrock | |
| 3 Subagents & Toolbox | Yes | `gather` subagent calls the Python `search-scholarly` in Docker through broker capabilities; TS code step in Docker; egress 403 + raw-socket isolation tests | |
| 4 Circuits & Evals | Yes | Flow editor and designer-chat proposal → merge; eval runs, trend and model-regression views on Bedrock | Fixture promotion only unit-tested; a tool edit through its designer chat |
| 5 Knowledge | Yes | Two-tab concurrent editing, `yjs_updates` persistence, AI-edit revert, wipeout dialog, pgvector semantic search | AI-block highlight shown only for subagent/code-step authors (not checked for other authors) |
| 6 Intake & Content review | Yes | Conversation → draft Task → Accept → triage → lit-review → gate → request changes → approve → done, in the browser | |
| 7 Connectors & hardening | Yes | OIDC (Keycloak), AWS reference deployment (deploy, in-place upgrade, destroy), backup/restore runbook | Live git-repo connector sync (unit-tested only); load/burn-in; "fresh-machine self-host from docs in under an hour"; webhooks live |

## Testing status

| Suite | Command | Last result |
|---|---|---|
| Root (all packages, PGlite, mock model, process sandbox) | `npx vitest run` | 68 files, 516 passed, 4 skipped (the skips are Docker-only); 2026-10-10 |
| Server on real Postgres | `cd packages/server && TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npx vitest run` | 38 files, 298 passed (at `a2e9538`, 2026-10-01; not re-run since) |
| Toolbox on the Docker runner | see [verification-plan.md](verification-plan.md) §1.2 (Colima needs the egress relay) | 19 of 19 |
| CDK template | `cd deploy/aws && npm test` | 23 passed |
| Typecheck / lint | `npm run typecheck`, `npm run lint` | clean; 4 pre-existing lint warnings (2026-10-10) |

The live results for every plan section, with notes, are in the [verification-plan.md](verification-plan.md) checklist.

## Decisions made 2026-10-01

Each one is implemented and was verified live.

1. **Eval runs wait for the human reviewer at hard gates.** Eval sessions gate like production. The verdict is recorded on the fixture's aggregate row. Runs still `running` resume after a restart. Recorded in spec [04](../specs/04-evals.md) §4.
2. **Sandboxed harness model calls go through the model gateway.** Tool code uses `model_converse` / `ctx.converse`, which requires the reserved `model` capability. Spawn-harness's Strands adapter uses it, so its spend lands on the Session and the sandbox holds no AWS credentials.
3. **Image upgrades on the AWS reference host happen in place via cfn-hup.** Images live in CloudFormation::Init metadata; user data is one-time host setup.
4. **Production refuses the seed's `*-change-me` tokens.** `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` (generated as `breadboard-<name>/admin-token` by the stack) signs in as `bootstrap-admin` in any auth mode.

Earlier choices for this pass: Colima as the Docker runtime; SSM-only access to the AWS host (`allowedCidrs=none`); seed presets fixed to real `us.*` inference-profile ids; the UI walkthrough driven by headless Playwright.

## Decisions made 2026-10-10

1. **Production refuses to start without real secrets.** With `NODE_ENV=production`, `buildServices` exits before touching the database unless `TOKEN_SIGNING_KEY` (≥32 chars, not `*-change-me`) and `BROKER_MASTER_KEY` are set, and the bootstrap token is not a well-known value. The AWS stack already generated all three; compose now needs them exported. Recorded in spec [12](../specs/12-security-deployment.md) §3 and §10.

## Next steps (in priority order)

1. **Close the verification gaps:**
   - RDS IAM auth (§2.4). Granting a test DB user `rds-db:connect` was not permitted in the session; TLS `verify-full` passed.
   - A real-browser pass over the 11 UI fixes (each was unit-tested only).
   - The egress-relay question for Docker Desktop and for a Linux host running the server outside a container ([deploy/sandbox/README.md](../deploy/sandbox/README.md)).
2. **Fix the remaining walkthrough issues:**
   - The step drawer merges repeated visits and labels them attempts (`SessionExplorer.tsx`; the server also increments `attempt` across visits).
   - ActorLabel shows subagent UIDs instead of slugs.
   - Running LLM steps show $0.00 until they exit.
   - The YAML editor is ~200px wide when History and Designer are both open.
   - AI-edit highlighting covers only subagent/code-step authors.
3. **Remaining Phase 7 acceptance work:**
   - a live git-repo connector sync;
   - orchestrator load/burn-in;
   - timing a fresh-machine self-host from the docs;
   - a webhook delivery check.
4. **Doc and spec gaps:**
   - [self-hosting.md](self-hosting.md)'s backup runbook should say to use the server's major version of `pg_dump` (an 18 client against a 16 server emits `SET transaction_timeout`, which fails on restore).
   - Email intake is missing from the deferred register.
   - Spec 07 claims circuit- and step-level knowledge grants that the circuit schema in spec 03 does not have.
5. **Cost tuning before the pilot.** lit-review's `summarize` on the `large` preset (Opus 5) costs about $1–1.5 per run. The eval model-regression and cheapest-model views can guide a preset change.

## Resuming locally

Everything was stopped at the end of the session. To bring it back:

```bash
export PATH="$HOME/.local/share/mise/installs/node/26.10.0/bin:/opt/homebrew/opt/libpq/bin:$PATH"
cd /path/to/agent-breadboard
colima start                              # Docker (socket: ~/.colima/default/docker.sock)
docker start bb-pg bb-egress-relay        # Postgres 16 + pgvector on :5432 (user postgres, trust); proxy relay for :4100
npm run build
AWS_PROFILE=<your-profile> npm start            # .env: Postgres breadboard_dev, Bedrock, Docker sandboxes via the relay
```

- `.env` (gitignored) is set up for `DATABASE_URL=postgres://postgres@localhost:5432/breadboard_dev`, `MODEL_PROVIDER=bedrock`, `SANDBOX_RUNNER=docker`, `SANDBOX_DOCKER_SOCKET=$HOME/.colima/default/docker.sock`, and `SANDBOX_EGRESS_PROXY_HOST=bb-egress-relay`. Set `MODEL_PROVIDER=mock` to avoid Bedrock spend.
- The server reads `.env` into its own config only, so export `AWS_PROFILE` for Bedrock.
- Dev tokens: `dev-admin-token-change-me`, `dev-member-token-change-me`. They work because the local run is not `NODE_ENV=production`.
- The seeded `search-scholarly` needs broker capabilities `crossref-api` and `semantic-scholar-api` (keyless); they are already registered in `breadboard_dev`.
- zsh pitfalls: write `${R}:tag`, not `$R:tag`; unquoted `$VAR` does not word-split (`${=VAR}`); `GID`/`UID` are special variables.

## State left behind

- **Local databases in `bb-pg`:**
  - `breadboard_dev`: restored in §9; the GitHub broker credential was deleted.
  - `breadboard_ui`: the walkthrough instance; its config is switched to OIDC against a Keycloak that no longer runs.
  - Drop either freely.
- **Local files:** `var/` (config repo for `breadboard_dev`) and `/tmp/bb-ui/` (config repo for `breadboard_ui`).
- **Local tools:** Colima, the Docker CLI, libpq, the Session Manager plugin in `~/.local/bin`, Playwright in `/tmp/bb-pw`.
- **Docker containers (stopped):** `bb-pg`, `bb-egress-relay`, `bb-egress-relay-4110`.
- **AWS (the test account, us-east-1):** the `Breadboard-verify` stack, its retained secrets, bucket, and snapshots, and the `agent-breadboard` ECR repository were all deleted. The CDK bootstrap stack predates this work and was left in place.
