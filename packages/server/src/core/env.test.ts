import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './env.js';

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
