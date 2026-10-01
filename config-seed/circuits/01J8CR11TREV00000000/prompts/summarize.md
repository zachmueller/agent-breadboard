Write (or revise) the annotated literature summary for this research question.

**Question:** {{input.question}}

**Sources** (read each one with `read_node`; cite them as [[UID|title]]):
{{#each steps.gather.output.sources}}
- {{this.uid}} (revision {{this.revision_id}})
{{/each}}
{{#if steps.gather.output.notes}}

**Scout's notes:** {{steps.gather.output.notes}}
{{/if}}
{{#if steps.summarize.output.summary_artifact}}

This is a revision. Your previous summary is {{steps.summarize.output.summary_artifact.uid}}. Read it with
`read_node`, then update it with `update_artifact` rather than starting over.
{{/if}}
{{#if steps.quality-check.output}}
{{#if steps.quality-check.output.missing}}

**The citation check failed.** These cited UIDs do not resolve to a readable node. Remove them, or replace them
with sources from the list above:
{{#each steps.quality-check.output.missing}}
- {{this}}
{{/each}}
{{/if}}
{{/if}}
{{#if steps.quality-gate.output.feedback}}

**Reviewer feedback from the scientist gate.** Address every point:
{{#each steps.quality-gate.output.feedback}}
- {{this}}
{{/each}}
{{/if}}

Return the revision-pinned ref of the summary as `summary_artifact`.
