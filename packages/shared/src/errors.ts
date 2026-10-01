/** Stable machine-readable error codes ([11] §2). Typed failure codes match component specs. */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'grant-denied',
  'not-found',
  'note-not-found',
  'validation-failed',
  'conflict',
  'invalid-state',
  'base-revision-too-old',
  'parse-failed',
  'read-only-source',
  'scope-narrowing-rejected',
  'budget-exceeded',
  'rate-limited',
  'idempotency-mismatch',
  'anchor-not-found',
  'anchor-ambiguous',
  'anchor-unmappable',
  'wipeout-detected',
  'not-implemented',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  'grant-denied': 403,
  'not-found': 404,
  'note-not-found': 404,
  'validation-failed': 400,
  conflict: 409,
  'invalid-state': 409,
  'base-revision-too-old': 409,
  'parse-failed': 400,
  'read-only-source': 409,
  'scope-narrowing-rejected': 409,
  'budget-exceeded': 402,
  'rate-limited': 429,
  'idempotency-mismatch': 422,
  'anchor-not-found': 422,
  'anchor-ambiguous': 422,
  'anchor-unmappable': 422,
  'wipeout-detected': 409,
  'not-implemented': 501,
  internal: 500,
};

export class BreadboardError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: unknown;
  constructor(code: ErrorCode, message?: string, detail?: unknown) {
    super(message ?? code);
    this.name = 'BreadboardError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.detail = detail;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.detail !== undefined ? { detail: this.detail } : {}) } };
  }
}

export const notFound = (what: string, id?: string) => new BreadboardError('not-found', id ? `${what} ${id} not found` : `${what} not found`);
export const grantDenied = (msg: string, detail?: unknown) => new BreadboardError('grant-denied', msg, detail);
export const validationFailed = (msg: string, detail?: unknown) => new BreadboardError('validation-failed', msg, detail);
export const invalidState = (msg: string, detail?: unknown) => new BreadboardError('invalid-state', msg, detail);
