/**
 * AWS Signature Version 4 request signing with Node crypto (header-based auth), used by the broker's
 * `aws-sigv4` credential kind. Implements the canonical-request / string-to-sign / derived-key algorithm from
 * the AWS SigV4 spec; S3 uses single-encoded paths and an `x-amz-content-sha256` header, other services
 * double-encode path segments. Also derives the SigV4-based password CodeCommit accepts for git over HTTPS
 * (repository mirrors, [06] §7.1).
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface SigV4Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();

/** RFC 3986 strict encoding (AWS flavour). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalPath(pathname: string, service: string): string {
  if (!pathname) return '/';
  const segments = pathname.split('/').map((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    const once = rfc3986(decoded);
    return service === 's3' ? once : rfc3986(once);
  });
  return segments.join('/') || '/';
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  params.forEach((v, k) => pairs.push([rfc3986(k), rfc3986(v)]));
  pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

/** The SigV4 derived signing key for one day, region and service. */
export function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}

/** Returns the headers to add (`authorization`, `x-amz-date`, optional token / content hash). */
export function signSigV4(
  req: SigV4Request,
  creds: SigV4Credentials,
  opts: { region: string; service: string; now?: Date },
): Record<string, string> {
  const url = new URL(req.url);
  const date = amzDate(opts.now ?? new Date());
  const day = date.slice(0, 8);
  const payloadHash = sha256(req.body ?? '');
  const add: Record<string, string> = { 'x-amz-date': date };
  if (creds.session_token) add['x-amz-security-token'] = creds.session_token;
  if (opts.service === 's3') add['x-amz-content-sha256'] = payloadHash;

  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) all[k.toLowerCase()] = v;
  Object.assign(all, add);
  all.host = url.host;
  delete all.authorization;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(url.pathname, opts.service), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(creds.secret_access_key, day, opts.region, opts.service)).update(stringToSign).digest('hex');
  add.authorization = `AWS4-HMAC-SHA256 Credential=${creds.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return add;
}

/**
 * Git-over-HTTPS credentials for CodeCommit, as the AWS CLI credential helper computes them: the username is the
 * access key id (plus `%` and the session token), the password a timestamp and a SigV4 signature over a `GIT`
 * pseudo-request for the repository path. Valid for about 15 minutes, so compute one per git invocation.
 */
export function codecommitGitCredentials(args: { host: string; path: string; region: string; creds: SigV4Credentials; now?: Date }): { username: string; password: string } {
  // `YYYYMMDDTHHMMSS` without the usual trailing `Z`: the helper signs that form and joins it to the signature with `Z`.
  const date = amzDate(args.now ?? new Date()).replace(/Z$/, '');
  const day = date.slice(0, 8);
  const canonicalRequest = `GIT\n${args.path}\n\nhost:${args.host}\n\nhost\n`;
  const scope = `${day}/${args.region}/codecommit/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(args.creds.secret_access_key, day, args.region, 'codecommit')).update(stringToSign).digest('hex');
  const username = args.creds.session_token ? `${args.creds.access_key_id}%${args.creds.session_token}` : args.creds.access_key_id;
  return { username, password: `${date}Z${signature}` };
}
