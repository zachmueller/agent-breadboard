# Connecting to the Breadboard MCP server

Every Breadboard runs a built-in MCP server ([11 — API & MCP](../specs/11-api-mcp.md) §4). From a local harness such as Claude Code you can inspect everything your Breadboard has done: sessions and their full transcripts, the orchestrator's event log, sandboxed tool executions, tasks and artifacts with their lineage, configuration at any commit with its history and proposals, knowledge notes, eval runs, and the instance's health. With a full-access token you can also work in it: create and triage Tasks, comment on Artifacts, edit Knowledge Notes, run circuits, propose configuration changes and call team tool extensions.

- **Endpoint:** `http(s)://<breadboard-host>/api/v1/mcp`
- **Transport:** MCP Streamable HTTP (`POST` / `GET` / `DELETE` on that one URL). There is no stdio transport; local harnesses connect over HTTP.
- **Auth:** `Authorization: Bearer <token>` with a **personal access token** (§1). Connections are user connections: a service token is refused. The identity an authenticating proxy or load balancer adds to requests is never enough on its own, because a connection must name the Breadboard credential (and so the scopes) it acts with. How to get through such an edge depends on who owns it (§3).

## 1. Get a token

Open **Account & tokens** from the user menu (top right; also `g` `u`, or the command palette) and create a personal access token.

- **Read-only** (the default) can read everything you can see and changes nothing. Use it for investigating. The server lists only the tools a token's scopes allow, so a read-only connection sees no working tools and no team tool extensions.
- **Full access** acts exactly as you, including review verdicts and configuration merges. Create one only when Claude Code should do work in your Breadboard.
- Tokens expire (90 days by default, a year at most) and can be revoked on the same page, which takes effect at once. The secret (`bbu_…`) is shown once, together with the ready-to-paste command below.

A token can never mint another token, and admin-only pages stay behind your browser sign-in: a read-only token of an admin is a member.

## 2. Claude Code

```sh
claude mcp add --transport http breadboard https://<breadboard-host>/api/v1/mcp \
  --header "Authorization: Bearer bbu_…"
```

`claude mcp list` shows the connection. The tools appear as `mcp__breadboard__<name>`. The server also sends short instructions with the connection (ids, where to start, how to page and read clipped values), which Claude Code shows the model.

## 3. Reaching the endpoint

How a harness reaches `/api/v1/mcp` depends on what stands in front of the server and who decides its rules. In every case the server does the same thing: a personal token in `Authorization` always wins over any identity an edge adds, and edge identity alone is refused on this path, so a request that carries no valid token never opens a connection.

### Self-hosted, Breadboard does the sign-in

The server is reachable over HTTPS directly, or through a reverse proxy or load balancer that only terminates TLS, and Breadboard's own sign-in (OIDC or static users, [self-hosting.md](self-hosting.md)) is the authentication. Personal tokens are Breadboard's own credential for this case. Point the client at the endpoint with the bearer header, as in §2, and nothing else is needed.

### Self-hosted, behind a sign-in gate you control

A gate in front of the server signs browser users in: a load balancer that authenticates with OIDC, a CDN function that checks a signed cookie, an access proxy. If your own rules allow one path to be authenticated by Breadboard alone, let `/api/v1/mcp` through the gate without a browser sign-in:

- **AWS Application Load Balancer:** a listener rule, ahead of the authenticating rules, for the path `/api/v1/mcp` that forwards without the `authenticate-oidc` action. Narrow it with an `http-header` condition on `Authorization` with the value `Bearer bbu_*`, so only requests carrying a personal token skip the gate.
- **CloudFront:** a cache behavior for that path without the gate function, with caching disabled and every header forwarded.

The trade-off is plain: anyone who can reach the gate can reach the MCP endpoint, which is then protected by Breadboard's tokens alone. The server never accepts the gate's identity on this path, so the pass-through cannot hand out a trusted-proxy user. **Upgrade the server before opening the path:** servers older than personal tokens accept the trusted-proxy identity there.

