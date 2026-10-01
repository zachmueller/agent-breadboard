A Task is being proposed. Decide which of the similar existing Tasks below are true duplicates or substantially
overlapping.

**Proposed title:** {{input.title}}

**Proposed body:**
{{#if input.body}}{{input.body}}{{else}}(no body yet){{/if}}

**Similarity candidates** (highest score first; read any candidate's full body with `read_node`):
{{#each steps.find-similar.output.candidates}}
- [[{{this.uid}}|{{this.title}}]] (status: {{this.status}}, similarity {{this.score}})
{{/each}}

Return exit `duplicates-found` with only the duplicate or overlapping candidates in `duplicates`, or `none` with an
empty list. Always include a short `summary`.
