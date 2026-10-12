import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONFIG_PATHS, SCHEMA_TAGS, mintUid, toYaml, type StreamEvent } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { EventBus, FileChange } from '../core/services.js';
import { createConfigRepo, type GitConfigRepo } from './repo.js';
import { createConfigService, type ConfigServiceImpl } from './service.js';

// --- fixture tree ------------------------------------------------------------------------------

const CIRC = mintUid();
const CHILD = mintUid();
const SUB_A = mintUid();
const SUB_B = mintUid();
const TOOL_A = mintUid();
const MCP_A = mintUid();

function circuitYaml(overrides: Record<string, unknown> = {}): string {
  return toYaml({
    schema: SCHEMA_TAGS.circuit,
    uid: CIRC,
    slug: 'lit-review',
    title: 'Literature review',
    input: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    exits: [
      { name: 'done', output: { type: 'object', required: ['summary_artifact'], properties: { summary_artifact: { $ref: '#/defs/artifact-ref' } } } },
      { name: 'empty', output: { type: 'object', properties: { note: { type: 'string' } } } },
    ],
    entry: 'gather',
    steps: [
      {
        id: 'gather',
        kind: 'llm',
        subagent: SUB_A,
        prompt: 'prompts/gather.md',
        tools_override: [TOOL_A],
        output: { type: 'object', required: ['sources'], properties: { sources: { type: 'array', items: { $ref: '#/defs/artifact-ref' } } } },
        exits: [
          { name: 'found-sources', to: 'summarize' },
          { name: 'nothing-found', to: 'report-empty' },
        ],
      },
      {
        id: 'summarize',
        kind: 'llm',
        subagent: SUB_B,
        prompt_inline: 'Summarize {{json steps.gather.output.sources}} for {{input.question}}. {{#if steps.check.output}}Fix: {{steps.check.output.missing}}{{/if}}',
        output: { type: 'object', required: ['summary_artifact'], properties: { summary_artifact: { $ref: '#/defs/artifact-ref' } } },
        exits: [{ name: 'done', to: 'check' }],
      },
      {
        id: 'check',
        kind: 'code',
        tool: TOOL_A,
        input_map: { artifact: '$steps.summarize.output.summary_artifact' },
        exits: [
          { name: 'pass', to: 'child' },
          { name: 'fail', to: 'summarize' },
        ],
      },
      {
        id: 'child',
        kind: 'circuit',
        circuit: CHILD,
        input_map: { artifact: '$steps.summarize.output.summary_artifact' },
        exit_map: { ok: 'proceed' },
        exits: [{ name: 'proceed', to: 'gate' }],
      },
      {
        id: 'gate',
        kind: 'gate',
        review: { artifacts: ['$steps.summarize.output.summary_artifact'], reviewers: { role: 'scientist' } },
        output: { type: 'object', required: ['summary_artifact'], properties: { summary_artifact: { $ref: '#/defs/artifact-ref' } } },
        exits: [
          { name: 'approve', to: '$exit.done' },
          { name: 'changes', to: 'summarize' },
        ],
      },
      {
        id: 'report-empty',
        kind: 'code',
        tool: TOOL_A,
        exits: [{ name: 'done', to: '$exit.empty' }],
      },
    ],
    ...overrides,
  });
}

function childCircuitYaml(): string {
  return toYaml({
    schema: SCHEMA_TAGS.circuit,
    uid: CHILD,
    slug: 'polish',
    title: 'Polish',
    exits: [{ name: 'ok' }],
    entry: 'polish',
    steps: [{ id: 'polish', kind: 'llm', subagent: SUB_B, prompt_inline: 'Polish {{input.artifact.uid}}', output: { type: 'object' }, exits: [{ name: 'ok', to: '$exit.ok' }] }],
  });
}

function subagentYaml(uid: string, slug: string, extra: Record<string, unknown> = {}): string {
  return toYaml({ schema: SCHEMA_TAGS.subagent, uid, slug, title: slug, model_preset: 'medium', system_prompt: `You are ${slug}.`, ...extra });
}

function toolYaml(uid = TOOL_A): string {
  return toYaml({ schema: SCHEMA_TAGS.tool, uid, slug: 'check-citations', title: 'Citation checker', language: 'typescript', entrypoint: 'src/index.ts', input: { type: 'object' }, output: { type: 'object', properties: { ok: { type: 'boolean' } } }, settings: { strict: { type: 'boolean', default: false, hidden: true } } });
}

