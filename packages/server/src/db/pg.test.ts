import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { poolConfig } from './pg.js';

const URL_NO_PASSWORD = 'postgres://breadboard@db.example.us-east-1.rds.amazonaws.com:5432/breadboard';
const token = async () => 'rds-iam-token';

describe('poolConfig', () => {
  it('keeps the IAM token function all the way into the client pg creates', async () => {
    const config = poolConfig({ url: URL_NO_PASSWORD, ssl: 'require', iamAuth: true }, token);
    expect(config).not.toHaveProperty('connectionString');
    expect(config).toMatchObject({ host: 'db.example.us-east-1.rds.amazonaws.com', port: 5432, user: 'breadboard', database: 'breadboard', ssl: { rejectUnauthorized: false } });
    expect(config.password).toBe(token);
    // What used to drop the function: pg's ConnectionParameters re-parsed a connectionString over the config. The
    // constructor does not connect.
    const client = new pg.Client(config);
    expect(typeof client.password).toBe('function');
    expect(await (client.password as unknown as () => Promise<string>)()).toBe('rds-iam-token');
  });

  it('forces TLS for IAM auth when no SSL mode asks for it', () => {
    expect(poolConfig({ url: URL_NO_PASSWORD }, token).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('maps SSL modes as before, with URL SSL parameters winning', () => {
    expect(poolConfig({ url: URL_NO_PASSWORD, ssl: 'require' }).ssl).toEqual({ rejectUnauthorized: false });
    expect(poolConfig({ url: URL_NO_PASSWORD, ssl: 'verify-full' }).ssl).toEqual({ rejectUnauthorized: true, ca: undefined });
    expect(poolConfig({ url: URL_NO_PASSWORD, ssl: 'prefer' }).ssl).toBeUndefined();
    expect(poolConfig({ url: `${URL_NO_PASSWORD}?sslmode=disable`, ssl: 'require' }).ssl).toBe(false);
  });

  it('passes a URL password and pool size through when IAM auth is off', () => {
    const config = poolConfig({ url: 'postgres://app:s%40cret@localhost:5433/bb', poolSize: 3 });
    expect(config).toMatchObject({ host: 'localhost', port: 5433, user: 'app', password: 's@cret', database: 'bb', max: 3 });
    expect(new pg.Client(config).password).toBe('s@cret');
  });
});
