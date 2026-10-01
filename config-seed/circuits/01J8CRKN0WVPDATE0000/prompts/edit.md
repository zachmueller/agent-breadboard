Carry out this knowledge-maintenance request.

**Request:** {{input.title}}

{{#if input.request}}{{input.request}}{{/if}}

{{#if ambient.task}}The request comes from Task [[{{ambient.task.uid}}]]; read it with `read_node` for comments and links.{{/if}}

Find the affected Notes, read each one in full, and propose minimal edits with `propose_note_edit`. Finish with
`edited` (with a `summary` and the `edited_notes` refs) or `no-change` (with a `summary` explaining why nothing changed).
