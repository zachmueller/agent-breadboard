/**
 * `npm run seed -w @breadboard/server` — create the config repo (if missing) and seed it from CONFIG_SEED_DIR
 * when it has no content yet. Idempotent; safe to run on every boot.
 */
import { loadEnv } from '../core/env.js';
import { createLogger } from '../core/logger.js';
import { createConfigRepo } from './repo.js';
import { seedIfEmpty } from './seed.js';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL, env.LOG_PRETTY);
const repo = createConfigRepo({ dir: env.CONFIG_REPO_DIR, cacheDir: env.CONFIG_WORKTREE_CACHE_DIR, log });
const r = await seedIfEmpty(repo, env.CONFIG_SEED_DIR, log);
console.log(`${r.seeded ? 'seeded' : 'already populated'}; main = ${r.head}`);
