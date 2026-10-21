# Implementation status

**As of:** 2026-10-20.
**Branch:** `main`; the `cdk-aws-deploy` work was merged on 2026-10-10. The verification pass and its follow-ups start at `467a8b1` (`git log 467a8b1..HEAD`).
**Read first when resuming:** this file, then the checklist at the end of [verification-plan.md](verification-plan.md).

## Summary

Every roadmap phase (0–7) is implemented. The automated suites pass. On 2026-10-01 the surfaces that had never run (Docker sandboxes, real Postgres, Bedrock, the browser UI, the broker, Strands, the AWS deployment, OIDC, backup/restore) were exercised for real, which found and fixed roughly 40 bugs. The Phase 6 acceptance path, which gates the first internal deployment ([13](../specs/13-roadmap.md) §4), ran end to end on Bedrock. On 2026-10-10 the branch was merged into `main`, the specs were brought in line with the decisions made during the pass (04, 06, 12, 13), and production hardening landed (the server refuses to start without real secrets). The remaining work is a small set of verification gaps, minor UI issues, and the Phase 7 acceptance items that were not exercised.

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
| Root (all packages, PGlite, mock model, process sandbox) | `npx vitest run` | 80 files, 631 passed, 5 skipped (Docker-only, plus the Strands adapter checks without `PYTHON_BIN`); 2026-10-15 |
| Server on real Postgres | `cd packages/server && TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npx vitest run` | 46 files, 393 passed, 1 failed (2026-10-15). The failure, `src/mcp/http.test.ts` "MCP conversations left by an earlier process", is a race that predates the reasoning/caching work (it fails with it stashed too): the test asserts before the endpoint's startup cleanup finishes on the slower database |
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
2. **An authenticating edge in front of the host is deploy configuration, kept out of this repo** (spec [12](../specs/12-security-deployment.md) §8). This repo supports one in two ways: the reference stack publishes its server instance, security group and network as outputs, and the UI recovers when the edge's short-lived session expires (`packages/ui/src/lib/edge-auth.ts`: an HTML 403 is checked against the public `/api/v1/health`, then the page reloads once through the proxy's sign-in, at most every 30 s).
3. **`publicUrl` is applied in place.** It moved from the host's one-time user data into the CloudFormation::Init deployment metadata, so `cdk deploy -c publicUrl=…` recreates the container instead of replacing the host. Stacks deployed with an empty `publicUrl` keep byte-identical user data.

## Decisions made 2026-10-11

1. **The bootstrap admin can be turned off once another admin can sign in.** Leaving `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN` unset or empty disables it and ends its sessions. The reference stack does this in place with `-c bootstrapAdmin=false`, keeping the secret so that `-c bootstrapAdmin=true` is the break-glass path. At startup the server logs an error when no admin could sign in. An authenticating proxy in front of the server does not count unless Breadboard trusts it: it gates who reaches Breadboard but sends no identity, so such a deployment needs real local tokens or OIDC first. Recorded in spec [12](../specs/12-security-deployment.md) §3.
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

Prompted by wanting a local Claude Code to investigate what a Breadboard has done. The MCP server already served the primitive catalog, but its read side stopped at `get_session_summary` and `read_config` at main, and a member behind an authenticating edge or load balancer had no token to connect with (user tokens live in an httpOnly cookie; service tokens are refused by the MCP endpoint by design). Recorded in spec [11](../specs/11-api-mcp.md) §2 and §4, [12](../specs/12-security-deployment.md) §3, [06](../specs/06-toolbox.md) §7, [02](../specs/02-sessions-orchestrator.md) §7 and [mcp.md](mcp.md).

