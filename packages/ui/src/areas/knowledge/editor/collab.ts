/**
 * Live-document session for the shared editor ([07] §4, [10] §3): one Y.Doc + one Hocuspocus provider
 * on `/api/v1/sync`, with the server's wipeout protocol handled ([07] §6):
 *
 *  - the server rejects an update deleting > `wipeout_fraction` of a note, sends a stateless
 *    `{"type":"wipeout-blocked", deleted, total}` and closes with 4409;
 *  - the client stops reconnecting (otherwise it would loop re-sending the same update), surfaces the
 *    block, and on confirm reconnects with `?confirmWipeout=1` (one-shot), or on cancel discards the
 *    local document and rebuilds from the server;
 *  - edits the editor's own guard already confirmed are pre-announced with `{"type":"confirm-wipeout"}`.
 *
 * The websocket is caller-owned (so its URL can be switched for the confirm reconnect), which means
 * the provider must be attached explicitly.
 */
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { API_BASE, getToken } from '../../../lib/api';
import type { AwarenessLike } from './extensions';

export type ConnStatus = 'connecting' | 'connected' | 'disconnected';
export type SyncScope = 'read-write' | 'readonly';

export interface CollabSnapshot {
  status: ConnStatus;
  /** First full sync with the server completed (stays true across reconnects). */
  synced: boolean;
  scope: SyncScope | null;
  authError: string | null;
  /** Server-side wipeout block awaiting a decision. */
  wipeout: { deleted: number | null; total: number | null } | null;
  unsynced: number;
}

export const WIPEOUT_CLOSE_CODE = 4409;

export function syncUrl(confirmWipeout = false, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const base = /^https?:/i.test(API_BASE) ? API_BASE.replace(/^http/i, 'ws') : `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${API_BASE}`;
  return `${base.replace(/\/+$/, '')}/sync${confirmWipeout ? '?confirmWipeout=1' : ''}`;
}

/** Parse a stateless payload from the sync server. */
export function parseWipeoutBlocked(payload: string): { deleted: number | null; total: number | null } | null {
  try {
    const msg = JSON.parse(payload) as { type?: unknown; deleted?: unknown; total?: unknown };
    if (msg?.type !== 'wipeout-blocked') return null;
    return { deleted: typeof msg.deleted === 'number' ? msg.deleted : null, total: typeof msg.total === 'number' ? msg.total : null };
  } catch {
    return null;
  }
}

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  private snapshot: CollabSnapshot = { status: 'connecting', synced: false, scope: null, authError: null, wipeout: null, unsynced: 0 };
  private readonly listeners = new Set<() => void>();
  private confirmedUntil = 0;
  private lastBlockAt = 0;
  private destroyed = false;

  constructor(readonly uid: string) {
    this.socket = new HocuspocusProviderWebsocket({ url: syncUrl(false) });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: uid,
      document: this.doc,
      token: () => getToken() ?? '',
      onStatus: ({ status }) => this.set({ status: status as ConnStatus }),
      onSynced: ({ state }) => {
        if (state && !this.snapshot.synced) this.set({ synced: true });
      },
      onAuthenticated: ({ scope }) => this.set({ scope: (scope as SyncScope) ?? null, authError: null }),
      onAuthenticationFailed: ({ reason }) => {
        this.set({ authError: reason || 'denied' });
        this.socket.disconnect();
      },
      onStateless: ({ payload }) => {
        const blocked = parseWipeoutBlocked(payload);
        if (blocked) this.onWipeoutBlocked(blocked);
      },
      onClose: ({ event }) => {
        // The stateless notice normally precedes the 4409 close; only act on the close if it was lost.
        if (event?.code === WIPEOUT_CLOSE_CODE && Date.now() - this.lastBlockAt > 3000) this.onWipeoutBlocked(this.snapshot.wipeout ?? { deleted: null, total: null });
      },
      onUnsyncedChanges: ({ number }) => this.set({ unsynced: number }),
    });
    // Caller-owned websocket: the provider is not attached automatically.
    this.provider.attach();
  }

  get awareness(): AwarenessLike | null {
    return (this.provider.awareness as unknown as AwarenessLike | null) ?? null;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): CollabSnapshot => this.snapshot;

  private set(patch: Partial<CollabSnapshot>) {
    if (this.destroyed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private onWipeoutBlocked(info: { deleted: number | null; total: number | null }) {
    if (this.destroyed) return;
    this.lastBlockAt = Date.now();
    // Stop the reconnect loop: every reconnect would re-send the same blocked update.
    this.socket.disconnect();
    if (Date.now() < this.confirmedUntil) {
      // The user already confirmed this edit in the editor; the stateless pre-announcement lost the race.
      this.confirmedUntil = 0;
      this.reconnect(true);
      return;
    }
    this.set({ wipeout: info });
  }

  /** Pre-announce a user-confirmed large deletion (opens a short server-side allow window). */
  announceConfirmedWipeout() {
    this.confirmedUntil = Date.now() + 30_000;
    try {
      this.provider.sendStateless(JSON.stringify({ type: 'confirm-wipeout' }));
    } catch {
      /* not connected: the 4409 path reconnects with ?confirmWipeout=1 */
    }
  }

  /** The user confirmed a server-blocked deletion: reconnect with the one-shot confirm flag. */
  confirmServerWipeout() {
    this.set({ wipeout: null });
    this.reconnect(true);
  }

  /** Dismiss a server-side block without applying it; the caller should rebuild the session. */
  dismissWipeout() {
    this.set({ wipeout: null });
  }

  private reconnect(confirm: boolean) {
    this.socket.disconnect();
    this.socket.setConfiguration({ url: syncUrl(confirm) });
    void this.socket
      .connect()
      .catch(() => undefined)
      .finally(() => {
        // Only this connection carries the flag; later reconnects use the plain URL.
        if (confirm && !this.destroyed) this.socket.setConfiguration({ url: syncUrl(false) });
      });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    try {
      this.provider.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.doc.destroy();
  }
}
