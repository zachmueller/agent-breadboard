Write an implementation plan for this engineering Task.

**Title:** {{input.title}}

**Body:**
{{#if input.body}}{{input.body}}{{else}}(no body; derive scope from the title and linked context){{/if}}

{{#if ambient.task}}The originating Task is [[{{ambient.task.uid}}]]. Read it with `read_node` for links, comments, and
acceptance criteria that may not be in the body.{{/if}}

Use `repo-search` and the knowledge base to ground the plan in the real code. The plan is executed by a coding
harness in a sandbox, with no human in the loop until review, so be concrete about files, steps, and tests. Return
the plan's revision-pinned ref as `plan_artifact` with exit `planned`.
