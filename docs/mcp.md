# Connecting to the Breadboard MCP server

Every Breadboard runs a built-in MCP server ([11 — API & MCP](../specs/11-api-mcp.md) §4). From a local harness such as Claude Code you can inspect everything your Breadboard has done: sessions and their full transcripts, the orchestrator's event log, sandboxed tool executions, tasks and artifacts with their lineage, configuration at any commit with its history and proposals, knowledge notes, eval runs, and the instance's health. With a full-access token you can also work in it: create and triage Tasks, comment on Artifacts, edit Knowledge Notes, run circuits, propose configuration changes and call team tool extensions.

- **Endpoint:** `http(s)://<breadboard-host>/api/v1/mcp`
- **Transport:** MCP Streamable HTTP (`POST` / `GET` / `DELETE` on that one URL). There is no stdio transport; local harnesses connect over HTTP.
- **Auth:** `Authorization: Bearer <token>` with a **personal access token** (§1). Connections are user connections: a service token is refused, and so is the identity an authenticating proxy or load balancer adds to browser requests, because an MCP client has no browser cookies.

## 1. Get a token

Open **Account & tokens** from the user menu (top right; also `g` `u`, or the command palette) and create a personal access token.

- **Read-only** (the default) can read everything you can see and changes nothing. Use it for investigating.
- **Full access** acts exactly as you, including review verdicts and configuration merges. Create one only when Claude Code should do work in your Breadboard.
- Tokens expire (90 days by default, a year at most) and can be revoked on the same page, which takes effect at once. The secret (`bbu_…`) is shown once, together with the ready-to-paste command below.

A token can never mint another token, and admin-only pages stay behind your browser sign-in: a read-only token of an admin is a member.

## 2. Claude Code

```sh
claude mcp add --transport http breadboard https://<breadboard-host>/api/v1/mcp \
  --header "Authorization: Bearer bbu_…"
```

`claude mcp list` shows the connection. The tools appear as `mcp__breadboard__<name>`. The server also sends short instructions with the connection (ids, where to start, how to page and read clipped values), which Claude Code shows the model.

### Behind an authenticating edge

When the browser reaches your Breadboard through a sign-in gate (a CloudFront signed-cookie function, an Application Load Balancer that authenticates with OIDC), the gate has to let `/api/v1/mcp` through to the server without a browser sign-in; the server authenticates the bearer token itself. On a load balancer that is a listener rule for the path `/api/v1/mcp*` that forwards without the `authenticate-oidc` action; on CloudFront, a behavior for that path without the gate function. The server refuses edge identity on this path, so the pass-through can never hand out the trusted-proxy identity. Until such a rule exists, a tunnel to the host works (for the AWS reference deployment, `http://localhost:14000/api/v1/mcp` over SSM, see [status.md](status.md)).

## 3. Other harnesses

Any MCP client that supports Streamable HTTP will work. Point it at the endpoint and send the bearer header with every request. A generic JSON configuration looks like this:

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

## 4. What you get

**Inspection tools** (read-only; the core of a deep dive):

| Area | Tools |
|---|---|
| Instance | `whoami`, `get_breadboard_overview`, `list_users`, `list_recent_events` |
| Sessions | `list_sessions`, `get_session_summary`, `read_session_transcript`, `read_session_events`, `list_session_executions` |
| Content | `search_nodes`, `inspect_node`, `read_node`, `get_review_queue`, `find_similar_tasks` |
| Knowledge | `list_knowledge_domains`, `query_knowledge`, `read_note` |
| Configuration | `search_config`, `read_config` (by UID, slug or path; at main or at any `commit`), `get_config_history`, `diff_config`, `list_proposals`, `read_proposal`, `validate_config` |
| Evals | `list_eval_runs`, `read_eval_run`, `get_eval_analysis`, `get_rubric`, `get_fixture_output` |

**Working tools** (a full-access token): `create_task`, `create_artifact`, `update_artifact`, `add_comment`, `emit_edge`, `tag_need_input`, `resolve_need_input`, `propose_note_edit`, `run_circuit`, `record_score`, `propose_config_change`. Tool code alone can call `run_tool`, `broker_fetch` and `model_converse`, so the MCP server never exposes them.

The server also lists **team tool extensions** that opt in with `exposure.external_mcp: true` in their manifest ([06](../specs/06-toolbox.md) §8). Each one is named by its slug. If a slug matches a primitive name, the tool is listed as `tool_<slug>` instead. These tools run in the same sandbox with the same limits as they do inside Breadboard, under your user permissions. The server re-reads the list on every `tools/list`, so a newly merged tool shows up when the client next lists tools.

**Resources.**
- `breadboard://nodes/{uid}` is the head of a content node (the same data `read_node` returns).
- `breadboard://config/{uid}` is a configuration definition at `main` (the same data `read_config` returns).

**Results, errors and size.** A successful call returns one text content block containing the result as JSON. A failed call returns `isError: true` with a JSON body `{code, message, detail?}`. The `code` values are the stable Breadboard error codes, for example `validation-failed`, `grant-denied`, `forbidden` (the token lacks the scope), `not-found`, `anchor-ambiguous`, and `base-revision-too-old`. Models can use them to correct themselves. For example, after `base-revision-too-old`, call `read_note` again and retry. Long values are clipped by default: a clipped value is an object with `truncated: true`, its `total_chars`, and the kept prefix. Every tool that can return long values takes `max_chars` (0 = no clipping), and `read_session_transcript` reads one turn in full with `turn_id`. Lists page with `cursor`, `offset` or `after_seq`.

## 5. Investigating a run

1. `get_breadboard_overview`: what is running, queued, gated or failing, spend this hour, open proposals, what is waiting on you.
2. `list_sessions {state: ["suspended-error"], kind: ["circuit-run"]}` (or by `circuit`, `task`, `created_by: "me"`, `created_after`) to find the session.
3. `get_session_summary`: the steps taken, their exits and attempts, cost, child sessions. For a designer or intake chat, also its proposals and last error.
4. `read_session_transcript {session_id, step: "summarize"}`: every turn with its tool calls and results; `read_session_events` for retries, gates and the resolved config commit; `list_session_executions` for what a sandboxed tool actually did, with its logs.
5. `read_config {ref: "lit-review", commit: <session.config_commit>}`: the circuit, subagent or tool exactly as it ran; `get_config_history` and `diff_config` for what changed since.
6. `inspect_node` on the artifacts it produced (`search_nodes {session_id}` finds its scratch), `read_node` for a body.
7. Fix the cause where it lives: the circuit, the subagent, the tool or the note. A full-access token can `propose_config_change`; a read-only one leaves that to the browser.

## 6. Logging and attribution

Each MCP connection is recorded as a Breadboard Session of `kind: conversation`. The session is created when the client initializes and is marked completed when the client sends `DELETE` or the connection has been idle for 30 minutes. Each tool call adds `tool-call` and `tool-result` events to that session. Writes are attributed to **you**, through the `user` actor with the session id. Connections never write as a `service` actor. To review what a connection did, open the session in the Sessions view, or ask over MCP: `list_sessions {kind: ["conversation"], created_by: "me"}`.

An MCP session belongs to the user who opened it. A request that reuses the `mcp-session-id` with a different user's credentials is rejected with `403`.
