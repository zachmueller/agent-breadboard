/** Canonical deep-link builders ([10] §2). Use these instead of hand-assembling URLs. */

export const nodePath = (uid: string) => `/n/${uid}`;
export const sessionPath = (id: string, step?: string | null) => (step ? `/s/${id}?step=${encodeURIComponent(step)}` : `/s/${id}`);
export const configPath = (uid: string) => `/config/${uid}`;

/** Editor route for a config definition by kind (`/config/<uid>` resolves to these). */
export function configEditorPath(kind: string | null | undefined, uid: string | null | undefined): string | null {
  if (!uid) return null;
  switch (kind) {
    case 'circuit':
    case 'rubric':
    case 'fixtures':
      return `/circuits/${uid}`;
    case 'tool':
    case 'mcp':
      return `/toolbox/${uid}`;
    case 'subagent':
      return `/subagents/${uid}`;
    default:
      return null;
  }
}

/** Where a content node's editor lives: CRDT notes open the shared editor. */
export function nodeEditorPath(node: { uid: string; type: string; crdt: boolean }): string | null {
  if (node.crdt) return `/knowledge/${node.uid}`;
  return null;
}
