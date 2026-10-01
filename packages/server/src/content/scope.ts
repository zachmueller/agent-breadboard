import { SCOPE_WIDTH, type Scope } from '@breadboard/shared';
import { BreadboardError } from '@breadboard/shared';

/** Scope propagation ([01] §3.4): derived nodes default to the narrowest parent scope unless widened explicitly. */
export function propagatedScope(parentScopes: Scope[], requested: Scope | undefined, defaultScope: Scope): Scope {
  if (requested) return requested;
  if (parentScopes.length === 0) return defaultScope;
  let narrowest: Scope = parentScopes[0]!;
  for (const s of parentScopes) if (SCOPE_WIDTH[s] < SCOPE_WIDTH[narrowest]) narrowest = s;
  return narrowest;
}

/** Narrowing is rejected when a wider-scoped `derived-from` descendant exists ([01] §3.4). */
export function assertNoNarrowing(current: Scope, next: Scope, widestDescendant: Scope | null): void {
  if (SCOPE_WIDTH[next] >= SCOPE_WIDTH[current]) return;
  if (widestDescendant && SCOPE_WIDTH[widestDescendant] > SCOPE_WIDTH[next]) {
    throw new BreadboardError('scope-narrowing-rejected', `cannot narrow scope to '${next}': a '${widestDescendant}'-scoped node derives from this one`);
  }
}

export function isWider(a: Scope, b: Scope): boolean {
  return SCOPE_WIDTH[a] > SCOPE_WIDTH[b];
}
