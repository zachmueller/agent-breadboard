import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, productionSecretProblems } from './env.js';
import { createLogger } from './logger.js';
import { buildServices } from './build.js';

async function rootWith(dotenv: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bb-env-'));
  await writeFile(join(root, '.env'), dotenv);
  return root;
}

describe('loadEnv .env parsing', () => {
  it('strips inline comments, including after an empty value', async () => {
    const root = await rootWith(
      [
        'SANDBOX_OCI_RUNTIME=                       # e.g. runsc for gVisor',
        'SANDBOX_WARM_POOL_SIZE=3   # per language',
        'SANDBOX_EGRESS_PROXY_HOST=relay#not-a-comment',
        'SANDBOX_API_URL="http://x:4000/#frag"  ',
        '# PUBLIC_URL=http://commented-out',
      ].join('\n'),
    );
    const env = loadEnv({}, root);
    expect(env.SANDBOX_OCI_RUNTIME).toBeUndefined();
    expect(env.SANDBOX_WARM_POOL_SIZE).toBe(3);
    expect(env.SANDBOX_EGRESS_PROXY_HOST).toBe('relay#not-a-comment');
    expect(env.SANDBOX_API_URL).toBe('http://x:4000/#frag');
    expect(env.PUBLIC_URL).toBe('http://localhost:4000');
  });

  it('parses the shipped .env.example without comment text leaking into values', async () => {
    const example = await readFile(new URL('../../../../.env.example', import.meta.url), 'utf8');
    const env = loadEnv({}, await rootWith(example));
    for (const [k, v] of Object.entries(env)) expect(String(v), k).not.toMatch(/^#/);
    expect(env.SANDBOX_OCI_RUNTIME).toBeUndefined();
  });
});

describe('production secrets', () => {
  // Shapes the AWS reference deployment generates (deploy/aws: 48-char signing key, 43-char base64 broker key).
  const good = { NODE_ENV: 'production', TOKEN_SIGNING_KEY: 'a'.repeat(48), BROKER_MASTER_KEY: 'A'.repeat(43) };
  const prod = async (vars: Record<string, string>) => loadEnv({ ...vars }, await rootWith(''));

  it('accepts real secrets, and does not apply outside production', async () => {
    expect(productionSecretProblems(await prod(good))).toEqual([]);
    expect(productionSecretProblems(await prod({ ...good, BREADBOARD_BOOTSTRAP_ADMIN_TOKEN: 'b'.repeat(48) }))).toEqual([]);
    expect(productionSecretProblems(await prod({ NODE_ENV: 'development' }))).toEqual([]);
  });

  it('refuses the default signing key, a short one, a missing broker key, and a well-known bootstrap token', async () => {
    const problems = productionSecretProblems(await prod({ NODE_ENV: 'production', BREADBOARD_BOOTSTRAP_ADMIN_TOKEN: 'admin-change-me' }));
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/TOKEN_SIGNING_KEY is unset or a well-known/);
    expect(problems.join('\n')).toMatch(/BROKER_MASTER_KEY is unset/);
    expect(problems.join('\n')).toMatch(/BREADBOARD_BOOTSTRAP_ADMIN_TOKEN is a well-known/);
    expect(productionSecretProblems(await prod({ ...good, TOKEN_SIGNING_KEY: 'short-but-real' }))).toEqual([
      expect.stringMatching(/at least 32 characters/),
    ]);
  });

  it('stops buildServices before it touches the database', async () => {
    const env = await prod({ NODE_ENV: 'production', DATABASE_URL: 'postgres://nowhere.invalid:1/x' });
    await expect(buildServices({ env, log: createLogger('silent', false) })).rejects.toThrow(/refusing to start with NODE_ENV=production[\s\S]*TOKEN_SIGNING_KEY[\s\S]*BROKER_MASTER_KEY/);
  });
});
