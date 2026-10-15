# Implementation status

**As of:** 2026-10-15.
**Branch:** `main`; the `cdk-aws-deploy` work was merged on 2026-10-10. The verification pass and its follow-ups start at `467a8b1` (`git log 467a8b1..HEAD`).
**Read first when resuming:** this file, then the checklist at the end of [verification-plan.md](verification-plan.md).

## Summary

Every roadmap phase (0–7) is implemented. The automated suites pass. On 2026-10-01 the surfaces that had never run (Docker sandboxes, real Postgres, Bedrock, the browser UI, the broker, Strands, the AWS deployment, OIDC, backup/restore) were exercised for real, which found and fixed roughly 40 bugs. The Phase 6 acceptance path, which gates the internal pilot ([13](../specs/13-roadmap.md) §4), ran end to end on Bedrock. On 2026-10-10 the branch was merged into `main`, the specs were brought in line with the decisions made during the pass (04, 06, 12, 13), production hardening landed (the server refuses to start without real secrets), and the reference deployment was stood up for real as `Breadboard-pilot` (below). The remaining work is a small set of verification gaps, minor UI issues, and the Phase 7 acceptance items that were not exercised.

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
| Root (all packages, PGlite, mock model, process sandbox) | `npx vitest run` | 79 files, 613 passed, 4 skipped (the skips are Docker-only); 2026-10-15 |
| Server on real Postgres | `cd packages/server && TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npx vitest run` | 38 files, 298 passed (at `a2e9538`, 2026-10-01; not re-run since) |
| Toolbox on the Docker runner | see [verification-plan.md](verification-plan.md) §1.2 (Colima needs the egress relay) | 19 of 19 |
| CDK template | `cd deploy/aws && npm test` | 29 passed |
| Typecheck / lint | `npm run typecheck`, `npm run lint` | clean; 4 pre-existing lint warnings (2026-10-10) |

The live results for every plan section, with notes, are in the [verification-plan.md](verification-plan.md) checklist.

## Decisions made 2026-10-01

Each one is implemented and was verified live.

1. **Eval runs wait for the human reviewer at hard gates.** Eval sessions gate like production. The verdict is recorded on the fixture's aggregate row. Runs still `running` resume after a restart. Recorded in spec [04](../specs/04-evals.md) §4.
2. **Sandboxed harness model calls go through the model gateway.** Tool code uses `model_converse` / `ctx.converse`, which requires the reserved `model` capability. Spawn-harness's Strands adapter uses it, so its spend lands on the Session and the sandbox holds no AWS credentials.
3. **Image upgrades on the AWS reference host happen in place via cfn-hup.** Images live in CloudFormation::Init metadata; user data is one-time host setup.
4. **Production refuses the seed's `*-change-me` tokens.** `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` (generated as `breadboard-<name>/admin-token` by the stack) signs in as `bootstrap-admin` in any auth mode. Since 2026-10-11 it can be turned off in place (decision 1 of 2026-10-11).

Earlier choices for this pass: Colima as the Docker runtime; SSM-only access to the AWS host (`allowedCidrs=none`); seed presets fixed to real `us.*` inference-profile ids; the UI walkthrough driven by headless Playwright.

## Decisions made 2026-10-10

1. **Production refuses to start without real secrets.** With `NODE_ENV=production`, `buildServices` exits before touching the database unless `TOKEN_SIGNING_KEY` (≥32 chars, not `*-change-me`) and `BROKER_MASTER_KEY` are set, and the bootstrap token is not a well-known value. The AWS stack already generated all three; compose now needs them exported. Recorded in spec [12](../specs/12-security-deployment.md) §3 and §10.
2. **The pilot is reached through an authenticating HTTPS proxy, deployed from a separate private repo.** An Amazon-internal add-on puts CloudFront in front of the host (a VPC origin to the instance, so the host still has no inbound rule) with an internal identity gate at the edge and an internal hostname. It is deploy configuration only, per spec [12](../specs/12-security-deployment.md) §8, and stays out of this repo. This repo supports it in two ways: the reference stack publishes its server instance, security group and network as outputs, and the UI recovers when the proxy's short-lived session expires (`packages/ui/src/lib/edge-auth.ts`: an HTML 403 is checked against the public `/api/v1/health`, then the page reloads once through the proxy's sign-in, at most every 30 s).
3. **`publicUrl` is applied in place.** It moved from the host's one-time user data into the CloudFormation::Init deployment metadata, so `cdk deploy -c publicUrl=…` recreates the container instead of replacing the host. Stacks deployed with an empty `publicUrl` keep byte-identical user data.

