/** Canvas positions are UI state: kept in localStorage per circuit uid, never written into YAML ([03] §8.1). */
export type Positions = Record<string, { x: number; y: number }>;

export const positionsKey = (uid: string) => `bb.circuit.positions.${uid}`;

export function readPositions(uid: string | null | undefined): Positions {
  if (!uid) return {};
  try {
    const v = JSON.parse(localStorage.getItem(positionsKey(uid)) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function writePositions(uid: string, p: Positions) {
  try {
    if (Object.keys(p).length) localStorage.setItem(positionsKey(uid), JSON.stringify(p));
    else localStorage.removeItem(positionsKey(uid));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent('bb:circuit-positions', { detail: uid }));
}

/** Carry a node's stored position across a step rename. */
export function renamePosition(uid: string, fromNodeId: string, toNodeId: string) {
  const p = readPositions(uid);
  if (!p[fromNodeId]) return;
  p[toNodeId] = p[fromNodeId]!;
  delete p[fromNodeId];
  writePositions(uid, p);
}
