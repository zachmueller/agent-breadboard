-- ctx.log entries of each tool execution ([06] §4), so the code-step drawer can show them; previously they lived
-- only in the code step's tool-result event, and executions from LLM steps kept none.
ALTER TABLE tool_executions ADD COLUMN logs jsonb;
