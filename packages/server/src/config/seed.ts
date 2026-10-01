/**
 * First-boot seeding: when the config repo has no commits (or an empty tree), copy the shipped
 * `config-seed/` directory in as the initial `main` commit ([01] §6.1).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ConfigRepo } from '../core/services.js';
import { DEFAULT_BRANCH, SYSTEM_AUTHOR, readDirAsChanges } from './repo.js';

export async function seedIfEmpty(repo: ConfigRepo, seedDir: string | null | undefined, log: Logger): Promise<{ seeded: boolean; head: string }> {
  const seed = seedDir && existsSync(resolve(seedDir)) ? resolve(seedDir) : null;
  if (seedDir && !seed) log.warn({ seedDir }, 'CONFIG_SEED_DIR does not exist; starting with an empty configuration');

  let head: string | null = null;
  try {
    head = await repo.resolve(DEFAULT_BRANCH);
  } catch {
    head = null;
  }
  if (head === null) {
    const r = await repo.init(seed, SYSTEM_AUTHOR);
    log.info({ head: r.head, created: r.created, seeded: !!seed }, 'config repo initialized');
    return { seeded: !!seed, head: r.head };
  }
  const files = await repo.listFiles(head);
  if (files.length === 0 && seed) {
    const changes = await readDirAsChanges(seed);
    if (changes.length === 0) return { seeded: false, head };
    const commit = await repo.commit({ branch: DEFAULT_BRANCH, changes, message: `Seed configuration from ${seed}`, author: SYSTEM_AUTHOR });
    log.info({ head: commit, files: changes.length }, 'config repo seeded into empty main');
    return { seeded: true, head: commit };
  }
  return { seeded: false, head };
}
