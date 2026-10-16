-- Prompt-cache token counts ([02] §6, [12] §7). `tokens_in` stays the uncached input; cache reads and writes are
-- separate because they are priced differently. Token budgets count all four.
ALTER TABLE session_turns ADD COLUMN tokens_cache_read bigint, ADD COLUMN tokens_cache_write bigint;
ALTER TABLE step_checkpoints ADD COLUMN tokens_cache_read bigint NOT NULL DEFAULT 0, ADD COLUMN tokens_cache_write bigint NOT NULL DEFAULT 0;