function fixtureFiles(): Record<string, string> {
  return {
    'breadboard.yaml': toYaml({ schema: SCHEMA_TAGS.breadboard, team: { name: 'Test' }, intake: { triage_circuit: CIRC }, knowledge: { domains: [{ slug: 'research' }] }, tenets: { max_chars: 200 } }),
    'tenets.md': 'Never fabricate data.\n',
    'presets/models.yaml': toYaml({ schema: SCHEMA_TAGS.presets, presets: { small: [{ provider: 'mock', model_id: 'mock-small' }], medium: [{ provider: 'mock', model_id: 'mock-medium' }, { provider: 'bedrock', model_id: 'anthropic.claude-sonnet-5' }] } }),
    [CONFIG_PATHS.subagent(SUB_A)]: subagentYaml(SUB_A, 'research-scout', { tools: [{ tool: TOOL_A }, { mcp: MCP_A, allow: ['search'] }], knowledge: { read: ['research'], write: [] } }),
    [CONFIG_PATHS.subagent(SUB_B)]: subagentYaml(SUB_B, 'research-writer', { circuits: [{ circuit: CHILD, access: 'execute' }] }),
    [CONFIG_PATHS.circuit(CIRC)]: circuitYaml(),
    [CONFIG_PATHS.circuitPrompt(CIRC, 'gather')]: 'Find sources for {{input.question}}. Task {{ambient.task.uid}}.\n',
    [CONFIG_PATHS.rubric(CIRC)]: toYaml({ schema: SCHEMA_TAGS.rubric, circuit: CIRC, judge: { subagent: SUB_B, model_id: 'mock-medium', provider: 'mock' }, dimensions: [{ key: 'coverage', type: 'numeric', scale: { min: 0, max: 10 }, prompt: 'Coverage?' }, { key: 'grounded', type: 'boolean', prompt: 'Grounded?' }], aggregate: { weights: { coverage: 3, grounded: 1 } } }),
    [CONFIG_PATHS.fixtures(CIRC)]: toYaml({ schema: SCHEMA_TAGS.fixtures, circuit: CIRC, fixtures: [{ fixture_id: 'f1', title: 'basic', input: { question: 'why?' }, tags: ['smoke'] }] }),
    [CONFIG_PATHS.circuit(CHILD)]: childCircuitYaml(),
    [CONFIG_PATHS.tool(TOOL_A)]: toolYaml(),
    [`${CONFIG_PATHS.toolDir(TOOL_A)}/src/index.ts`]: 'export async function handler(input, ctx) { return { exit: "pass", output: { ok: true } }; }\n',
    [CONFIG_PATHS.mcp(MCP_A)]: toYaml({ schema: SCHEMA_TAGS.mcp, uid: MCP_A, slug: 'web-search', title: 'Web search', transport: 'http', endpoint: 'https://mcp.example.com/mcp' }),
  };
}

