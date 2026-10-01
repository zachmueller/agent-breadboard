Check whether this claim contradicts the team's Knowledge Notes.

**Claim:**
{{input.claim}}

{{#if input.domains}}Only check these Knowledge Domains:{{#each input.domains}} `{{this}}`{{/each}}.{{else}}Check every domain you can read.{{/if}}

Identify each factual assertion, search for and read the relevant Notes, and classify each assertion as
contradicted, supported, or unaddressed. Return exit `contradiction` with one `conflicts` entry per contradiction,
each carrying a verbatim quote from the Note; otherwise return `consistent` with `conflicts: []`. Always include a
short `summary`.
