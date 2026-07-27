# 05 — Subagents

**Status:** Draft v1
**Depends on:** [00 — Overview](00-overview.md), [01 — Data Model](01-data-model.md)
**Related:** [03 — Circuits](03-circuits.md) (LLM steps run Subagents), [06 — Toolbox](06-toolbox.md), [07 — Knowledge](07-knowledge.md)

---

## 1. Purpose & principles

Each **Subagent** is a configuration — custom system prompt, access configurations (Circuits, Knowledge, Toolbox tools), and a model preset — built up by the owning team to be a **narrowly-scoped expert** in its domain.

- **Narrow scope is the point.** As with human workflows, different frameworks apply at different stages of a process; Subagents are where teams encode those mindset shifts into the infrastructure. Keeping toolsets and knowledge access minimal keeps each Subagent focused on exactly its work (an agent conducting literature review doesn't also need to query the data lake).
- **Configuration, not code.** A Subagent is one YAML file in the configuration plane — versioned, diffable, propose-review-commit for AI edits ([01](01-data-model.md) §6.2).
- **Fixing the Subagent fixes the future.** When the AI misbehaves in a way traceable to expertise/mindset rather than flow, correct the Subagent definition rather than nudging in-session ([00 — Overview](00-overview.md) §1.1).

## 2. Subagent configuration schema

One file per Subagent: `config/subagents/<slug>.yaml`.

```yaml
schema: breadboard/subagent@v1
uid: 01J8SUBAG0RSRCHSCOUT0               # permanent config UID ([01] §6.2)
slug: research-scout                     # display/file-layout only
title: Research scout
description: Finds and qualifies prior art for a research question.

system_prompt: |
  You are a research scout. Your job is to find relevant prior work...
  ## Team glossary
  {{knowledge:01J8FQ2ZK7XW9MBT4PVN}}    # dynamic live Knowledge Note injection

model_preset: medium                     # tier name; resolved via config/presets/models.yaml

tools:                                   # Toolbox access (default: none — explicit allow)
  - tool: 01J8TOOL0SCHOLARLY00           # tool extension UID (search-scholarly)
  - tool: 01J8TOOL0QRYKNOWLEDGE          # query_knowledge
    settings:                            # per-tool overrides / hidden restrictions
      domains: [glossary, prior-art]     # narrower than the tool's full capability
  - mcp: 01J8MCP00INTSEARCH00            # onboarded MCP server UID (internal-search)
    allow: [search, read_document]       # tool allowlist within the server

circuits:                                # circuit visibility (default: none)
  - circuit: 01J8CIRCUIT0CITECHK00       # cite-check
    access: execute                      # read | execute
  - circuit: 01J8CIRCUIT0LITREV00        # lit-review
    access: read                         # may inspect the definition, not invoke

knowledge:                               # Knowledge Domain access (default: none)
  read: [glossary, prior-art]
  write: []                              # domains this subagent may edit via the reconcile path
```

### 2.1 System prompt

Markdown, shaping the expertise and mindset. Supports **dynamic references to Knowledge Notes**: `{{knowledge:<UID>}}` loads the **live contents** of that Note at Subagent execution start — so content actively maintained in the team knowledge base is never duplicated into prompts. Rules:

- Resolution happens once per step start (not per turn); the Session records the Note revision that was resolved, preserving provenance.
- The referenced Note must be in a Domain the Subagent can read; otherwise config validation fails at commit time.

### 2.2 Toolbox access

Explicit allowlist of tool extensions and MCP servers ([06 — Toolbox](06-toolbox.md)). Within each grant, teams can customize **default or hidden settings** to narrow allowed behavior — e.g., a generic `query_knowledge` tool granted with `domains: [glossary]` for one Subagent and unrestricted for another. Settings declared `hidden` in the tool manifest are enforced server-side and invisible to the model.

### 2.3 Circuit access

Controls which circuits the Subagent can **read** (inspect definitions) or **execute** (invoke as a sub-session via the `run_circuit` toolbox primitive). This shapes potential sub-paths the Subagent may send its work, and operates **independently of the circuit orchestration layer** — a circuit's own flow (Step A passes results to Circuit B) needs no grant; grants govern the Subagent's *discretionary* invocations.

### 2.4 Knowledge access

Read/write lists of Knowledge Domain slugs ([07 — Knowledge](07-knowledge.md) §3). Read scopes search/RAG and deterministic injection; write gates the AI-edit path.

## 3. Execution semantics

When a circuit LLM step (or an Intake conversation, or a designer chat panel) runs a Subagent:

1. Resolve the Subagent config at the Session's config commit.
2. Assemble the system prompt: **system tenets (§5) + Subagent system prompt with `{{knowledge:…}}` resolved + step context**.
3. Resolve `model_preset` → concrete model ID via the preset's ordered fallback list (§4); record the resolved ID on every turn.
4. Materialize the tool surface: granted tool extensions + granted MCP tools, with per-grant settings applied; step-level `tools_override` may narrow further ([03](03-circuits.md) §3.1).
5. Run the conversation through the model gateway with the standard tool loop.

## 4. Model presets

Presets abstract above specific LLM identifiers (e.g., Bedrock model IDs). Maintained at the **Breadboard level** for consistency across the team: `config/presets/models.yaml`.

```yaml
schema: breadboard/presets@v1
presets:
  small:
    - { provider: bedrock, model_id: anthropic.claude-haiku-4-5 }
    - { provider: bedrock, model_id: amazon.nova-lite-v2 }
  medium:
    - { provider: bedrock, model_id: anthropic.claude-sonnet-5 }
    - { provider: bedrock, model_id: anthropic.claude-haiku-4-5 }
  large:
    - { provider: bedrock, model_id: anthropic.claude-opus-5, requires: [structured-output, tool-use] }
    - { provider: openai,  model_id: gpt-5.5 }      # cross-provider fallback
```

Preset entries may declare `requires: [<capability>...]` (e.g., `structured-output`, `tool-use`); during fallback the gateway **skips entries that don't satisfy the step's required capabilities** rather than failing mid-conversation.

Purpose is two-fold: **(1) simplicity** — Subagent authors pick a tier, not a model ID; **(2) robustness** — each preset is an **ordered fallback list**, so if the preferred model is unavailable (deprecated, throttled, region outage) the gateway falls back automatically to the next entry (e.g., if `opus-4-6` were the primary `large` and deprecated before the definition was updated, calls fall back to the next configured option). Fallback events are logged on the Session turn and surfaced as a Breadboard health warning.

Tier names are team-defined (any set of names is valid); `small`/`medium`/`large` ship as defaults. Preset changes are config commits — eval regression runs are recommended on preset changes ([04](04-evals.md) §6).

## 5. System tenets

Breadboard supports instilling **principles/values/tenets that all Subagents across the system follow** — analogous to Rules in common AI harnesses, but applied across the full system.

- Stored at `config/tenets.md`; injected at the top of every Subagent's system prompt (every LLM step, every conversation).
- **Strictly size-limited** (default cap: 2,000 characters, configurable downward) because tenets are so pervasively applied — the cap is enforced at commit time. Tenets should be values ("prefer citing primary sources"; "never fabricate data"), never operational detail.
- Changes to tenets are the highest-blast-radius config change in the system; the editor UI flags this and recommends an eval sweep.

## 6. AI-proposed Subagent edits

Like all configuration, Subagents can be edited by AI (e.g., a meta-operating subagent proposing a system-prompt refinement after observing repeated failures) via **propose-review-commit**: branch + reviewable diff + human merge ([01](01-data-model.md) §6.2). The Subagent editor's designer chat is the primary surface for this (§7).

## 7. UI

- **Subagents inventory:** searchable list of all Subagents (slug, title, model preset, tool count, last modified). Primarily a means of finding a Subagent and opening the editor.
- **Subagent editor:** per-Subagent view showing the configuration components (system prompt, tools, circuits, knowledge, preset). Users click into any item to jump into the relevant editor (e.g., a granted tool → Tool editor; an injected Knowledge Note → Note editor).
  - **Designer chat panel** — always visible: conversations with Subagent-designer Subagents equipped with built-in Subagent-editing tools, following the shared propose-review-commit pattern ([10 — UI](10-ui.md) §4) so users can evolve configurations without hand-editing YAML.
  - Validation inline: unknown tool UIDs, unreadable knowledge refs, preset typos surface as commit-blocking errors.

## 8. v1 cutline

**In:** the `subagent@v1` schema; dynamic Knowledge Note injection; per-grant tool settings (incl. hidden enforcement); read/execute circuit grants; team-level presets with ordered fallback; tenets with size cap; inventory + editor with designer chat.

**Out (future):** per-Subagent temperature/sampling profiles (v1: gateway defaults); Subagent inheritance/composition ("extends"); auto-tuning prompts from eval results; per-Subagent budget multipliers.

## 9. Resolved questions

*(Decided 2026-07-28; formerly open.)*

1. **Tenet injection position.** **Decided:** top of the system prompt (most authoritative); revisit with evidence.
2. **Preset capability mismatch on fallback.** **Decided:** preset entries may declare `requires: [structured-output, tool-use]` and the gateway skips non-conforming entries rather than failing mid-conversation (§4).
