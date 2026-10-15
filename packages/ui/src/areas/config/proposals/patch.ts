/** Split a `git diff` patch into per-file sections, keyed by the file's path (the new path; the old one for deletions). Pure. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  for (const sec of sections) {
    const head = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(sec);
    const plus = /^\+\+\+ b\/(.+)$/m.exec(sec);
    const minus = /^--- a\/(.+)$/m.exec(sec);
    const path = plus?.[1] ?? minus?.[1] ?? head?.[2] ?? head?.[1];
    if (path) out.set(path, sec.replace(/\n$/, ''));
  }
  return out;
}
