Ground this idea in the real codebase.

**Idea:** {{input.title}}

{{#if input.body}}{{input.body}}{{/if}}

{{#if steps.repo-search.output.available}}
**Initial code-search results** for "{{steps.repo-search.output.query}}":
{{#each steps.repo-search.output.results}}
- {{this.repo}}: `{{this.path}}` ({{this.url}})
{{/each}}
{{else}}
Code search is unavailable{{#if steps.repo-search.output.note}} ({{steps.repo-search.output.note}}){{/if}}. Work from
the codebase knowledge domain, and use the harness only if it is essential.
{{/if}}

Refine with further `repo-search` queries as needed, then write the grounding report with `create_artifact` and
return it as `grounding_artifact` together with a three-sentence `summary`.