class FakeBus implements EventBus {
  events: StreamEvent[] = [];
  async publish(topic: StreamEvent['topic'], payload: Record<string, unknown>, visibility: StreamEvent['visibility'] = { scope: 'team' }): Promise<StreamEvent> {
    const e: StreamEvent = { id: String(this.events.length + 1), topic, at: new Date().toISOString(), payload, visibility };
    this.events.push(e);
    return e;
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async replay(): Promise<StreamEvent[]> {
    return [];
  }
  visibleTo(): boolean {
    return true;
  }
  start(): void {}
  async stop(): Promise<void> {}
}

// --- harness -----------------------------------------------------------------------------------

let root: string;
let f: Foundation;
let repo: GitConfigRepo;
let svc: ConfigServiceImpl;
let bus: FakeBus;

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'bb-config-svc-'));
  const seed = join(root, 'seed');
  for (const [p, content] of Object.entries(fixtureFiles())) {
    await fs.mkdir(join(seed, p, '..'), { recursive: true });
    await fs.writeFile(join(seed, p), content);
  }
  f = await createFoundation();
  repo = createConfigRepo({ dir: join(root, 'repo.git'), cacheDir: join(root, 'trees'), log: f.log });
  await repo.init(seed);
  bus = new FakeBus();
  svc = createConfigService({ repo, db: f.db, team_id: f.team_id, log: f.log, events: bus, gatewayProviders: () => ['bedrock', 'mock'] });
});
afterAll(async () => {
  await f.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function validate(changes: FileChange[]) {
  return svc.validateChanges(changes);
}

describe('ConfigService loaders', () => {
  it('validates the seed tree cleanly (warnings only)', async () => {
    const r = await svc.validateTree();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('loads a circuit with prompts (file + inline), rubric and fixtures at main', async () => {
    const c = await svc.circuit(CIRC);
    expect(c.commit).toBe(await svc.mainCommit());
    expect(c.circuit.slug).toBe('lit-review');
    expect(c.prompts['prompts/gather.md']).toContain('Find sources');
    expect(c.prompts['prompts/summarize.md']).toContain('Summarize');
    expect(c.rubric?.dimensions.map((d) => d.key)).toEqual(['coverage', 'grounded']);
    expect(c.fixtures?.fixtures[0]!.fixture_id).toBe('f1');
    await expect(svc.circuit(mintUid())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('loads settings, presets, tenets, subagents, mcp, and tools (materialized dir)', async () => {
    expect((await svc.settings()).team.name).toBe('Test');
    expect((await svc.settings()).intake.triage_circuit).toBe(CIRC);
    expect(Object.keys((await svc.presets()).presets).sort()).toEqual(['medium', 'small']);
    expect(await svc.tenets()).toBe('Never fabricate data.\n');
    expect((await svc.subagent(SUB_A)).tools).toHaveLength(2);
    expect((await svc.mcp(MCP_A)).endpoint).toBe('https://mcp.example.com/mcp');
    const t = await svc.tool(TOOL_A);
    expect(t.tool.entrypoint).toBe('src/index.ts');
    expect(existsSync(join(t.dir, 'src/index.ts'))).toBe(true);
    expect(t.dir.endsWith(`/tools/${TOOL_A}`)).toBe(true);
    expect(await svc.rubric(CHILD)).toBeNull();
    expect(await svc.fixtures(CHILD)).toBeNull();
  });

  it('lists the tree, searches, resolves definitions by uid or path, and computes backlinks', async () => {
    const tree = await svc.tree();
    expect(tree.map((e) => e.kind)).toEqual(['breadboard', 'tenets', 'presets', 'circuit', 'circuit', 'subagent', 'subagent', 'tool', 'mcp']);
    expect(tree.find((e) => e.kind === 'tenets')!.uid).toBeNull();
    expect(tree.find((e) => e.slug === 'lit-review')!.uid).toBe(CIRC);
    expect((await svc.search('research')).map((e) => e.slug)).toEqual(['research-scout', 'research-writer']);
    expect((await svc.search('Citation')).map((e) => e.uid)).toEqual([TOOL_A]);

    const def = await svc.definition(CIRC);
    expect(def.kind).toBe('circuit');
    expect(def.path).toBe(CONFIG_PATHS.circuit(CIRC));
    expect(Object.keys(def.files!).sort()).toEqual(['fixtures.yaml', 'prompts/gather.md', 'rubric.yaml']);
    expect(def.validation.ok).toBe(true);
    expect(def.referenced_by.map((e) => e.path)).toEqual(['breadboard.yaml']);

    const byPath = await svc.definition(CONFIG_PATHS.subagent(SUB_B));
    expect(byPath.uid).toBe(SUB_B);
    expect((byPath.definition as any).slug).toBe('research-writer');
    expect((await svc.definition(`tools/${TOOL_A}/src/index.ts`)).uid).toBe(TOOL_A);
    // A definition's directory or extensionless name resolves too.
    expect((await svc.definition(`tools/${TOOL_A}`)).uid).toBe(TOOL_A);
    expect((await svc.definition(`circuits/${CIRC}/`)).uid).toBe(CIRC);
    expect((await svc.definition(`subagents/${SUB_B}`)).uid).toBe(SUB_B);
    await expect(svc.definition(`circuits/${TOOL_A}`)).rejects.toMatchObject({ code: 'not-found' });
    expect((await svc.definition('tenets')).raw).toBe('Never fabricate data.\n');
    expect(Object.keys((await svc.definition(TOOL_A)).files!)).toEqual(['src/index.ts']);

    expect((await svc.referencedBy(TOOL_A)).map((e) => e.slug).sort()).toEqual(['lit-review', 'research-scout']);
    expect((await svc.referencedBy(CHILD)).map((e) => e.slug).sort()).toEqual(['lit-review', 'research-writer']);
    expect((await svc.referencedBy(SUB_B)).map((e) => e.path).sort()).toEqual([CONFIG_PATHS.circuit(CHILD), CONFIG_PATHS.circuit(CIRC), CONFIG_PATHS.rubric(CIRC)].sort());
    expect(await svc.referencedBy(MCP_A)).toHaveLength(1);
    await expect(svc.definition(mintUid())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('renders INDEX.md with one table per kind', async () => {
    const idx = await svc.renderIndex();
    expect(idx).toContain('# Configuration index');
    expect(idx).toContain('## Circuits');
    expect(idx).toContain(`| lit-review | Literature review | \`${CIRC}\` | \`circuits/${CIRC}/circuit.yaml\` |`);
    expect(idx).toContain(`| web-search | Web search | \`${MCP_A}\``);
    expect(idx).toContain('`tenets.md` | yes');
  });
});

describe('ConfigService validation rules', () => {
  const err = (r: { errors: string[] }, re: RegExp) => expect(r.errors.some((e) => re.test(e)), `expected ${re} in:\n${r.errors.join('\n')}`).toBe(true);

  it('rejects a file whose name does not match its uid', async () => {
    const other = mintUid();
    const r = await validate([{ path: CONFIG_PATHS.subagent(other), content: subagentYaml(SUB_A, 'clone') }]);
    expect(r.ok).toBe(false);
    err(r, /file name is derived from uid/);
  });

  it('rejects duplicate slugs within a kind and duplicate uids across kinds', async () => {
    const r = await validate([{ path: CONFIG_PATHS.subagent(mintUid()), content: '' }].map((c) => ({ ...c, content: subagentYaml(c.path.slice(10, 30), 'research-scout') })));
    err(r, /duplicate slug 'research-scout'/);
    const dup = await validate([{ path: CONFIG_PATHS.mcp(SUB_A), content: toYaml({ schema: SCHEMA_TAGS.mcp, uid: SUB_A, slug: 'dup', title: 'dup', transport: 'http', endpoint: 'https://x.example/mcp' }) }]);
    err(dup, /duplicate uid/);
  });

  it('rejects dangling references of every kind and flags unknown files as warnings', async () => {
    const ghost = mintUid();
    const r = await validate([
      { path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { tools: [{ tool: ghost }], circuits: [{ circuit: ghost, access: 'read' }] }) },
      { path: 'README.md', content: 'hi' },
    ]);
    err(r, new RegExp(`tool grant references tool '${ghost}'`));
    err(r, new RegExp(`circuit grant \\(read\\) references circuit '${ghost}'`));
    expect(r.warnings.some((w) => w.startsWith('README.md:'))).toBe(true);
    // Kind mismatch is also an error.
    const wrong = await validate([{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { tools: [{ tool: SUB_A }] }) }]);
    err(wrong, /is a subagent, not a tool/);
    const bb = await validate([{ path: 'breadboard.yaml', content: toYaml({ schema: SCHEMA_TAGS.breadboard, intake: { triage_circuit: ghost } }) }]);
    err(bb, /intake\.triage_circuit references circuit/);
  });

  it('enforces circuit graph rules', async () => {
    const steps = (): any[] => JSON.parse(JSON.stringify((parseYaml(circuitYaml()) as any).steps));
    // missing exit target
    let s = steps();
    s[0].exits[0].to = 'nowhere';
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /routes to unknown step 'nowhere'/);
    // undeclared $exit
    s = steps();
    s[5].exits[0].to = '$exit.nope';
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /undeclared circuit exit '\$exit\.nope'/);
    // declared exit not routable
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ exits: [{ name: 'done' }, { name: 'empty' }, { name: 'lonely' }] }) }]), /declared exit 'lonely' is not routable-to/);
    // gate missing changes
    s = steps();
    s[4].exits = [{ name: 'approve', to: '$exit.done' }];
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /gate 'gate' must declare a 'changes' exit/);
    // unreachable step: error on main, warning for a proposal branch
    s = steps();
    s[0].exits = [{ name: 'found-sources', to: 'summarize' }];
    const unreachable = circuitYaml({ steps: s, exits: [{ name: 'done' }] });
    s[5].exits[0].to = '$exit.done';
    const unreachable2 = circuitYaml({ steps: s, exits: [{ name: 'done' }] });
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: unreachable2 }]), /step 'report-empty' is unreachable/);
    const wip = await svc.validateChanges([{ path: CONFIG_PATHS.circuit(CIRC), content: unreachable2 }], undefined, { nonMain: true });
    expect(wip.ok).toBe(true);
    expect(wip.warnings.some((w) => /unreachable/.test(w))).toBe(true);
    void unreachable;
    // entry must exist; duplicate step ids
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ entry: 'ghost' }) }]), /entry 'ghost' is not a step/);
    s = steps();
    s[5].id = 'gather';
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /duplicate step id 'gather'/);
    // llm prompt file must exist; template step refs must exist
    s = steps();
    s[0].prompt = 'prompts/missing.md';
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /prompt file 'prompts\/missing.md' does not exist/);
    s = steps();
    s[1].prompt_inline = 'Use {{steps.ghost.output}}';
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /prompt references unknown step '\$steps\.ghost'/);
    err(await validate([{ path: CONFIG_PATHS.circuitPrompt(CIRC, 'gather'), content: '{{steps.nope.x}}' }]), /step 'gather' prompt references unknown step/);
    // input_map step refs
    s = steps();
    s[2].input_map = { artifact: '$steps.phantom.output.x' };
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /input_map references unknown step 'phantom'/);
    // output schema must compile
    s = steps();
    s[1].output = { type: 'object', properties: { x: { type: 'not-a-type' } } };
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /output schema does not compile/);
    // sub-circuit exits must map 1:1 onto the child's declared exits
    s = steps();
    s[3].exit_map = { bogus: 'proceed' };
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /exit_map key 'bogus' is not an exit of sub-circuit/);
    s = steps();
    s[3].exit_map = undefined;
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /missing exit 'ok' required by sub-circuit/);
    s = steps();
    s[3].exits.push({ name: 'extra', to: 'gate' });
    err(await validate([{ path: CONFIG_PATHS.circuit(CIRC), content: circuitYaml({ steps: s }) }]), /exit 'extra' has no corresponding exit on sub-circuit/);
  });

  it('enforces subagent, preset, tenets, rubric, fixtures, and tool rules', async () => {
    err(await validate([{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { model_preset: 'huge' }) }]), /model_preset 'huge' is not defined/);
    err(await validate([{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { system_prompt: 'Read {{knowledge:not-a-uid}}' }) }]), /not a valid 20-char UID/);
    const okTok = await validate([{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { system_prompt: `Read {{knowledge:${mintUid()}}}` }) }]);
    expect(okTok.ok).toBe(true);
    expect(okTok.warnings.some((w) => /not verified against readable domains/.test(w))).toBe(true);
    err(await validate([{ path: CONFIG_PATHS.presets, content: toYaml({ schema: SCHEMA_TAGS.presets, presets: { medium: [{ provider: 'openai', model_id: 'gpt' }] } }) }]), /provider 'openai' has no installed adapter/);
    err(await validate([{ path: CONFIG_PATHS.tenets, content: 'x'.repeat(201) }]), /tenets are 201 characters; the cap is 200/);
    expect((await validate([{ path: CONFIG_PATHS.tenets, content: 'x'.repeat(200) }])).ok).toBe(true);
    err(await validate([{ path: CONFIG_PATHS.rubric(CIRC), content: toYaml({ schema: SCHEMA_TAGS.rubric, circuit: CHILD, judge: { subagent: mintUid(), model_id: 'm' }, dimensions: [{ key: 'a', type: 'boolean', prompt: 'p' }], aggregate: { weights: { zzz: 1 } } }) }]), /'circuit' must be the enclosing circuit UID/);
    err(await validate([{ path: CONFIG_PATHS.rubric(CIRC), content: toYaml({ schema: SCHEMA_TAGS.rubric, circuit: CIRC, judge: { subagent: mintUid(), model_id: 'm' }, dimensions: [{ key: 'a', type: 'boolean', prompt: 'p' }], aggregate: { weights: { zzz: 1 } } }) }]), /judge subagent references subagent/);
    err(await validate([{ path: CONFIG_PATHS.rubric(CIRC), content: toYaml({ schema: SCHEMA_TAGS.rubric, circuit: CIRC, judge: { subagent: SUB_B, model_id: 'm' }, dimensions: [{ key: 'a', type: 'boolean', prompt: 'p' }], aggregate: { weights: { zzz: 1 } } }) }]), /weights refers to unknown dimension 'zzz'/);
    err(await validate([{ path: CONFIG_PATHS.fixtures(CIRC), content: toYaml({ schema: SCHEMA_TAGS.fixtures, circuit: CHILD, fixtures: [] }) }]), /'circuit' must be the enclosing circuit UID/);
    err(await validate([{ path: `${CONFIG_PATHS.toolDir(TOOL_A)}/src/index.ts`, content: null }]), /entrypoint 'src\/index.ts' does not exist/);
    const oddPath = await validate([{ path: 'subagents/not-a-uid.yaml', content: 'x' }]);
    expect(oddPath.ok).toBe(true);
    expect(oddPath.warnings.some((w) => w.startsWith('subagents/not-a-uid.yaml:'))).toBe(true);
  });

  it('rejects schema-invalid documents and bad YAML with the path prefixed', async () => {
    const r = await validate([{ path: CONFIG_PATHS.subagent(SUB_A), content: 'schema: breadboard/subagent@v1\nuid: ' + SUB_A + '\nslug: Bad Slug\ntitle: x\n' }]);
    expect(r.errors.some((e) => e.startsWith(`${CONFIG_PATHS.subagent(SUB_A)}: `) && /slug|model_preset/.test(e))).toBe(true);
    const y = await validate([{ path: CONFIG_PATHS.mcp(MCP_A), content: 'a: [unclosed' }]);
    err(y, /yaml parse error/);
  });

  it('rejects deleting a uid that is still referenced, and a uid vanishing without an explicit delete', async () => {
    const del = await validate([{ path: CONFIG_PATHS.tool(TOOL_A), content: null }]);
    err(del, /cannot delete tool 'check-citations'; still referenced by/);
    const vanish = await validate([{ path: CONFIG_PATHS.mcp(MCP_A), content: toYaml({ schema: SCHEMA_TAGS.mcp, uid: mintUid(), slug: 'web-search', title: 'x', transport: 'http', endpoint: 'https://x.example/mcp' }) }]);
    err(vanish, /file name is derived from uid/);
    err(vanish, /would disappear from the tree without an explicit delete/);
    // An explicit delete of an unreferenced definition is fine once its referrer is updated in the same change set.
    const ok = await validate([
      { path: CONFIG_PATHS.mcp(MCP_A), content: null },
      { path: CONFIG_PATHS.subagent(SUB_A), content: subagentYaml(SUB_A, 'research-scout', { tools: [{ tool: TOOL_A }], knowledge: { read: ['research'], write: [] } }) },
    ]);
    expect(ok.errors).toEqual([]);
  });
});

