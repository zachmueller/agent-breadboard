/**
 * Credentials for the broker's `aws-role` kind ([12] §5): nothing secret is stored. The server's own AWS credential
 * chain (the instance role on the AWS reference host, else env vars or a profile) signs the request, after assuming
 * `role_arn` when the credential names one. Credentials are cached per role until five minutes before they expire,
 * so a busy tool does not call STS on every request.
 */
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { SigV4Credentials } from './sigv4.js';

export interface AwsRoleMaterial {
  region: string;
  role_arn?: string;
  external_id?: string;
  session_name?: string;
}

/** Resolves signing credentials for an `aws-role` credential. Injected in tests. */
export type AwsRoleResolver = (m: AwsRoleMaterial) => Promise<SigV4Credentials>;

export const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
export const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;
const DEFAULT_SESSION_NAME = 'breadboard-broker';
const REFRESH_BEFORE_MS = 5 * 60_000;

interface Identity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export function defaultAwsRoleResolver(): AwsRoleResolver {
  const base = fromNodeProviderChain();
  const cache = new Map<string, Identity>();
  return async (m) => {
    const key = [m.role_arn ?? '', m.external_id ?? '', m.session_name ?? '', m.role_arn ? m.region : ''].join('|');
    const hit = cache.get(key);
    const fresh = (c: Identity) => !c.expiration || c.expiration.getTime() - Date.now() > REFRESH_BEFORE_MS;
    let creds: Identity;
    if (hit && fresh(hit)) {
      creds = hit;
    } else {
      const provider = m.role_arn
        ? fromTemporaryCredentials({
            params: { RoleArn: m.role_arn, RoleSessionName: m.session_name ?? DEFAULT_SESSION_NAME, ...(m.external_id ? { ExternalId: m.external_id } : {}), DurationSeconds: 3600 },
            masterCredentials: base,
            clientConfig: { region: m.region },
          })
        : base;
      creds = await provider();
      cache.set(key, creds);
    }
    return { access_key_id: creds.accessKeyId, secret_access_key: creds.secretAccessKey, session_token: creds.sessionToken };
  };
}
