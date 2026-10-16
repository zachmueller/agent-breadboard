import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
const ADAPTER_CHECKS = fileURLToPath(new URL('../../test/spawn_harness_adapters.py', import.meta.url));
// The adapter checks need the sandbox image's Python packages; point PYTHON_BIN at an interpreter that has them.
const hasStrands = (() => {
  try {
    execFileSync(PYTHON, ['-c', 'import strands, strands_harness']);
    return true;
  } catch {
    return false;
  }
})();

describe('spawn-harness output capture', () => {
  it.skipIf(!hasPython)('matches the default **/*.md glob at the workspace root as well as in subdirectories', () => {
    const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(HARNESS_SRC)}); import main
print(json.dumps([main._matches(p, g) for p, g in [("README.md", "**/*.md"), ("docs/a.md", "**/*.md"), ("a.py", "**/*.md"), ("src/x.py", "src/*.py")]]))`;
    expect(JSON.parse(execFileSync(PYTHON, ['-c', script]).toString())).toEqual([true, true, false, true]);
  });
});

describe('spawn-harness Strands adapters', () => {
  it.skipIf(!hasStrands)('round-trips reasoning and cache usage through the gateway model, and runs the strands-harness adapter', () => {
    expect(execFileSync(PYTHON, ['-I', ADAPTER_CHECKS, HARNESS_SRC], { cwd: tmpdir() }).toString().trim().split('\n').at(-1)).toBe('ok');
  }, 60_000);
});