describe('ConfigService proposals and commits', () => {
  it('propose → get → merge round trip regenerates INDEX.md, advances main, and emits config.committed', async () => {
    const before = await svc.mainCommit();
    const NEW = mintUid();
    const changes: FileChange[] = [{ path: CONFIG_PATHS.subagent(NEW), content: subagentYaml(NEW, 'critic', { system_prompt: 'You critique.' }) }];
    const p = await svc.propose({ changes, message: 'Add critic subagent', by: f.memberPrincipal, session_id: null });
    expect(p.status).toBe('open');
    expect(p.branch).toBe(`proposals/${p.proposal_id}`);
    expect(p.base_commit).toBe(before);
    expect(p.changes).toEqual([{ path: CONFIG_PATHS.subagent(NEW), status: 'added' }]);
    expect(p.diff).toContain('+slug: critic');
    expect(p.validation.ok).toBe(true);
    expect(await repo.branchExists(p.branch)).toBe(true);
    expect(await svc.mainCommit()).toBe(before);
    expect((await svc.listProposals({ status: 'open' })).map((x) => x.proposal_id)).toContain(p.proposal_id);
    // Branch reads work before merge ([01] §6.3 branch execution).
    expect((await svc.subagent(NEW, p.branch)).slug).toBe('critic');
    await expect(svc.subagent(NEW)).rejects.toMatchObject({ code: 'not-found' });

    const got = await svc.getProposal(p.proposal_id);
    expect(got.head_commit).toBe(p.head_commit);

    const amended = await svc.amendProposal(p.proposal_id, [{ path: CONFIG_PATHS.subagent(NEW), content: subagentYaml(NEW, 'critic', { system_prompt: 'You critique kindly.' }) }], 'soften', f.memberPrincipal);
    expect(amended.head_commit).not.toBe(p.head_commit);
    expect(amended.diff).toContain('critique kindly');

    await svc.attachEvalRun(p.proposal_id, 'evr_1');
    const merged = await svc.mergeProposal(p.proposal_id, f.memberPrincipal);
    expect(merged.status).toBe('merged');
    expect(merged.eval_runs).toEqual(['evr_1']);
    const after = await svc.mainCommit();
    expect(after).not.toBe(before);
    expect(merged.merged_commit).toBe(after);
    expect((await svc.subagent(NEW)).system_prompt).toBe('You critique kindly.');
    const index = await repo.readFile(after, 'INDEX.md');
    expect(index).toContain(`| critic | critic | \`${NEW}\``);
    expect(index).toBe(await svc.renderIndex());
    expect(await repo.branchExists(p.branch)).toBe(false);
    expect(bus.events.filter((e) => e.topic === 'config.committed' && e.payload.proposal_id === p.proposal_id)).toHaveLength(1);
    await expect(svc.mergeProposal(p.proposal_id, f.memberPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
    const hist = await svc.history({ limit: 4 });
    expect(hist.map((h) => h.message)).toEqual(['Regenerate INDEX.md', 'soften', 'Add critic subagent', 'Seed configuration from ' + join(root, 'seed')]);
    expect(hist[2]!.author).toBe('Member <member@breadboard.local>');
  });

  it('rejects invalid proposals and amendments up front', async () => {
    await expect(svc.propose({ changes: [{ path: CONFIG_PATHS.tool(TOOL_A), content: null }], message: 'rm tool', by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.propose({ changes: [], message: 'empty', by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    expect((await svc.listProposals()).every((p) => p.status !== 'open')).toBe(true);
  });

  it('discard deletes the branch and marks the proposal', async () => {
    const NEW = mintUid();
    const p = await svc.propose({ changes: [{ path: CONFIG_PATHS.mcp(NEW), content: toYaml({ schema: SCHEMA_TAGS.mcp, uid: NEW, slug: 'tmp', title: 'tmp', transport: 'http', endpoint: 'https://x.example/mcp' }) }], message: 'tmp', by: f.adminPrincipal });
    const d = await svc.discardProposal(p.proposal_id, f.adminPrincipal);
    expect(d.status).toBe('discarded');
    expect(await repo.branchExists(p.branch)).toBe(false);
    expect((await svc.listProposals({ status: 'discarded' })).map((x) => x.proposal_id)).toContain(p.proposal_id);
    await expect(svc.amendProposal(p.proposal_id, [], 'x', f.adminPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(svc.getProposal('prp_nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('merges a proposal after main moved (real merge) and reports textual conflicts', async () => {
    const base = await svc.mainCommit();
    const p = await svc.propose({ changes: [{ path: CONFIG_PATHS.tenets, content: 'Cite primary sources.\n' }], message: 'tenets', by: f.memberPrincipal });
    const direct = await svc.commitDirect({ changes: [{ path: CONFIG_PATHS.circuitPrompt(CIRC, 'gather'), content: 'Find sources for {{input.question}}.\n' }], message: 'tweak prompt', by: f.memberPrincipal });
    expect(direct.commit).not.toBe(base);
    expect(await svc.mainCommit()).toBe(direct.commit);
    const merged = await svc.mergeProposal(p.proposal_id, f.memberPrincipal);
    expect(merged.status).toBe('merged');
    expect(await svc.tenets()).toBe('Cite primary sources.\n');
    expect(await repo.readFile(await svc.mainCommit(), CONFIG_PATHS.circuitPrompt(CIRC, 'gather'))).toBe('Find sources for {{input.question}}.\n');

    const conflicting = await svc.propose({ changes: [{ path: CONFIG_PATHS.tenets, content: 'Branch tenets.\n' }], message: 'branch tenets', by: f.memberPrincipal });
    await svc.commitDirect({ changes: [{ path: CONFIG_PATHS.tenets, content: 'Main tenets.\n' }], message: 'main tenets', by: f.memberPrincipal });
    await expect(svc.mergeProposal(conflicting.proposal_id, f.memberPrincipal)).rejects.toMatchObject({ code: 'conflict', detail: { conflicts: ['tenets.md'] } });
    expect((await svc.getProposal(conflicting.proposal_id)).status).toBe('open');
    expect(await svc.tenets()).toBe('Main tenets.\n');
    await svc.discardProposal(conflicting.proposal_id, f.memberPrincipal);
  });

  it('refuses to merge a proposal that main has semantically invalidated, without touching main', async () => {
    const SUB_NEW = mintUid();
    // Proposal: a new subagent with slug 'temp-agent'.
    const p = await svc.propose({ changes: [{ path: CONFIG_PATHS.subagent(SUB_NEW), content: subagentYaml(SUB_NEW, 'temp-agent') }], message: 'add temp agent', by: f.memberPrincipal });
    // Main: an existing subagent takes the slug 'temp-agent' — no textual conflict, but a duplicate slug after merge.
    const main = await svc.commitDirect({
      changes: [{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'temp-agent', { circuits: [{ circuit: CHILD, access: 'execute' }] }) }],
      message: 'rename writer',
      by: f.adminPrincipal,
    });
    await expect(svc.mergeProposal(p.proposal_id, f.memberPrincipal)).rejects.toMatchObject({ code: 'validation-failed' });
    expect(await svc.mainCommit()).toBe(main.commit);
    expect((await svc.getProposal(p.proposal_id)).status).toBe('open');
    await svc.discardProposal(p.proposal_id, f.memberPrincipal);
    // Restore the slug so later tests see the seed names.
    await svc.commitDirect({ changes: [{ path: CONFIG_PATHS.subagent(SUB_B), content: subagentYaml(SUB_B, 'research-writer', { circuits: [{ circuit: CHILD, access: 'execute' }] }) }], message: 'restore writer', by: f.adminPrincipal });
  });

  it('commitDirect validates, writes INDEX.md in the same commit, and revert restores a path', async () => {
    const before = await svc.mainCommit();
    await expect(svc.commitDirect({ changes: [{ path: CONFIG_PATHS.tenets, content: 'y'.repeat(500) }], message: 'too long', by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    expect(await svc.mainCommit()).toBe(before);
    const NEW = mintUid();
    const r = await svc.commitDirect({ changes: [{ path: CONFIG_PATHS.mcp(NEW), content: toYaml({ schema: SCHEMA_TAGS.mcp, uid: NEW, slug: 'files', title: 'Files', transport: 'stdio', command: 'mcp-files' }) }], message: 'add files mcp', by: f.memberPrincipal });
    expect((await repo.diff(before, r.commit)).files.map((x) => x.path).sort()).toEqual(['INDEX.md', CONFIG_PATHS.mcp(NEW)].sort());
    expect(await repo.readFile(r.commit, 'INDEX.md')).toContain('| files | Files |');
    // Revert the tenets file to its content at `before`.
    const tenetsBefore = await svc.tenets(before);
    await svc.commitDirect({ changes: [{ path: CONFIG_PATHS.tenets, content: 'Changed.\n' }], message: 'change tenets', by: f.memberPrincipal });
    const rv = await svc.revert({ path: CONFIG_PATHS.tenets, to_commit: before, by: f.memberPrincipal });
    expect(await svc.mainCommit()).toBe(rv.commit);
    expect(await svc.tenets()).toBe(tenetsBefore);
    expect((await svc.history({ path: CONFIG_PATHS.tenets, limit: 1 }))[0]!.message).toContain('Revert tenets.md');
    expect(bus.events.filter((e) => e.payload.kind === 'revert')).toHaveLength(1);
  });

  it('mainCommit re-resolves after the TTL when the bare repo is pushed to directly', async () => {
    const cached = await svc.mainCommit();
    const external = await repo.commit({ branch: 'main', changes: [{ path: 'tenets.md', content: 'External edit.\n' }], message: 'external', author: { name: 'Admin', email: 'a@x' } });
    expect(await svc.mainCommit()).toBe(cached); // within TTL
    await new Promise((r) => setTimeout(r, 5_100));
    expect(await svc.mainCommit()).toBe(external);
  });

  it('mints skeletons that are schema-valid and (except the circuit placeholder) tree-valid', async () => {
    const sub = svc.newDefinitionSkeleton('subagent', 'reviewer', 'Reviewer');
    expect(sub).toHaveLength(1);
    expect((await validate(sub)).ok).toBe(true);
    const tool = svc.newDefinitionSkeleton('tool', 'echo', 'Echo');
    expect(tool.map((c) => c.path.split('/').slice(2).join('/'))).toEqual(['tool.yaml', 'src/index.ts']);
    expect(tool[1]!.content).toContain("from '@breadboard/sandbox-runtime'");
    expect((await validate(tool)).ok).toBe(true);
    const py = svc.newDefinitionSkeleton('tool', 'echo-py', 'Echo', { language: 'python' });
    expect(py[1]!.path.endsWith('src/main.py')).toBe(true);
    expect(py[1]!.content).toContain('def handler(input, ctx)');
    expect((await validate(py)).ok).toBe(true);
    const mcp = svc.newDefinitionSkeleton('mcp', 'jira', 'Jira');
    expect((await validate(mcp)).ok).toBe(true);
    const circ = svc.newDefinitionSkeleton('circuit', 'triage', 'Triage', { subagent: SUB_A });
    expect(circ.map((c) => c.path.split('/').slice(2).join('/'))).toEqual(['circuit.yaml', 'prompts/draft.md']);
    expect((await validate(circ)).ok).toBe(true);
    const placeholder = svc.newDefinitionSkeleton('circuit', 'triage2', 'Triage 2');
    const r = await validate(placeholder);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /references subagent '00000000000000000000'/.test(e))).toBe(true);
  });
});