## Decisions made 2026-10-11

1. **The bootstrap admin can be turned off once another admin can sign in.** Leaving `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` unset or empty disables it and ends its sessions. The reference stack does this in place with `-c bootstrapAdmin=false`, keeping the secret so that `-c bootstrapAdmin=true` is the break-glass path. At startup the server logs an error when no admin could sign in. An authenticating proxy in front of the server (such as the pilot's edge) does not count: it gates who reaches Breadboard but sends no identity, so the pilot needs real local tokens or OIDC first. Recorded in spec [12](../specs/12-security-deployment.md) §3.
2. **Trusted proxy: one sign-in behind an authenticating proxy that sends no identity.** A request carrying `BREADBOARD_TRUSTED_PROXY_SECRET` in `x-breadboard-proxy-auth` signs in as `BREADBOARD_TRUSTED_PROXY_USER`, an admin created on first use. It is for single-person audiences only, because the server cannot tell the proxy's users apart. Explicit credentials still win. Requests that bypass the proxy get no trust; this covers the SSM tunnel and tool sandboxes, which never hold the secret. The reference stack generates the secret with `trustedProxyUser` and applies it in place. All deployment overrides now go through a root-only `/etc/breadboard/overrides.env`, so no secret value reaches a command line or the template. Recorded in spec [12](../specs/12-security-deployment.md) §3.

## Decisions made 2026-10-12

Prompted by a first tool-designer session behind an authenticating edge. The reply ran about 9 minutes and opened a proposal, but the browser saw only errors.

1. **Chat replies run in the background.** `POST /conversations/:id/messages` with `Prefer: respond-async` returns `202` at once and runs the reply on the server. The edge's 60 s origin timeout had cut off the old blocking request. `GET /conversations/:id` now reports `busy`, `last_error` and the session's `proposals`. Conversation sessions now publish `session.event` (before, only circuit runs did). The designer panel and the Intake chat follow a reply through those events and a slow fallback poll, and also after a reload. If a send fails, they check the server before showing an error, and they send an idempotency key. Without the header, the endpoint still replies inline for API and MCP callers.
2. **A tool call cut off at `max_tokens` never runs.** The agent loop answers it with an `output-truncated` error result, so the model re-issues it with smaller arguments. Before, the half-written call ran with empty arguments. For Claude models with a 128K output cap, the Bedrock default output ceiling rose from 16K to 32K.
3. **`read_config` accepts a definition's directory** (`tools/<UID>`, `subagents/<UID>`), as agents tend to write it.
4. **Only circuit and eval runs are orchestrator runs.** Startup recovery and the dispatcher's run-slot count now skip `intake` and `conversation` sessions. Before, a server restart re-queued every open chat as a circuit run, which suspended it with `circuit null not found` (seen on the first upgrade of an instance with an open designer chat). Every open chat also held one `max_concurrent_runs` slot.

## Decisions made 2026-10-13

Prompted by the signed-cookie edge's 15-minute sessions, which interrupt long conversations: every expiry fails in-flight calls and reconnects until the page reloads.

1. **Load-balancer identity.** Behind an AWS Application Load Balancer that authenticates users with OIDC (sessions of hours, with the load balancer refreshing tokens itself), `BREADBOARD_ALB_AUTH_ARN` makes the server verify its signed `x-amzn-oidc-data` header on every request and sign the request in as the token's `sub`. It checks ES256, `signer` equal to the configured ARN, the optional issuer and client id pins, the signature against the regional key for `kid`, the expiry and a subject. Users are created at first sign-in as members, so unlike the trusted proxy it suits a team. A header that does not verify is a 401, never a fallback. Sync sockets take the identity once, at the upgrade, because the header expires within minutes. The reference stack passes it with `-c albAuthArn` (plus `albAuthIssuer`, `albAuthClientId`) and warns when `allowedCidrs` leaves the server port open beside it. Recorded in spec [12](../specs/12-security-deployment.md) §3.
2. **Edge identity is same-origin only.** The trusted proxy and the load balancer vouch on the strength of cookies the browser attaches by itself, and CORS reflects any origin. A request whose `Origin` names another host now gets no edge identity, which closes cross-site reads and WebSocket hijacking through the edge.
3. **Adoption instead of a suffixed duplicate.** `BREADBOARD_OIDC_ADOPT_HANDLES` (`-c oidcAdoptHandles`) lets the first OIDC or load-balancer sign-in with a listed handle become that existing user (id, admin flag, history), provided it has no subject yet and is not deactivated. This is how the trusted-proxy user carries over to the load balancer. A sign-in without a `name` claim no longer resets a user's display name.
4. **The UI recognises a load balancer's expiry** (a non-JSON 401, or a redirect, with API fetches made with `redirect: 'manual'`) like the signed-cookie gate's HTML 403, and reloads through sign-in.

## Decisions made 2026-10-14

Prompted by a tool-designer chat, on an instance behind a load balancer, whose proposal the user could not find. The only review surface was a card inside the chat panel, and the panel knew its session and proposals only from this tab's `sessionStorage`. So the card was lost in another tab or browser, after "Start a new conversation", and whenever the conversation had stopped (designer chats get a $5 budget, and the tool designer runs on `large`). The proposal stayed open, unreachable from the UI. Recorded in spec [10](../specs/10-ui.md) §4 (items 6 and 7), [06](../specs/06-toolbox.md) §6 and [11](../specs/11-api-mcp.md) §3.

1. **Every proposal has a review page,** `/proposals/<id>`: each changed definition in its native diff, validation, tool checks, run evals, merge / discard, and revision requests that go to the conversation that opened it (the diff refreshes when the designer amends). **Proposals** in the left rail lists them by status, with the open count. Editor headers and inventory rows carry an open-proposals badge, the Session explorer of a conversation lists its proposals, and the command palette opens a pasted `prp_` id.
2. **The proposal card leads with Review changes.** It is placed after the designer's `propose_config_change` result, found from the transcript. A failed call shows as "No proposal was opened" with the error, so a claimed but missing proposal is visible.
3. **The designer panel takes its state from the server.** It resumes this tab's session, else a `?chat=` link's, else the user's latest designer chat on the definition (`GET /conversations?definition=&mine=1`). An ended conversation stays readable with its cards; the next message, or a revision request on a card, starts a new conversation that can still amend the open proposal.
4. **Tool CI runs on proposals.** `GET /config/proposals/:id/checks` runs `Toolbox.ci` (manifest, TypeScript type stripping, Python `ast.parse`) for each touched tool at the head, cached per commit. The review page and the card show it, and `propose_config_change` returns it as `tool_checks`. Type-checking and tests still do not run.
5. **The designer pays less per turn.** `propose_config_change` no longer echoes the patch (every later turn re-sent it); it returns `review`, saying where the user reviews. The `[Open proposal]` preamble carries the diff only while the proposal is open. The three designer prompts now end a proposing reply with the id and where to review it, and never describe a change as proposed without a returned id.
6. **Cancelling a conversation keeps its record.** The orchestrator's cancel used to replace a chat's `state_detail` (subagent, context, who started it) with the cancellation, so a cancelled designer chat could not be found or attributed. Runs still keep only their admission keys.

Exercised in headless Chromium against the mock model (local PGlite server): open, amend from the review page, failing checks, a rejected proposal, merge, the list, inventory badges, the Session explorer, a reload, a fresh tab, a `?chat=` link, and an ended chat. Not yet against Bedrock or behind the load balancer.

The seed prompt changes reach only new config repos. Existing instances keep their designer prompts until the three files are updated in their config repos.

## Decisions made 2026-10-14 (lookup by name)

Prompted by a subagent-designer chat in which every `read_config` by name failed: the tool's slug, the slug in place of the UID in its path, and the `config/presets/models.yaml` example from `read_config`'s own description. The designer had no way to list definitions, so it stopped until the user pasted the UID. The preamble's "Referenced by" line also listed slugs without UIDs, which invited the guess. Recorded in spec [01](../specs/01-data-model.md) §6.1–6.2, [06](../specs/06-toolbox.md) §3 and [11](../specs/11-api-mcp.md) §4.

1. **`read_config` resolves what agents type.** Besides a UID, a singleton name or a repo path, it takes a slug (case-insensitive), `<kind>:<slug>`, a slug in place of the UID in a definition path (`tools/<slug>.yaml`, any file under it), and a leading `config/`, the way the specs draw the repo root. A slug that names several definitions is `validation-failed`, listing each with its UID and the `<kind>:<slug>` form. A miss lists the closest definitions. Everything is in the message, because a model sees only code and message. This is `ConfigService.definition(…, { lenient: true })`: references stored in config stay UID-only, and REST `/config/definitions/*` and the UI stay strict, since the UI builds file paths from the id it routes on.
2. **`search_config`** finds definitions by slug, title, UID or path words, best match first (the scoring of `GET /config/search`), optionally by kind, and returns metadata only, so it is not grant-gated (as `read_config`'s `referenced_by` already was not). The three designers get it, and their prompts say to look UIDs up with it. The designer preamble's "Referenced by" line now carries UIDs.

The designer changes reach only new config repos. On existing instances, the three designer files need the new primitive and the lookup bullet in their config repos, after the server is upgraded (an older server silently drops a primitive it does not know).

## Decisions made 2026-10-15

Prompted by wanting a local Claude Code to investigate what a Breadboard has done. The MCP server already served the primitive catalog, but its read side stopped at `get_session_summary` and `read_config` at main, and a member behind the pilot's edge or the second instance's load balancer had no token to connect with (user tokens live in an httpOnly cookie; service tokens are refused by the MCP endpoint by design). Recorded in spec [11](../specs/11-api-mcp.md) §2 and §4, [12](../specs/12-security-deployment.md) §3, [06](../specs/06-toolbox.md) §7, [02](../specs/02-sessions-orchestrator.md) §7 and [mcp.md](mcp.md).

1. **Inspection primitives.** Nineteen read-only primitives in `packages/server/src/toolbox/inspection.ts`: `whoami`, `get_breadboard_overview`, `list_users`, `list_sessions`, `read_session_transcript`, `read_session_events`, `list_session_executions`, `search_nodes`, `inspect_node`, `get_review_queue`, `get_config_history`, `list_proposals`, `read_proposal`, `diff_config`, `list_knowledge_domains`, `list_eval_runs`, `read_eval_run`, `get_eval_analysis`, `list_recent_events`. They are part of the shared catalog, so subagents get them only through `grants.primitives`, and each calls the service method its REST route calls. Long values are clipped (`max_chars`; a clipped value carries `truncated: true` and `total_chars`), and `read_session_transcript` reads a turn in full by `turn_id`. `read_config` and `search_config` take `commit`; `get_session_summary` carries `proposals`, `busy`, `last_error` and `draft_task` for chats; `SessionFilter` gained `created_by` and `definition`; `ConfigService.diff` exposes the repo diff. The `initialize` result carries `instructions` that walk the model through a run investigation. The primitive gate now checks who is calling before validating what they sent. `toBlocks` moved from the UI into `@breadboard/shared` so the transcript tool and the Session explorer agree on what a turn contains.
2. **Personal access tokens.** `bbu_…`, minted on the new Account page (`/account`; user menu → Account & tokens; `g u`), hashed in `user_tokens` (migration 0006), expiring (90 days by default, a year at most), revocable at once, read-only by default (the eight read scopes plus `mcp:call`) or full access (`scopes` null). They resolve to the user's own principal with `token_kind: 'personal'`. Only a browser sign-in may mint or revoke: a session token or cookie, or an authenticating edge's identity (`proxy`), which is what every member's session is on the pilot and on the instance behind a load balancer. A token never mints a token, and service tokens cannot either. `requireAdmin` now also needs an unscoped credential (or the `admin` scope), so a read-only token of an admin is a member everywhere, admin reads included. `POST /me/tokens` returns `mcp_url`, and the page shows the `claude mcp add` command with the secret.
3. **MCP connections need an explicit bearer token.** `/api/v1/mcp` refuses edge identity (`token_kind: 'proxy'`) with 401 before opening a session, so an edge rule that passes the path through for Claude Code can never hand out the trusted-proxy identity. The bearer token also wins when a request carries both, which is what lets a harness send an edge's session alongside it (decision 5).
4. **A route sweep guards the read-only promise.** `packages/server/src/api/scope-sweep.test.ts` builds the full app from the seed, collects every route through the new `buildApp` `onRoute` observer, and calls every mutating route with a read-only token, expecting 403 (`POST /config/validate` and the MCP transport excepted).
5. **Two ways through an authenticating edge, by who owns it** ([mcp.md](mcp.md) §3). A self-hoster who controls the gate may let `/api/v1/mcp` through, narrowed to `Authorization: Bearer bbu_*` on a load balancer, and accepts that the endpoint is then protected by Breadboard's tokens alone. Where an organization's single sign-on at the edge is the security boundary and every path must authenticate there (a declared network-access intent, a security review), the gate stays closed: Claude Code's `headersHelper` supplies the gate's session cookie and the personal token on each connection, and the helper lives with the deployment's configuration. The instance behind a load balancer takes the second way; its helper belongs in the private add-on repo.
6. **What the first Claude Code pass against a running instance found** (fixed the same day):
   - `search_config` treated the whole query as one substring, so a designer's natural query such as "data lake table search catalog" found nothing. A whole-query match still ranks first, by the same tiers. Otherwise each word of 3+ characters (minus a few stopwords) counts, ranked by how many words match. Definitions' `description` is searched too; a word matching only a path or kind does not count. `nearMatches` (the "Closest:" suggestions) is unchanged.
   - `search_config` pages with `offset` / `next_offset`, like `read_session_transcript`.
   - Scoped tokens see only what they can call: `specsFor` drops primitives whose `scope` the token lacks. This one change covers MCP `tools/list`, `GET /primitives` and subagents, which are unscoped and so unaffected.
   - Team tool extensions on MCP need the new `tools:execute` scope to be listed or called, since a tool may write through its broker capabilities. A read-only token no longer reaches them; unscoped credentials and `admin` do, and service tokens can be granted the scope.

Exercised: unit tests over fakes, the transcript and listing against a real PGlite session store, the token routes with browser, edge, service and personal credentials, the sweep, and the MCP transport (instructions, inspection tools, proxy refusal). Claude Code against the instance behind a load balancer, through its headers helper, with a read-only token (decision 6 came out of that pass). Not yet: the Account page in a browser.

Deployment follow-ups, outside this repo: the instance behind a load balancer runs this server and keeps its gate closed, so Claude Code reaches it through a headers helper still to be built in the private add-on repo. The pilot has not been upgraded, and its edge must not pass `/api/v1/mcp` through until it is: its older server accepts the trusted-proxy identity there, and the edge adds that header to every request. Migration `0006_user_tokens.sql` runs at upgrade; the catalog change is code only, so no config-repo update is needed.

## Next steps (in priority order)

1. **Before inviting anyone to the pilot:** set up OIDC. The pilot's trusted proxy signs every edge user in as one admin, so it must stay single-person; widening the edge's access group first would give everyone that identity. Once the browser pass through the edge is confirmed, the bootstrap admin can go (`-c bootstrapAdmin=false`), at the cost of the SSM tunnel's token sign-in; `bootstrapAdmin=true` is the way back. `publicUrl` now points at the edge hostname. The edge's last steps are manual and outside this repo: its access group, onboarding with the internal identity gate, and the grant. After them comes a real-browser pass through the edge: the session-expiry reload, WebSocket editing, and the SSE Live indicator.
2. **Close the verification gaps:**
   - The proposal review flow (decisions of 2026-10-14) on Bedrock behind a load balancer, after updating that instance's three designer prompts to the seed's.
   - The Account page in a browser and a Claude Code connection against a running instance (decisions of 2026-10-15): the instance behind a load balancer through its headers helper, once built; the pilot after its server upgrade.
   - RDS IAM auth (§2.4). Granting a test DB user `rds-db:connect` was not permitted in the session; TLS `verify-full` passed.
   - A real-browser pass over the 11 UI fixes (each was unit-tested only).
   - The egress-relay question for Docker Desktop and for a Linux host running the server outside a container ([deploy/sandbox/README.md](../deploy/sandbox/README.md)).
3. **Fix the remaining walkthrough issues:**
   - The step drawer merges repeated visits and labels them attempts (`SessionExplorer.tsx`; the server also increments `attempt` across visits).
   - ActorLabel shows subagent UIDs instead of slugs.
   - Running LLM steps show $0.00 until they exit.
   - The YAML editor is ~200px wide when History and Designer are both open.
   - AI-edit highlighting covers only subagent/code-step authors.
4. **Remaining Phase 7 acceptance work:**
   - a live git-repo connector sync;
   - orchestrator load/burn-in;
   - timing a fresh-machine self-host from the docs;
   - a webhook delivery check.
5. **Doc and spec gaps:**
   - [self-hosting.md](self-hosting.md)'s backup runbook should say to use the server's major version of `pg_dump` (an 18 client against a 16 server emits `SET transaction_timeout`, which fails on restore).
   - Email intake is missing from the deferred register.
   - Spec 07 claims circuit- and step-level knowledge grants that the circuit schema in spec 03 does not have.
6. **Cost tuning before the pilot.** lit-review's `summarize` on the `large` preset (Opus 5) costs about $1–1.5 per run. The eval model-regression and cheapest-model views can guide a preset change.

## Pilot deployment (AWS)

`Breadboard-pilot` has run in the team's AWS account (us-east-1) since 2026-10-10, deployed from `main` at `13de764` with `deploy/aws/`:

- **Inputs:** `-c name=pilot -c allowedCidrs=none -c publicUrl=https://<edge hostname>`, the account's default VPC (two public subnets for RDS, one for the host; the lookup is cached in the gitignored `deploy/aws/cdk.context.json`, and `vpcId`, `dbSubnetIds`, `serverSubnetId` must still be passed), `-c trustedProxyUser=<handle>` (since 2026-10-11), and the three images in the `agent-breadboard` ECR repository: `server-ea0fa33` (since 2026-10-11, upgraded in place from `server-bc0825f`, itself from `server-13de764`), `sandbox-ts-13de764`, `sandbox-py-13de764`. Everything else is the stack default, including RDS deletion protection (on).
- **Edge (since 2026-10-10):** CloudFront from the private add-on repo (decision 2 above) serves the UI at the internal edge hostname. It reaches the server through a VPC origin, and the stack's only change to the base is one ingress rule on the server security group from CloudFront's VPC-origins security group. The add-on resolves the instance from this stack's outputs at every synth, so **redeploy the add-on after anything that replaces the host**.
- **Access:** no inbound port. Tunnel with SSM, then open `http://localhost:14000`:
  ```bash
  export AWS_PROFILE=<profile> AWS_REGION=us-east-1
  ID=$(aws ec2 describe-instances --filters Name=tag:aws:cloudformation:stack-name,Values=Breadboard-pilot Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
  aws ssm start-session --target $ID --document-name AWS-StartPortForwardingSession --parameters portNumber=4000,localPortNumber=14000
  ```
  The Session Manager plugin must be on `PATH` (`~/.local/bin` on the dev machine).
- **Sign-in through the edge:** none beyond the edge's own. The edge sends the trusted-proxy secret, and requests sign in as the configured handle, an admin. A browser that still holds a `bootstrap-admin` session keeps it until Sign out.
- **Sign-in through the tunnel:** `aws secretsmanager get-secret-value --secret-id breadboard-pilot/admin-token --query SecretString --output text` as `bootstrap-admin`, which holds the `scientist` review role so lit-review gates reach it. The seed dev tokens are refused (401), as designed.
- **Smoke (2026-10-10):** host checks via SSM showed the server container on the internal `breadboard-sandbox` network with 2+2 warm sandboxes, `cfn-hup` active, migrations applied, and the config repo seeded. Through the tunnel: health ok (`pg`, `bedrock`, `docker`); the broker capabilities `crossref-api` and `semantic-scholar-api` were registered; a task dispatched through triage into lit-review, which ran `gather` on `us.anthropic.claude-sonnet-5` and `summarize` on `us.anthropic.claude-opus-5`, executed `search-scholarly` eight times in the Python sandbox and `check-citations` once in the TypeScript sandbox, logged nine broker calls, and reached `quality-gate` in about four minutes at **$0.89**.
- **`publicUrl`** is the edge's HTTPS address, so the session cookie is `Secure` and OIDC redirects target the edge. The tunnel still works because the UI uses relative paths and browsers treat `http://localhost` as a secure context (Chrome and Firefox; Safari users of the tunnel should sign in with a bearer token).
- **Upgrade:** build amd64 images (Colima's Rosetta emulation handles `--platform linux/amd64`), push with a new tag, redeploy with the same `-c` set; cfn-hup swaps the container in place ([deploy/aws/README.md](../deploy/aws/README.md)). Before deploying, check that `cdk diff --method=template` changes only the instance's `Metadata` and outputs. Any `UserData` change would replace the host, and the config repo lives on its root volume. This check passed for the 2026-10-10 upgrade.
- **Running cost:** roughly $110–120/month for the `t3.large` host and `db.t4g.medium` instance, plus Bedrock spend per run.

## Resuming locally

To bring the local environment back:

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
- **AWS (us-east-1):** the 2026-10-01 `Breadboard-verify` stack and its leftovers were deleted. `Breadboard-pilot` and the `agent-breadboard` ECR repository are live (see Pilot deployment). The CDK bootstrap stack predates this work.
