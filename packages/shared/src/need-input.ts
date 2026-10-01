import type { Actor } from './actor.js';

/**
 * `need-input` grammar ([09] §3): a structured tag plus a `need-input` properties array of requests.
 * Tags: `need-input` (any open request), `need-input:role=<slug>`, `need-input:username=<handle>`.
 */
export interface ReviewerTarget {
  role?: string | null;
  username?: string | null;
}

export interface NeedInputRequest {
  request_id: string; // nir_…
  role: string | null;
  username: string | null;
  prompt: string | null;
  requested_by: Actor;
  requested_at: string;
  /** Set when a hard gate created this request. */
  gate: { session_id: string; step_id: string } | null;
}

export interface ResolvedNeedInputRequest extends NeedInputRequest {
  resolved_by: Actor;
  resolved_at: string;
  verdict?: 'approve' | 'request-changes' | null;
  comment?: string | null;
}

export const NEED_INPUT_TAG = 'need-input';

export function needInputTags(requests: NeedInputRequest[]): string[] {
  const tags = new Set<string>();
  for (const r of requests) {
    tags.add(NEED_INPUT_TAG);
    if (r.role) tags.add(`${NEED_INPUT_TAG}:role=${r.role}`);
    if (r.username) tags.add(`${NEED_INPUT_TAG}:username=${r.username}`);
  }
  return [...tags];
}

export function isNeedInputTag(tag: string): boolean {
  return tag === NEED_INPUT_TAG || tag.startsWith(NEED_INPUT_TAG + ':');
}

/** Parse reviewer targeting written in tag grammar form, e.g. `role=scientist`, `username=zach`, `role=legal,username=ann`. */
export function parseReviewerTarget(spec: string): ReviewerTarget {
  const out: ReviewerTarget = {};
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || !v) continue;
    if (k === 'role') out.role = v;
    else if (k === 'username') out.username = v;
  }
  return out;
}

/** Does a request target the given user (by handle and/or role memberships)? Untargeted requests target everyone. */
export function requestTargetsUser(req: ReviewerTarget, user: { handle: string; roles: string[] }): boolean {
  if (!req.role && !req.username) return true;
  if (req.username && req.username === user.handle) return true;
  if (req.role && user.roles.includes(req.role)) return true;
  return false;
}
