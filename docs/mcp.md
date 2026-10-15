# Connecting to the Breadboard MCP server

Every Breadboard runs a built-in MCP server ([11 — API & MCP](../specs/11-api-mcp.md) §4). You can use it to work with your team's Breadboard from a local harness such as Claude Code: create and triage Tasks, read and comment on Artifacts, search and edit Knowledge Notes, run circuits, and call team tool extensions.

- **Endpoint:** `http(s)://<breadboard-host>/api/v1/mcp`
- **Transport:** MCP Streamable HTTP (`POST` / `GET` / `DELETE` on that one URL). There is no stdio transport; local harnesses connect over HTTP.
- **Auth:** `Authorization: Bearer <token>`, using your user session token. External connections must be made as a user. If the server sees a service token, that token needs the `mcp:call` scope.

## Claude Code

```sh
claude mcp add --transport http breadboard http://localhost:4000/api/v1/mcp \
  --header "Authorization: Bearer <token>"
```

Use `claude mcp list` to check the connection. The tools appear as `mcp__breadboard__<name>`.

## Other harnesses

Any MCP client that supports Streamable HTTP will work. Point it at the endpoint and send the bearer header with every request. A generic JSON configuration looks like this:

```json
{
  "mcpServers": {
    "breadboard": {
      "type": "http",
      "url": "http://localhost:4000/api/v1/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## What you get

**Tools.** You get the Breadboard primitives that your principal is allowed to call:

| Area | Tools |
|---|---|
| Intake | `create_task`, `find_similar_tasks` |
| Content | `create_artifact`, `update_artifact`, `read_node`, `add_comment`, `emit_edge`, `tag_need_input`, `resolve_need_input` |
| Knowledge | `query_knowledge`, `read_note`, `propose_note_edit` |
| Sessions | `run_circuit`, `get_session_summary` |
| Evals | `record_score`, `get_rubric`, `get_fixture_output` |
| Config | `read_config` (by UID, slug, or path), `search_config`, `validate_config`, `propose_config_change` |

Tool code alone can call `run_tool` and `broker_fetch`, so the MCP server never exposes them.

The server also lists **team tool extensions** that opt in with `exposure.external_mcp: true` in their manifest ([06](../specs/06-toolbox.md) §8). Each one is named by its slug. If a slug matches a primitive name, the tool is listed as `tool_<slug>` instead. These tools run in the same sandbox with the same limits as they do inside Breadboard, under your user permissions. The server re-reads the list on every `tools/list`, so a newly merged tool shows up when the client next lists tools.

**Resources.**
- `breadboard://nodes/{uid}` is the head of a content node (the same data `read_node` returns).
- `breadboard://config/{uid}` is a configuration definition at `main` (the same data `read_config` returns).

**Results and errors.** A successful call returns one text content block containing the result as JSON. A failed call returns `isError: true` with a JSON body `{code, message, detail?}`. The `code` values are the stable Breadboard error codes, for example `validation-failed`, `grant-denied`, `not-found`, `anchor-ambiguous`, and `base-revision-too-old`. Models can use them to correct themselves. For example, after `base-revision-too-old`, call `read_note` again and retry.

## Logging and attribution

Each MCP connection is recorded as a Breadboard Session of `kind: conversation`. The session is created when the client initializes and is marked completed when the client sends `DELETE` or the connection has been idle for 30 minutes. Each tool call adds `tool-call` and `tool-result` events to that session. Writes are attributed to **you**, through the `user` actor with the session id. Connections never write as a `service` actor. To review what a connection did, open the session in the Sessions view.

An MCP session belongs to the user who opened it. A request that reuses the `mcp-session-id` with a different user's credentials is rejected with `403`.