1. **Inspection primitives.** Nineteen read-only primitives in `packages/server/src/toolbox/inspection.ts`: `whoami`, `get_breadboard_overview`, `list_users`, `list_sessions`, `read_session_transcript`, `read_session_events`, `list_session_executions`, `search_nodes`, `inspect_node`, `get_review_queue`, `get_config_history`, `list_proposals`, `read_proposal`, `diff_config`, `list_knowledge_domains`, `list_eval_runs`, `read_eval_run`, `get_eval_analysis`, `list_recent_events`. They are part of the shared catalog, so subagents get them only through `grants.primitives`, and each calls the service method its REST route calls. Long values are clipped (`max_chars`; a clipped value carries `truncated: true` and `total_chars`), and `read_session_transcript` reads a turn in full by `turn_id`. `read_config` and `search_config` take `commit`; `get_session_summary` carries `proposals`, `busy`, `last_error` and `draft_task` for chats; `SessionFilter` gained `created_by` and `definition`; `ConfigService.diff` exposes the repo diff. The `initialize` result carries `instructions` that walk the model through a run investigation. The primitive gate now checks who is calling before validating what they sent. `toBlocks` moved from the UI into `@breadboard/shared` so the transcript tool and the Session explorer agree on what a turn contains.
2. **Personal access tokens.** `bbu_…`, minted on the new Account page (`/account`; user menu → Account & tokens; `g u`), hashed in `user_tokens` (migration 0006), expiring (90 days by default, a year at most), revocable at once, read-only by default (the eight read scopes plus `mcp:call`) or full access (`scopes` null). They resolve to the user's own principal with `token_kind: 'personal'`. Only a browser sign-in may mint or revoke: a session token or cookie, or an authenticating edge's identity (`proxy`), which is what every member's session is on the instance behind a load balancer. A token never mints a token, and service tokens cannot either. `requireAdmin` now also needs an unscoped credential (or the `admin` scope), so a read-only token of an admin is a member everywhere, admin reads included. `POST /me/tokens` returns `mcp_url`, and the page shows the `claude mcp add` command with the secret.
3. **MCP connections need an explicit bearer token.** `/api/v1/mcp` refuses edge identity (`token_kind: 'proxy'`) with 401 before opening a session, so an edge rule that passes the path through for Claude Code can never hand out the trusted-proxy identity. The bearer token also wins when a request carries both, which is what lets a harness send an edge's session alongside it (decision 5).
4. **A route sweep guards the read-only promise.** `packages/server/src/api/scope-sweep.test.ts` builds the full app from the seed, collects every route through the new `buildApp` `onRoute` observer, and calls every mutating route with a read-only token, expecting 403 (`POST /config/validate` and the MCP transport excepted).
5. **Two ways through an authenticating edge, by who owns it** ([mcp.md](mcp.md) §3). A self-hoster who controls the gate may let `/api/v1/mcp` through, narrowed to `Authorization: Bearer bbu_*` on a load balancer, and accepts that the endpoint is then protected by Breadboard's tokens alone. Where an organization's single sign-on at the edge is the security boundary and every path must authenticate there (a declared network-access intent, a security review), the gate stays closed: Claude Code's `headersHelper` supplies the gate's session cookie and the personal token on each connection, and the helper lives with the deployment's configuration. The instance behind a load balancer takes the second way; its helper belongs in the private add-on repo.
6. **What the first Claude Code pass against a running instance found** (fixed the same day):
   - `search_config` treated the whole query as one substring, so a designer's natural query such as "data lake table search catalog" found nothing. A whole-query match still ranks first, by the same tiers. Otherwise each word of 3+ characters (minus a few stopwords) counts, ranked by how many words match. Definitions' `description` is searched too; a word matching only a path or kind does not count. `nearMatches` (the "Closest:" suggestions) is unchanged.
   - `search_config` pages with `offset` / `next_offset`, like `read_session_transcript`.
   - Scoped tokens see only what they can call: `specsFor` drops primitives whose `scope` the token lacks. This one change covers MCP `tools/list`, `GET /primitives` and subagents, which are unscoped and so unaffected.
   - Team tool extensions on MCP need the new `tools:execute` scope to be listed or called, since a tool may write through its broker capabilities. A read-only token no longer reaches them; unscoped credentials and `admin` do, and service tokens can be granted the scope.
   - A deploy left MCP conversations `running` for good: connections live in the server process, and `breadboard-apply` replaced the container with `docker rm -f`, which skips the graceful shutdown that closes them. The apply script now runs `docker stop -t 30` first; the MCP endpoint closes its connections in Fastify's `preClose` hook (in `onClose` it never ran while a client held its SSE stream, because `app.close()` waits for in-flight requests first); and it closes any MCP conversation still `running` from an earlier process when it registers (`closed_reason: server-restart`). Designer and intake chats survive restarts and are left alone.
