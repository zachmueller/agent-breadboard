import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_ARN, defaultAwsRoleResolver } from './aws-role.js';

afterEach(() => vi.unstubAllEnvs());

describe('defaultAwsRoleResolver', () => {
  it('uses the server credential chain when no role is named', async () => {
    vi.stubEnv('AWS_PROFILE', undefined); // a set profile makes the chain skip env credentials
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDCHAIN');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'chain-token');
    const resolve = defaultAwsRoleResolver();
    expect(await resolve({ region: 'us-east-1' })).toEqual({ access_key_id: 'AKIDCHAIN', secret_access_key: 'chain-secret', session_token: 'chain-token' });
  });

  it('accepts role ARNs only', () => {
    expect(ROLE_ARN.test('arn:aws:iam::123456789012:role/breadboard-carp-data')).toBe(true);
    expect(ROLE_ARN.test('arn:aws:iam::123456789012:role/path/to/role')).toBe(true);
    expect(ROLE_ARN.test('arn:aws:iam::123456789012:user/alice')).toBe(false);
    expect(ROLE_ARN.test('arn:aws:iam::12345:role/r')).toBe(false);
  });
});
