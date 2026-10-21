# Configuration reference (`breadboard/*@v1`)

The configuration plane is a git repository the server manages. Paths are a pure function of UID ([01] §6.1); `slug`/`title` are display metadata. The server validates every commit against these schemas (`packages/shared/src/config/*.ts` are the executable definitions).

```
INDEX.md                    auto-generated listing (informational)
breadboard.yaml             instance settings
tenets.md                   system-wide tenets (≤ 2,000 chars, cap configurable downward)
presets/models.yaml         model presets
subagents/<uid>.yaml
circuits/<uid>/circuit.yaml, prompts/<step>.md, rubric.yaml, fixtures.yaml
tools/<uid>/tool.yaml, src/…
mcp/<uid>.yaml
```

UIDs are 20 characters of Crockford base32 (digits and uppercase letters except I, L, O, U). File names must match the `uid:` field; duplicate UIDs or slugs are rejected.

## breadboard.yaml (`breadboard/breadboard@v1`)

| Key | Meaning | Default |
|---|---|---|
| `team.name` | display name | `Breadboard` |
| `capacity.max_concurrent_runs` | running sessions admitted at once | 4 |
| `capacity.max_spend_usd_per_hour` | rolling-window spend ceiling | 25 |
| `capacity.dispatch_interval_ms` | dispatcher tick | 2000 |
| `defaults.scope` | default node scope | `team` |
| `defaults.budget.{max_cost_usd,max_tokens}` | session budget when a circuit has none | 5 / 1,000,000 |
| `defaults.retry` | step retry policy | 3 attempts, 5 s base, 300 s cap |
| `defaults.max_visits` | loop guard per step | 25 |
| `defaults.max_tool_cost_units` | per-run tool cost ceiling | 100 |
| `intake.triage_circuit` | top-level triage circuit UID | — |
| `intake.shaper_subagent` | intake-shaper subagent UID | — |
| `intake.draft_retention_days` | abandoned drafts auto-archive | 30 |
| `designers.{circuit,tool,subagent}` | designer-chat subagent UIDs | — |
| `knowledge.domains[]` | `{slug, description}` — grants validate against this list | `[]` |
| `knowledge.base_revision_retention_hours` | read_note bases stay retrievable | 24 |
| `knowledge.compaction_update_threshold` | updates before a compaction snapshot | 500 |
| `knowledge.wipeout_fraction` | wipeout guard threshold | 0.9 |
| `knowledge_injection[]` | `{domain, trigger:{kind: reference-match, pattern}, inject:{notes_tagged}, max_notes}` | `[]` |
| `tenets.max_chars` | tenets size cap (≤ 2000) | 2000 |
| `auth.mode` | `local` or `oidc` | `local` |
| `auth.local_users[]` | `{handle, display_name, token, admin, roles}` — real `users` rows | `[]` |
| `auth.oidc` | `{issuer, client_id, client_secret_env, redirect_uri, scopes, groups_claim, group_mappings:{admin:[groups], roles:{slug:[groups]}}}` | — |
| `webhooks[]` | `{url, secret_env, topics}` HMAC-signed server-to-server deliveries | `[]` |
| `sandbox.nesting_depth_cap` | runTool/runCircuit nesting | 8 |
| `sandbox.images.{typescript,python}` | sandbox images | `breadboard-sandbox-*:local` |
| `connectors[]` | `{tool, schedule_minutes, domains, settings, enabled}` | `[]` |
| `repos[]` | git repositories the server mirrors for `search_repo` / `read_repo_file` ([06] §7.1): `{name, description, url, branch, capability, refresh_minutes, max_file_bytes, max_notebook_bytes, exclude, fetch_timeout_s, enabled}`. `name` is the slug subagents grant; `url` is https (credentials never in the URL); `capability` names the broker capability that authenticates the fetch (omit for a public repo); a call fetches first when the last fetch is `refresh_minutes` old; `exclude` globs are never searched | `[]` (each: branch `main`, refresh 5 min, file cap 1 MiB, notebook cap 50 MiB, fetch timeout 600 s) |

## presets/models.yaml (`breadboard/presets@v1`)

```yaml
schema: breadboard/presets@v1
presets:
  small:  [{ provider: bedrock, model_id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, { provider: bedrock, model_id: "us.amazon.nova-2-lite-v1:0" }]
  medium: [{ provider: bedrock, model_id: us.anthropic.claude-sonnet-5 }, { provider: bedrock, model_id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }]
  large:  [{ provider: bedrock, model_id: us.anthropic.claude-opus-5, requires: [structured-output, tool-use] }, { provider: bedrock, model_id: us.anthropic.claude-sonnet-5 }]
embeddings: { provider: bedrock, model_id: "amazon.titan-embed-text-v2:0" }
```