7. **What a second pass against the same instance found** (fixed the same day):
   - `read_config` on one file of a tool or circuit (`tools/<UID>/src/index.ts`, `circuits/<UID>/prompts/x.md`) returned the whole definition the path resolves to, every source file included; a designer reading `tool.yaml` and then `src/index.ts` paid for the same 33K characters twice. It now returns `{ path, commit, owner, text }` for that file, and a missing file is `not-found` with the definition's file list. The circuit grant still applies to the owner. `ConfigService.definition` is unchanged, so REST, history and the designer preamble still resolve a sub-file path to its definition.
   - `validate_config` skipped the comma-split warnings for a definition that failed its schema check, which is when its author is iterating on it. `parseConfigYaml` now hands back the parsed document on a schema failure, and its circuit and tool schemas are still linted. A reference to such a definition said "which does not exist"; it now says the definition is invalid and points at that file's errors.
   - Closing an MCP connection (idle, client delete, transport closed, shutdown) replaced the session's `state_detail`, losing `client`; it now adds `closed_reason` to it, as the restart cleanup already did.

Exercised: unit tests over fakes, the transcript and listing against a real PGlite session store, the token routes with browser, edge, service and personal credentials, the sweep, and the MCP transport (instructions, inspection tools, proxy refusal). Claude Code against the instance behind a load balancer, through its headers helper, with a read-only token (decision 6 came out of that pass). Not yet: the Account page in a browser.

Deployment follow-ups, outside this repo: the instance behind a load balancer runs this server and keeps its gate closed, so Claude Code reaches it through a headers helper in the private deployment package. Migration `0006_user_tokens.sql` runs at upgrade; the catalog change is code only, so no config-repo update is needed.

## Decisions made 2026-10-15 (reasoning, prompt caching, Strands Harness)

