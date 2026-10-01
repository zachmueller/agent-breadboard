# Configuration seed

This directory holds the configuration plane a fresh Breadboard starts with ([01] §6.1). On first boot, when the
config git repo has no commits or an empty `main`, the server copies this tree in as the initial commit
(`CONFIG_SEED_DIR`, default `./config-seed`; also `npm run seed -w @breadboard/server`). After that, the config repo
is the source of truth. Edits go through the editors or propose-review-commit, never back into this directory.

`INDEX.md` lists every definition by slug, title, UID, and path, in the same format the server regenerates on each
commit to `main`.

## Layout

| Path | What |
|---|---|
| `breadboard.yaml` | Instance settings: capacity and budgets, defaults, the intake triage circuit and shaper, designer subagents, knowledge domains, the `table:` injection rule, auth (**dev-only local tokens**), webhooks, sandbox, and connectors |
| `tenets.md` | System-wide tenets injected into every subagent (kept under 1500 chars) |
| `presets/models.yaml` | `small` / `medium` / `large` Bedrock fallback lists, plus embeddings |
| `subagents/<UID>.yaml` | 13 subagents: shaping, triage, research, knowledge, eval judge, three designers, code grounding, planning, and dedup |
| `circuits/<UID>/` | `circuit.yaml`, `prompts/<step-id>.md`, and optionally `rubric.yaml` and `fixtures.yaml` |
| `tools/<UID>/` | `tool.yaml` plus `src/`: 12 built-in tool extensions (9 TypeScript, 3 Python) |
| `mcp/<UID>.yaml` | An example MCP onboarding (filesystem). No subagent references it. |

Paths are UID-derived, and all cross-references are by UID. Slugs are display metadata.

## What ships

- **Intake and triage.** `triage` is the top-level triage circuit. It classifies each Task as `research`,
  `engineering`, or `knowledge-maintenance` and hands it to `lit-review`, `code-task`, or `knowledge-update`.
  Anything else goes to `request-direction`, which files a need-input request. The `intake-shaper` runs Intake
  conversations and can call three helper circuits: `dedup-check`, `contradiction-check`, and `grounded-in-code`.
- **`lit-review`** is the reference circuit from [03] §2, wired to real UIDs: gather, then summarize, then
  check-citations (looping back to summarize on failure), then a scientist gate. A no-sources path goes to
  `emit-empty-report`. It ships with a rubric (LLM-judged plus programmatic `assert-*` dimensions) and one smoke
  fixture.
- **`code-task`** runs plan, then `spawn-harness`, then a review gate. The harness is a Strands Agents adapter
  running in the Python sandbox; it needs `strands-agents` in the sandbox image and Bedrock access via the
  `bedrock-invoke` capability.
- **Designers.** `circuit-designer`, `tool-designer`, and `subagent-designer` back the editors' chat panels. They
  can only `validate_config` and `propose_config_change`; a human merges.
- **External-facing tools.** `echo` and `check-citations` are exposed on the external MCP surface.
  `search-scholarly` (Crossref and Semantic Scholar) and `repo-search` (GitHub) degrade gracefully when their
  broker capability is not configured.
- **`git-markdown-connector`** is shipped but disabled. Enable it under `connectors:` in `breadboard.yaml` and add
  the repo host to its egress allowlist.

## Before production

1. Replace `auth.mode: local` and its dev tokens with OIDC ([12] §2). The local tokens in `breadboard.yaml` are
   public and for development only.
2. Configure broker credentials for the capabilities you want: `crossref-api`, `semantic-scholar-api`,
   `github-api`, and `bedrock-invoke`.
3. Check that the model IDs in `presets/models.yaml` are enabled in your Bedrock account and region.
4. Rename the `scientist` review role, or add roles that match your team. Gates and need-input requests target it.

## Validating

```sh
npm run build -w @breadboard/shared          # validate.mjs imports the built shared package
node config-seed/validate.mjs                # exit 1 on any error
node config-seed/validate.mjs --write-index  # regenerate INDEX.md after adding or renaming definitions
```

The validator runs the server's zod schemas, then these checks:

- **UIDs and references:** UID/path agreement, unique UIDs and slugs, and every UID reference resolves to the right
  kind.
- **Grants:** declared knowledge domains, known primitive names, existing model presets, and `tools_override`
  within the subagent's grants.
- **Circuit graph:** entry, closed exits, every circuit exit routed, reachability, gates having both `approve` and
  `changes`, sub-circuit exits mapping 1:1 to the child's exits, required child and tool inputs wired, and no
  sub-circuit cycles.
- **Templates:** they compile, and every `input` / `steps` / `ambient` reference resolves.
- **Schemas and settings:** JSON Schemas compile, tool settings keys and types are valid, and fixture inputs
  validate against the circuit input.
- **Seed policy:** budgets, exit output schemas, `builtin: true`, external-MCP exposure only on `echo` and
  `check-citations`, no knowledge tokens, no MCP references, 10-40 line system prompts, and tenets length.
- **Sources:** `node --check` and `python3 -m py_compile` on tool sources, plus a current `INDEX.md`.

`README.md` and `validate.mjs` are tooling. If they are copied into the config repo, the server ignores them and
warns that they are outside the configuration layout.
