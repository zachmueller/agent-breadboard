import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PYTHON = process.env.PYTHON_BIN ?? 'python3';
const hasPython = (() => {
  try {
    execFileSync(PYTHON, ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const HARNESS_SRC = fileURLToPath(new URL('../../../../config-seed/tools/01J8T0SPAWNHARNESS00/src', import.meta.url));

describe('spawn-harness output capture', () => {
  it.skipIf(!hasPython)('matches the default **/*.md glob at the workspace root as well as in subdirectories', () => {
    const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(HARNESS_SRC)}); import main
print(json.dumps([main._matches(p, g) for p, g in [("README.md", "**/*.md"), ("docs/a.md", "**/*.md"), ("a.py", "**/*.md"), ("src/x.py", "src/*.py")]]))`;
    expect(JSON.parse(execFileSync(PYTHON, ['-c', script]).toString())).toEqual([true, true, false, true]);
  });
});