Prompted by the question whether to integrate [Strands Harness](https://strandsagents.com/blog/introducing-strands-harness/). Reading the model path showed that most of what Harness would save was missing from Breadboard itself: no prompt caching anywhere, and reasoning that the preset models already produce (Opus 5 and Sonnet 5 think by default) kept only in a non-enumerable property, so it was lost on every saved turn, every designer-chat post, and every `model_converse` reply. Recorded in spec [12](../specs/12-security-deployment.md) §7, [02](../specs/02-sessions-orchestrator.md) §6, [03](../specs/03-circuits.md) §3.1, [05](../specs/05-subagents.md) §2–3, [06](../specs/06-toolbox.md) §3, §7 and §12, [08](../specs/08-intake.md) §4 and [tool-author-guide.md](tool-author-guide.md).

1. **Harness is a `spawn-harness` adapter, not the core loop** (spec 06 §12, decision 5). `harness: strands-harness` builds `create_harness(...)` in the sandbox with memory, sessions, skills, web tools and its own caching off; `strands` stays the default until evals compare them. `strands-harness` is pinned (0.3.1) in the tool's `requirements.txt`, and the Python sandbox image needs it next to `strands-agents` ([deploy/sandbox/README.md](../deploy/sandbox/README.md)).
2. **Prompt caching in the gateway.** The Bedrock provider places cache points after the tools, the system prompt and the history (Claude; Nova without the tools). Turns and checkpoints gained `tokens_cache_read` / `tokens_cache_write` (migration `0007_cache_tokens.sql`), pricing gained cache rates (presets may set `cache_read_per_m` / `cache_write_per_m`), and token budgets count all four columns, so budgets behave as before and only cost falls. The UI shows cached tokens beside in/out.
3. **Prefix stability.** MCP tools are listed in name order; a finish-tool re-ask no longer injects the same knowledge notes again; and conversations are append-only: the context preamble (draft task, open definition, open proposal) is recorded as a `system` turn (`{kind: 'context-preamble'}`) when it changes, instead of being rewritten into the first message on every post.
4. **Reasoning as a chat block.** `{type: 'reasoning', text, signature? | redacted?, model_id, prefix_fp}` is stored on turns, replayed verbatim to the same model under the same system-prompt-and-tools fingerprint, and dropped otherwise; a model that rejects replayed reasoning gets the request once more without it. Claude 5.x is always asked for summarized adaptive thinking; Opus/Sonnet 4.6–4.9 only when an effort is set. Thinking requests never force a tool choice. Transcripts (Session explorer, designer and intake chats, `read_session_transcript`) show the summary, never the signature.
5. **Effort.** An optional `effort` (low…max) on the Subagent, overridable per LLM step; `model_converse` and `ctx.converse` take `effort` and `force_tool`, and `spawn-harness` has an `effort` setting.
6. **Tool-journal keys after a re-ask.** The finish-tool re-ask ran the conversation again with the call index restarting at 0 in the same attempt, so a tool call after a re-ask reused the first call's journal key (replaying its result, or failing with `idempotency-mismatch`). `RunConversationInput.call_index_start` / `ConversationResult.tool_calls` carry the index across.

Exercised: unit tests (gateway mapping, pricing, runtime, conversations, store, inspection, shared turns), the root suite, and live Bedrock calls through the provider: Sonnet 5 (cache writes then ~6.5K-token reads per turn; reasoning summaries with signatures replayed in a tool loop and after a JSON round-trip, no validation errors), Haiku 4.5 (caching, no reasoning requested), and Nova Pro (caching; it rejects a cache point in a message holding tool results, so the provider leaves that one out for Nova). The Python adapter checks (`packages/server/test/spawn_harness_adapters.py`, run by `seed-tools.test.ts` when `PYTHON_BIN` has `strands-agents` and `strands-harness`) drive both adapters against a fake `ctx`. Not yet: `spawn-harness` with `strands-harness` in the Docker sandbox against Bedrock, the UI changes in a browser, and an eval comparing the two adapters.

Deployed to the instance behind a load balancer the same night: server `1060930` (migration 0007 applied), and a Python sandbox image built with `--build-arg PIP_PACKAGES="strands-agents>=1.61 strands-harness==0.3.1"` (both adapters' checks pass inside it with a read-only root, no network and uid 10001). Its config repo had the seed's `spawn-harness` unchanged, so two proposals bring it up to date: the tool (which also deletes a `.pyc` the original seed committed; `.dockerignore` now keeps bytecode out of images) and the subagent and circuit designers' prompts, which now describe `effort`.

## Fixed 2026-10-16: empty "running" MCP sessions

The dashboard's Running tile ("Actively stepping") showed sessions with no events after a quiet night. They were MCP connections: Claude Code connects at startup (initialize and `tools/list`, about three connections per start) and often never calls a tool, and each connection was logged as a `running` conversation session at `initialize`, which stayed open until the 30-minute idle sweep. Two fixes (`448001a`):

1. The MCP transport opens a connection's conversation session on its first tool call or resource read. Concurrent first calls share one session, and a connection that is closing never opens one.
2. The Running tile counts only `circuit-run` and `eval-run` sessions (`countByState(state, kinds?)`). Open designer and intake chats inflated it too. The tile links to the Sessions list with a new "Runs (circuit + eval)" kind filter.

Exercised: new transport tests (no session without a call, a shared session for concurrent first calls), store and dashboard tests on PGlite, and the root suite. Deployed as server `448001a` to the instance behind a load balancer. After the restart, the reconnecting connections that made no call left no session, and the overview showed `running: 0` while an MCP session was open.

## Decisions made 2026-10-20: RDS IAM authentication

Prompted by an internal compliance finding against the instance behind a load balancer: its database had a login role (the master user) authenticated with a long-lived password, which the server used. Recorded in spec [12](../specs/12-security-deployment.md) §1 and [deploy/aws/README.md](../deploy/aws/README.md) (Database authentication).

1. **The server signs in to RDS with IAM tokens.** `DATABASE_IAM_AUTH` had never worked: `PgDb` passed `connectionString` together with a password function, and node-postgres parses the connection string over the config, so a URL without a password replaced the function with `''`. The pool config is now built from parsed fields (`poolConfig` in `packages/server/src/db/pg.ts`); URL SSL parameters keep their precedence over `DATABASE_SSL`. A refused token fails boot with a hint about `rds-db:connect` and `rds_iam`.
2. **The reference stack moves the connection into the deployment metadata.** The password-less `DATABASE_URL` and `DATABASE_IAM_AUTH=true` are in `deploy.env`, and `breadboard-apply` passes them as overrides, so hosts bootstrapped earlier switch too. `breadboard-db-grant-iam`, run once over SSM, grants `rds_iam` to the master user inside the server image and lists login roles as `iam-only`, `superuser` or `PASSWORD`.
3. **The master password leaves the stack; the secret stays.** `-c dbMasterPassword=false` drops `MasterUserPassword` and the host's read access, then the password is removed from the secret's value. The secret cannot go: the template's `MasterUsername` is a reference to it, and a live change set showed that CloudFormation replaces the database when that text changes, even to the same name as a literal (it compares template text, `RequiresRecreation: Always`).
4. **A user data change restarts the reference host; it does not replace it.** The root volume is EBS and the instance's logical id carries no user-data hash, so CloudFormation stops and starts the same instance. Earlier notes here and in the README said otherwise.

Deployed to the instance behind a load balancer as server `8cb5f5b` (then `7e95830`, infrastructure only): the host restarted once (same instance, private IP and config repo), the grant ran, the master password is refused (`PAM authentication failed`), the server and the load balancer target are healthy, and phase 2 modified the database in place (same resource id, no RDS events).

## Fixed 2026-10-21: long MCP tool calls lost their result

The MCP transport's idle sweep closes a connection 30 minutes after its last request. A tool call's request is the last one while the call runs, so a call of about 30 minutes (an Athena query at Athena's own DML timeout) had its connection closed under it: the tool finished, and the result was lost. The MCP server now reports each tool call's start and end to the transport (`on_call`). A connection with a call in flight is never idle, and its idle clock restarts when the call returns. A new transport test covers this (it hangs on the old code). Deployed to the instance behind a load balancer as server `55308cf` (a metadata-only change: same host, health ok, no migrations). That instance's Athena tool now waits up to 30 minutes per query.

## Next steps (in priority order)

0. **Roll out reasoning, caching and Strands Harness** (decisions of 2026-10-15, above). Build the Python sandbox image with `strands-harness==0.3.1`, then run a `spawn-harness` step with `harness: strands-harness` in Docker on Bedrock and a designer chat of three or more messages, checking cache reads and reasoning in the transcript. Upgrades apply migration 0007 at startup; seed changes (`spawn-harness` manifest and sources) reach only new config repos, so existing instances need the tool updated in their config repo. Then compare `strands` and `strands-harness` (and effort settings) on the same fixtures.

1. **Close the verification gaps:**
   - The proposal review flow (decisions of 2026-10-14) on Bedrock behind a load balancer, after updating that instance's three designer prompts to the seed's.
   - The Account page in a browser and a Claude Code connection against a running instance (decisions of 2026-10-15): the instance behind a load balancer through its headers helper.
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
5. **Cost tuning.** lit-review's `summarize` on the `large` preset (Opus 5) costs about $1–1.5 per run. The eval model-regression and cheapest-model views can guide a preset change.

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
- **AWS (us-east-1):** the 2026-10-01 `Breadboard-verify` stack and its leftovers were deleted. The CDK bootstrap stack predates this work.
