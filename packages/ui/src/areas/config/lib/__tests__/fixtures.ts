/** A valid-UID variant of the [03] §2 reference circuit, comments included. */
export const CIRCUIT_UID = '01J8C1RC0000000000AA';
export const SCOUT = '01J8SVBAG0000000SC00';
export const WRITER = '01J8SVBAG0000000WR00';
export const CHECK_TOOL = '01J8T00000000000CK00';
export const EMPTY_TOOL = '01J8T00000000000EM00';

export const LIT_REVIEW_YAML = `# config/circuits/${CIRCUIT_UID}/circuit.yaml
schema: breadboard/circuit@v1
uid: ${CIRCUIT_UID}        # permanent config UID
slug: lit-review                 # display metadata only
title: Literature review
description: Survey prior art for a research question and produce an annotated summary.
tags: [research]

budget:                      # per-run defaults
  max_cost_usd: 15
  max_tokens: 2000000

input:                       # typed input schema
  type: object
  required: [question]
  properties:
    question: { type: string }
    depth:    { type: string, enum: [quick, thorough], default: quick }

exits:
  - name: done
    output:
      type: object
      required: [summary_artifact]
      properties:
        summary_artifact: { $ref: "#/defs/artifact-ref" }
  - name: empty
    output:
      type: object
      properties:
        note: { type: string }

entry: gather                # step id where execution begins

steps:
  # The scout finds sources first.
  - id: gather
    kind: llm
    subagent: ${SCOUT}     # research-scout
    prompt: prompts/gather.md
    tools_override: []
    output:
      type: object
      required: [sources]
      properties:
        sources: { type: array, items: { $ref: "#/defs/artifact-ref" } }
    exits:
      - name: found-sources
        to: summarize
      - name: nothing-found
        to: report-empty
    retry: { max_attempts: 3, backoff: { base_s: 5, cap_s: 300 } }

  - id: summarize
    kind: llm
    subagent: ${WRITER}     # research-writer
    prompt: prompts/summarize.md
    output:
      type: object
      required: [summary_artifact]
      properties:
        summary_artifact: { $ref: "#/defs/artifact-ref" }
    exits:
      - name: done
        to: quality-check

  - id: quality-check
    kind: code
    tool: ${CHECK_TOOL}         # check-citations
    input_map:
      artifact: $steps.summarize.output.summary_artifact
    exits:
      - name: pass
        to: quality-gate
      - name: fail
        to: summarize                    # loop back

  - id: quality-gate
    kind: gate
    review:
      artifacts: [$steps.summarize.output.summary_artifact]
      reviewers: { role: scientist }
    output:
      type: object
      required: [summary_artifact]
      properties:
        summary_artifact: { $ref: "#/defs/artifact-ref" }
        feedback: { type: array, items: { type: string } }
    exits:
      - name: approve
        to: $exit.done
      - name: changes
        to: summarize

  - id: report-empty
    kind: code
    tool: ${EMPTY_TOOL}          # emit-empty-report
    exits:
      - name: done
        to: $exit.empty
`;
