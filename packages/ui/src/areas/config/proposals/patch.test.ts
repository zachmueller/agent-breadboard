import { describe, expect, it } from 'vitest';
import { splitPatch } from './patch';

const patch = `diff --git a/tenets.md b/tenets.md
index 1111111..2222222 100644
--- a/tenets.md
+++ b/tenets.md
@@ -1 +1 @@
-Be precise.
+Be precise and kind.
diff --git a/tools/01J8T00XCHKC1TAT1N00/src/old.ts b/tools/01J8T00XCHKC1TAT1N00/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/tools/01J8T00XCHKC1TAT1N00/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export {};
diff --git a/presets/models.yaml b/presets/models.yaml
new file mode 100644
--- /dev/null
+++ b/presets/models.yaml
@@ -0,0 +1 @@
+schema: x
`;

describe('splitPatch', () => {
  it('keys each file section by path, including deletions and additions', () => {
    const s = splitPatch(patch);
    expect([...s.keys()]).toEqual(['tenets.md', 'tools/01J8T00XCHKC1TAT1N00/src/old.ts', 'presets/models.yaml']);
    expect(s.get('tenets.md')).toContain('+Be precise and kind.');
    expect(s.get('tenets.md')).not.toContain('old.ts');
    expect(s.get('presets/models.yaml')!.endsWith('+schema: x')).toBe(true);
  });
  it('returns nothing for an empty patch', () => {
    expect(splitPatch('').size).toBe(0);
  });
});
