/**
 * One shared SSE connection for the whole app ([11] §5). Hooks register topic interest;
 * the multiplexer keeps a single EventSource open over the union of topics and fans events out.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EventTopic, StreamEvent } from '@breadboard/shared';
import { sse, type SseHandle } from './api';

type Listener = { topics: Set<string>; fn: (e: StreamEvent) => void };

const listeners = new Set<Listener>();
let handle: SseHandle | null = null;
let currentKey = '';
let lastEventId: string | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;
const statusSubs = new Set<() => void>();
let enabled = false;

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  for (const s of statusSubs) s();
}

function wantedTopics(): string[] {
  const t = new Set<string>();
  for (const l of listeners) for (const x of l.topics) t.add(x);
  return [...t].sort();
}

function reconcile() {
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    const topics = enabled ? wantedTopics() : [];
    const key = topics.join(',');
    if (key === currentKey && handle) return;
    handle?.close();
    handle = null;
    setConnected(false);
    currentKey = key;
    if (!topics.length) return;
    handle = sse(
      topics,
      (ev) => {
        lastEventId = ev.id || lastEventId;
        for (const l of listeners) if (l.topics.has(ev.topic)) l.fn(ev);
      },
      { lastEventId, onOpen: () => setConnected(true), onError: () => setConnected(false) },
    );
  }, 50);
}

/** Enable/disable the stream (the auth layer turns it on once a user is signed in). */
export function setLiveEnabled(v: boolean) {
  if (enabled === v) return;
  enabled = v;
  if (!v) lastEventId = null;
  currentKey = '';
  reconcile();
}

export function subscribeLive(topics: readonly (EventTopic | string)[], fn: (e: StreamEvent) => void): () => void {
  const l: Listener = { topics: new Set(topics), fn };
  listeners.add(l);
  reconcile();
  return () => {
    listeners.delete(l);
    reconcile();
  };
}

/** Subscribe to live events while mounted. The handler may change between renders without resubscribing. */
export function useLiveEvents(topics: readonly (EventTopic | string)[], handler: (e: StreamEvent) => void, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  const key = topics.join(',');
  useEffect(() => {
    if (!active || !key) return;
    return subscribeLive(key.split(','), (e) => ref.current(e));
  }, [key, active]);
}

/** Whether the shared stream is currently connected (for a "Live" indicator). */
export function useLiveConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    () => connected,
    () => false,
  );
}

/** Pull a session id / node uid out of a stream payload, tolerant of naming. */
export function payloadSessionId(e: StreamEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  const v = p.session_id ?? p.sessionId ?? e.visibility?.session_id;
  return typeof v === 'string' ? v : null;
}

export function payloadNodeUid(e: StreamEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  const v = p.uid ?? p.node_uid ?? p.artifact_uid ?? e.visibility?.node_uid;
  return typeof v === 'string' ? v : null;
}
