Find and qualify prior work for this research question.

**Question:** {{input.question}}

**Depth:** {{#if input.depth}}{{input.depth}}{{else}}quick{{/if}}

{{#if ambient.task}}This review was requested by Task [[{{ambient.task.uid}}]]. Read it with `read_node` if you need
more context than the question gives.{{/if}}

Search the team knowledge base first, then the scholarly literature (`search-scholarly`). Qualify every candidate
for relevance and primary-source status. Return the qualified source refs, most important first, with exit
`found-sources`; put the search angles you tried in `notes`. Choose `nothing-found` (with `sources: []` and `notes`
explaining what you tried) only if nothing relevant exists.
