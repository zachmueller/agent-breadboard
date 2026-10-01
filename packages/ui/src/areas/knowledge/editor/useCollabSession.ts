/** React lifecycle for a `CollabSession`: one per (uid, generation), destroyed on unmount or rebuild. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CollabSession, type CollabSnapshot } from './collab';

const INITIAL: CollabSnapshot = { status: 'connecting', synced: false, scope: null, authError: null, wipeout: null, unsynced: 0 };
const noSubscribe = () => () => undefined;
const initial = () => INITIAL;

export function useCollabSession(uid: string): { session: CollabSession | null; snapshot: CollabSnapshot; rebuild: () => void } {
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<CollabSession | null>(null);

  useEffect(() => {
    const s = new CollabSession(uid);
    setSession(s);
    return () => {
      setSession((cur) => (cur === s ? null : cur));
      s.destroy();
    };
  }, [uid, generation]);

  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? initial, session?.getSnapshot ?? initial);
  /** Discard the local document and start over from the server (e.g. after dismissing a wipeout block). */
  const rebuild = useCallback(() => setGeneration((g) => g + 1), []);
  return { session, snapshot, rebuild };
}
