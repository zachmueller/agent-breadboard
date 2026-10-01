import { describe, it, expect } from 'vitest';
import { lintManifest, securityDiff, limitsOf } from './manifestLint';

const base = {
  language: 'typescript',
  entrypoint: 'src/index.ts',
  limits: { timeout_s: 60, memory_mb: 256 },
  egress: { allow: [{ host: 'api.crossref.org', ports: [443] }] },
  capabilities: [{ name: 'crossref', scope: 'read' }],
  settings: { domains: { type: 'array', hidden: true } },
};

describe('limitsOf', () => {
  it('fills schema defaults', () => {
    expect(limitsOf({ limits: { timeout_s: 5 } })).toEqual({ timeout_s: 5, memory_mb: 512, cpus: 1, pids: 256, max_cost_units: 1 });
  });
});

describe('securityDiff', () => {
  it('is empty for identical manifests', () => {
    expect(securityDiff(base, structuredClone(base))).toEqual([]);
  });
  it('flags raised limits, new egress/ports, new capabilities and unhidden settings as risks', () => {
    const next = structuredClone(base) as any;
    next.limits.timeout_s = 300;
    next.limits.memory_mb = 128;
    next.egress.allow[0].ports = [443, 80];
    next.egress.allow.push({ host: 'example.com' });
    next.capabilities.push({ name: 'github', scope: 'write' });
    next.settings.domains.hidden = false;
    next.exposure = { external_mcp: true };
    const f = securityDiff(base, next);
    const risks = f.filter((x) => x.severity === 'risk').map((x) => x.text);
    expect(risks).toContain('timeout_s raised 60 -> 300');
    expect(risks).toContain('egress to api.crossref.org gains port(s) 80');
    expect(risks).toContain('egress allowed to example.com:443');
    expect(risks).toContain('capability github (write) requested');
    expect(risks.some((t) => t.startsWith('setting domains is no longer hidden'))).toBe(true);
    expect(risks).toContain('now exposed to external MCP clients');
    expect(f.find((x) => x.text === 'memory_mb lowered 256 -> 128')?.severity).toBe('info');
  });
  it('treats removals as informational', () => {
    const next = { ...base, egress: { allow: [] }, capabilities: [] };
    const f = securityDiff(base, next);
    expect(f.every((x) => x.severity === 'info' || x.area === 'settings')).toBe(true);
    expect(f.map((x) => x.text)).toEqual(expect.arrayContaining(['egress to api.crossref.org removed', 'capability crossref dropped']));
  });
  it('lists egress for a brand-new tool', () => {
    expect(securityDiff(null, base).map((x) => x.text)).toContain('egress allowed to api.crossref.org:443');
  });
});

describe('lintManifest', () => {
  it('flags wildcards, odd ports, write scopes and missing entrypoints', () => {
    const f = lintManifest({ language: 'python', entrypoint: 'main.ts', egress: { allow: [{ host: '*.example.com', ports: [8080] }] }, capabilities: [{ name: 'gh', scope: 'repo:write' }] }, { entrypointExists: false });
    const texts = f.map((x) => x.text).join('\n');
    expect(texts).toMatch(/wildcard host/);
    expect(texts).toMatch(/port\(s\) 8080/);
    expect(texts).toMatch(/write-level scope/);
    expect(texts).toMatch(/not a \.py file/);
    expect(texts).toMatch(/does not exist/);
  });
  it('is quiet for a tidy manifest', () => {
    expect(lintManifest(base, { entrypointExists: true })).toEqual([]);
  });
});
