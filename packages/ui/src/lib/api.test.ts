import { describe, expect, it } from 'vitest';
import { ApiError, asPage, buildUrl, errorMessage, parseStreamEvent, toApiError } from './api';

describe('toApiError', () => {
  it('uses the server error envelope code, message and detail', () => {
    const e = toApiError(409, { error: { code: 'stale-revision', message: 'Base revision is stale', detail: { head: 4 } } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('stale-revision');
    expect(e.message).toBe('Base revision is stale');
    expect(e.status).toBe(409);
    expect(e.detail).toEqual({ head: 4 });
  });

  it('falls back to a status-derived code when the envelope has none', () => {
    const e = toApiError(404, { error: { message: 'gone' } });
    expect(e.code).toBe('not-found');
    expect(e.isNotFound).toBe(true);
  });

  it('maps statuses without a body', () => {
    expect(toApiError(401, null).isUnauthorized).toBe(true);
    expect(toApiError(403, undefined).isForbidden).toBe(true);
    expect(toApiError(402, null).code).toBe('budget-exceeded');
    expect(toApiError(429, null).code).toBe('rate-limited');
    expect(toApiError(503, null).code).toBe('internal');
    expect(toApiError(418, null).code).toBe('error');
  });

  it('uses statusText, then a generic message', () => {
    expect(toApiError(500, null, 'Internal Server Error').message).toBe('Internal Server Error');
    expect(toApiError(500, null).message).toBe('Request failed (500)');
  });

  it('accepts a string error field and short text bodies', () => {
    expect(toApiError(400, { error: 'bad handle' }).message).toBe('bad handle');
    expect(toApiError(400, { error: 'bad handle' }).code).toBe('validation-failed');
    expect(toApiError(502, '  upstream down  ').message).toBe('upstream down');
    expect(toApiError(502, 'x'.repeat(400), 'Bad Gateway').message).toBe('Bad Gateway');
  });

  it('treats grant-denied as forbidden regardless of status', () => {
    expect(toApiError(404, { error: { code: 'grant-denied', message: 'no' } }).isForbidden).toBe(true);
  });
});

describe('errorMessage', () => {
  it('handles ApiError, Error and other values', () => {
    expect(errorMessage(new ApiError('x', 'api msg', 400))).toBe('api msg');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('buildUrl', () => {
  it('prefixes the API base', () => {
    expect(buildUrl('/sessions')).toBe('/api/v1/sessions');
    expect(buildUrl('sessions')).toBe('/api/v1/sessions');
    expect(buildUrl('/api/v1/sessions')).toBe('/api/v1/sessions');
  });

  it('drops empty values and repeats arrays', () => {
    expect(buildUrl('/nodes', { type: 'artifact', tag: ['a', '', 'b'], q: '', cursor: undefined, x: null, limit: 50, all: false })).toBe('/api/v1/nodes?type=artifact&tag=a&tag=b&limit=50&all=false');
  });

  it('appends to an existing query string', () => {
    expect(buildUrl('/events?topics=a', { after: 3 })).toBe('/api/v1/events?topics=a&after=3');
  });
});

describe('asPage', () => {
  it('normalizes pages and bare arrays', () => {
    expect(asPage([1, 2])).toEqual({ items: [1, 2], next_cursor: null });
    expect(asPage({ items: [1], next_cursor: 'c' })).toEqual({ items: [1], next_cursor: 'c' });
    expect(asPage({ items: [1] })).toEqual({ items: [1], next_cursor: null });
    expect(asPage({ nope: true })).toEqual({ items: [], next_cursor: null });
    expect(asPage(null)).toEqual({ items: [], next_cursor: null });
  });
});

describe('parseStreamEvent', () => {
  it('parses a full envelope', () => {
    const e = parseStreamEvent(JSON.stringify({ id: '7', topic: 'session.state', at: '2026-09-30T00:00:00Z', payload: { session_id: 's' }, visibility: { scope: 'session', session_id: 's' } }), null, '0');
    expect(e).toEqual({ id: '7', topic: 'session.state', at: '2026-09-30T00:00:00Z', payload: { session_id: 's' }, visibility: { scope: 'session', session_id: 's' } });
  });

  it('uses the SSE event name and last event id when the body is a bare payload', () => {
    const e = parseStreamEvent(JSON.stringify({ uid: 'X' }), 'node.updated', '12');
    expect(e?.topic).toBe('node.updated');
    expect(e?.id).toBe('12');
    expect(e?.payload).toEqual({ uid: 'X' });
    expect(e?.visibility).toEqual({ scope: 'team' });
  });

  it('rejects invalid JSON, non-objects and topicless messages', () => {
    expect(parseStreamEvent('not json', 'x', '1')).toBeNull();
    expect(parseStreamEvent('3', 'x', '1')).toBeNull();
    expect(parseStreamEvent('{"a":1}', null, '1')).toBeNull();
  });
});