### Enterprise or internal deployments: the gate stays closed

Where an organization's single sign-on at the edge is the security boundary, its policy usually requires every path to authenticate at the gate: a declared network-access intent, a security review, a perimeter scan that expects the sign-in redirect everywhere. Do not open a path. The harness carries two credentials instead:

- the **gate's session**, which proves the person to the edge, the same way their browser does;
- the **personal token**, which tells Breadboard which user and which scopes the connection acts with.

Claude Code takes both from a **headers helper**: a command it runs when it connects, and again before retrying once when the server rejects the credential. Its stdout must be a JSON object of header names to string values, and nothing else:

```json
{
  "mcpServers": {
    "breadboard": {
      "type": "http",
      "url": "https://<breadboard-host>/api/v1/mcp",
      "headersHelper": "/absolute/path/to/breadboard-mcp-headers"
    }
  }
}
```

```json
{ "Authorization": "Bearer bbu_…", "Cookie": "AWSELBAuthSessionCookie-0=…; AWSELBAuthSessionCookie-1=…" }
```

Register the server entry, without the `mcpServers` wrapper, at user scope (`claude mcp add-json breadboard '{"type":"http","url":"…","headersHelper":"…"}' --scope user`) and check with `claude mcp list`. The helper is deployment-specific and belongs with your deployment configuration, not in this repo. It should:

- **obtain the gate's session without a browser**, using the organization's single sign-on tooling to follow the gate's sign-in redirects. Start on a page path such as `/`: when API paths answer 401 instead of redirecting, the sign-in can only begin on a page. For an AWS Application Load Balancer, the session is the `AWSELBAuthSessionCookie-*` cookies, valid for the listener's session timeout. A request to `/api/v1/health` with only the cookie tells whether it is still valid;
- **cache the session** in a file only the user can read, and sign in again before it expires;
- **keep the personal token in the operating system's secret store**, never in the MCP configuration or a repository;
- **print the JSON only**, with every message on stderr, and never log a token or cookie value. Call the helper by absolute path, not through a package manager that prints its own banner to stdout.

### Operators with access to the host

Whoever can open a tunnel to the host can skip the edge: an IAM-authenticated SSM port forward to the server port (for the AWS reference deployment, see [deploy/aws/README.md](../deploy/aws/README.md)), then `http://localhost:<port>/api/v1/mcp` with the bearer header as in §2. It suits operators of the hosting account, not a team.

## 4. Other harnesses

