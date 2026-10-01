Classify this Task into exactly one route: `research`, `engineering`, `knowledge-maintenance`, or `unknown`.

**Title:** {{input.title}}
{{#if input.priority}}**Priority:** {{input.priority}}{{/if}}

**Body:**
{{#if input.body}}{{input.body}}{{else}}(no body){{/if}}

Return your exit, a short `rationale` that quotes the deciding phrase, and a `confidence` from 0 to 1. Choose
`unknown` if your confidence is below 0.6.