Use the exact Bedrock ids: Claude and Nova 2 models are invocable only through an inference profile (`us.…`, `eu.…`, `apac.…`, `global.…`), while Titan embeddings take the bare model id. `aws bedrock list-inference-profiles` lists what an account can call.

Each entry: `provider` (must have an installed adapter — v1 ships `bedrock`, plus `mock` for dev), `model_id`, optional `requires` (capabilities the entry must satisfy or be skipped during fallback), optional `pricing {input_per_m, output_per_m}` override.

## subagents/<uid>.yaml (`breadboard/subagent@v1`)

`uid`, `slug`, `title`, `description`, `system_prompt` (Markdown; `{{knowledge:<UID>}}` injects a live Note at step start), `model_preset`, `tools[]` (`{tool: <uid>, settings?}` or `{mcp: <uid>, allow?: [names]}`), `circuits[]` (`{circuit: <uid>, access: read|execute}`), `knowledge {read: [domains], write: [domains]}`, `repos[]` (names from `breadboard.yaml` `repos[]` the subagent may search and read; a non-empty list adds `search_repo` and `read_repo_file` even to an explicit `primitives` list), optional `primitives[]` (built-in primitive allowlist; default is the content + knowledge-read set, with `propose_note_edit`/`run_circuit` added when the matching grants exist).

## circuits/<uid>/circuit.yaml (`breadboard/circuit@v1`)

Top level: `uid`, `slug`, `title`, `description`, `tags`, `budget {max_cost_usd, max_tokens}`, `input` (JSON Schema), `exits[]` (`{name, description?, output?: JSON Schema}` — the public interface), `entry`, `steps[]`, optional `knowledge {read: [domains]}`, optional `max_tool_cost_units`.

Steps share `id`, `exits[] {name, to}` (`to` = step id or `$exit.<name>`), `retry`, `max_visits`, `artifacts {tag: intermediate|deliverable, scope}` and then by `kind`:

- `llm`: `subagent` (UID), `prompt` (path under the circuit dir) or `prompt_inline`, `tools_override` (narrowing; `[]` = no tools), `output` (JSON Schema — the finish tool's payload), `max_reasks` (2), `max_turns` (60).
- `code`: `tool` (UID), `input_map` (values `$input.x`, `$steps.<id>.output.x`, `$ambient.x`, or literals), `output?`, `settings?`.
- `circuit`: `circuit` (UID), `input_map`, `exit_map?` (child exit → step exit; default identity). Step exits must map 1:1 onto the child's declared exits.
- `gate`: `review {artifacts: [expressions], reviewers: {role?, username?, any_of?}, prompt?}`, `output` (reviewer `edits` validate against it), exits must include `approve` and `changes`.

Templates use a Handlebars subset: `{{path}}`, `{{json path}}`, `{{#if}}…{{else}}…{{/if}}`, `{{#each}}…{{/each}}` over `input`, `steps.<id>.output` (latest completed visit), `ambient.{task,session_id,budget,artifacts}`. `#/defs/artifact-ref` (`{uid, revision_id}`) is available in every schema.

Validation on commit: closed exit graph, reachability, entry exists, gates have both exits, dangling UIDs, prompt files exist, schemas compile, sub-circuit interfaces match.

## circuits/<uid>/rubric.yaml (`breadboard/rubric@v1`) and fixtures.yaml (`breadboard/fixtures@v1`)

Rubric: `circuit` (UID), `judge {subagent, model_id (explicit, never a tier), provider}`, `dimensions[]` of type `numeric {scale}` | `ordinal {levels}` | `boolean` | `programmatic {tool, settings}` (built-ins: `assert-output-schema`, `assert-exit`, `assert-citations-exist`), `aggregate {method, weights, ordinal_map?, gate {min}}`, `required_for_merge`.

Fixtures: `circuit`, `fixtures[] {fixture_id, title, source_session_id?, input, pinned_context?, tags, notes, retired}`.

## tools/<uid>/tool.yaml (`breadboard/tool@v1`)

`uid`, `slug`, `title`, `description`, `language` (typescript|python), `entrypoint`, `input`/`output` schemas, `settings {name: {type, default, hidden, description}}` (hidden settings are enforced server-side and never shown to the model), `limits {timeout_s, memory_mb, cpus, pids, max_cost_units}`, `egress {allow: [{host, ports}]}` (default-deny), `capabilities [{name, scope}]` (broker), `exposure {external_mcp}`, optional `connector {schedule_minutes, domains}`, `builtin`.

## mcp/<uid>.yaml (`breadboard/mcp@v1`)

`uid`, `slug`, `title`, `transport` (stdio|http|sse), `command`/`args`/`env` or `endpoint`, `auth {capability, apply}`, `tools {allow}`.