Any MCP client that supports Streamable HTTP will work. Point it at the endpoint and send the bearer header with every request (and, behind a closed gate, the gate's session as in §3). A generic JSON configuration looks like this:

```json
{
  "mcpServers": {
    "breadboard": {
      "type": "http",
      "url": "https://<breadboard-host>/api/v1/mcp",
      "headers": { "Authorization": "Bearer bbu_…" }
    }
  }
}
```

## 5. What you get

**Inspection tools** (read-only; the core of a deep dive):

| Area | Tools |
|---|---|
| Instance | `whoami`, `get_breadboard_overview`, `list_users`, `list_recent_events` |
| Sessions | `list_sessions`, `get_session_summary`, `read_session_transcript`, `read_session_events`, `list_session_executions` |
| Content | `search_nodes`, `inspect_node`, `read_node`, `get_review_queue`, `find_similar_tasks` |
| Knowledge | `list_knowledge_domains`, `query_knowledge`, `read_note` |
| Repositories | `search_repo` (grep over a git repository the server mirrors; results cite the commit), `read_repo_file` (a file, line range or directory at that commit); the overview lists the mirrors under `repos` |
| Configuration | `search_config` (by slug, title, path or description; several words rank by how many match; pages with `offset`), `read_config` (by UID, slug or path; at main or at any `commit`), `get_config_history`, `diff_config`, `list_proposals`, `read_proposal`, `validate_config` |
| Evals | `list_eval_runs`, `read_eval_run`, `get_eval_analysis`, `get_rubric`, `get_fixture_output` |

**Working tools** (a full-access token): `create_task`, `create_artifact`, `update_artifact`, `add_comment`, `emit_edge`, `tag_need_input`, `resolve_need_input`, `propose_note_edit`, `create_note`, `run_circuit`, `start_eval_run`, `record_score`, `propose_config_change`. Tool code alone can call `run_tool`, `broker_fetch` and `model_converse`, so the MCP server never exposes them.

The server also lists **team tool extensions** that opt in with `exposure.external_mcp: true` in their manifest ([06](../specs/06-toolbox.md) §8). Each one is named by its slug. If a slug matches a primitive name, the tool is listed as `tool_<slug>` instead. These tools run in the same sandbox with the same limits as they do inside Breadboard, under your user permissions. A tool can write through its broker capabilities, so they need a full-access token (the `tools:execute` scope): a read-only connection neither lists nor calls them. The server re-reads the list on every `tools/list`, so a newly merged tool shows up when the client next lists tools.

**Resources.**
- `breadboard://nodes/{uid}` is the head of a content node (the same data `read_node` returns).
- `breadboard://config/{uid}` is a configuration definition at `main` (the same data `read_config` returns).

**Results, errors and size.** A successful call returns one text content block containing the result as JSON. A failed call returns `isError: true` with a JSON body `{code, message, detail?}`. The `code` values are the stable Breadboard error codes, for example `validation-failed`, `grant-denied`, `forbidden` (the token lacks the scope), `not-found`, `anchor-ambiguous`, and `base-revision-too-old`. Models can use them to correct themselves. For example, after `base-revision-too-old`, call `read_note` again and retry. Long values are clipped by default: a clipped value is an object with `truncated: true`, its `total_chars`, and the kept prefix. Every tool that can return long values takes `max_chars` (0 = no clipping), and `read_session_transcript` reads one turn in full with `turn_id`. Lists page with `cursor`, `offset` or `after_seq`.

## 6. Investigating a run

1. `get_breadboard_overview`: what is running, queued, gated or failing, spend this hour, open proposals, what is waiting on you.
2. `list_sessions {state: ["suspended-error"], kind: ["circuit-run"]}` (or by `circuit`, `task`, `created_by: "me"`, `created_after`) to find the session.
3. `get_session_summary`: the steps taken, their exits and attempts, cost, child sessions. For a designer or intake chat, also its proposals and last error.
4. `read_session_transcript {session_id, step: "summarize"}`: every turn with its tool calls and results; `read_session_events` for retries, gates and the resolved config commit; `list_session_executions` for what a sandboxed tool actually did, with its logs.
5. `read_config {ref: "lit-review", commit: <session.config_commit>}`: the circuit, subagent or tool exactly as it ran; `get_config_history` and `diff_config` for what changed since.
6. `inspect_node` on the artifacts it produced (`search_nodes {session_id}` finds its scratch), `read_node` for a body.
7. Fix the cause where it lives: the circuit, the subagent, the tool or the note. A full-access token can `propose_config_change`; a read-only one leaves that to the browser.

## 7. Logging and attribution

Each MCP connection is recorded as a Breadboard Session of `kind: conversation`. The session is opened by the connection's first tool call or resource read, so a client that only connects and lists tools (as harnesses do at startup) leaves none. It is marked completed when the client sends `DELETE` or the connection has been idle for 30 minutes; a tool call still running (a long Athena query, say) keeps it open however long it takes, and the idle clock restarts when the call returns. Each tool call adds `tool-call` and `tool-result` events to that session. Writes are attributed to **you**, through the `user` actor with the session id. Connections never write as a `service` actor. To review what a connection did, open the session in the Sessions view, or ask over MCP: `list_sessions {kind: ["conversation"], created_by: "me"}`.

An MCP session belongs to the user who opened it. A request that reuses the `mcp-session-id` with a different user's credentials is rejected with `403`.
