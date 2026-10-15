/** Normalize conversation turn content (string | content blocks) for rendering. Pure. */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: unknown; is_error: boolean };

export function blocksOf(content: unknown): ChatBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) {
    const c = content as any;
    if (typeof c.text === 'string') return [{ type: 'text', text: c.text }];
    if (Array.isArray(c.content)) return blocksOf(c.content);
    return [{ type: 'text', text: '```json\n' + JSON.stringify(content, null, 2) + '\n```' }];
  }
  const out: ChatBlock[] = [];
  for (const b of content as any[]) {
    if (typeof b === 'string') {
      if (b.trim()) out.push({ type: 'text', text: b });
    } else if (b?.type === 'text' && typeof b.text === 'string') {
      if (b.text.trim()) out.push({ type: 'text', text: b.text });
    } else if (b?.type === 'tool_use' || b?.type === 'tool_call') {
      out.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), input: b.input ?? b.arguments ?? null });
    } else if (b?.type === 'tool_result') {
      out.push({ type: 'tool_result', id: String(b.tool_use_id ?? b.id ?? ''), content: b.content ?? b.output ?? null, is_error: !!b.is_error });
    }
  }
  return out;
}

/** Text of a tool result, for the collapsed preview. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  return JSON.stringify(content, null, 2);
}

export const PROPOSE_TOOL = 'propose_config_change';

/** What one `propose_config_change` call came back with: a proposal id, or the error that stopped it. */
export interface ProposeOutcome {
  /** Index of the turn holding the result. */
  turn: number;
  tool_use_id: string;
  proposal_id: string | null;
  amended: boolean;
  error: string | null;
}

/** tool_use id → tool name across the transcript (results only carry the id). */
export function toolNamesById(turns: Array<{ content: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of turns) for (const b of blocksOf(t.content)) if (b.type === 'tool_use') out.set(b.id, b.name);
  return out;
}

const PROPOSAL_ID = /"proposal_id"\s*:\s*"(prp_[0-9A-Za-z]+)"/;

/** The proposal id in a propose result. Results can be capped mid-JSON, so this matches text instead of parsing it. */
export function proposalIdOf(content: unknown): string | null {
  return PROPOSAL_ID.exec(resultText(content))?.[1] ?? null;
}

/** Every `propose_config_change` result in the transcript, in order. */
export function proposeOutcomes(turns: Array<{ content: unknown }>): ProposeOutcome[] {
  const names = toolNamesById(turns);
  const inputs = new Map<string, unknown>();
  for (const t of turns) for (const b of blocksOf(t.content)) if (b.type === 'tool_use') inputs.set(b.id, b.input);
  const out: ProposeOutcome[] = [];
  turns.forEach((t, i) => {
    for (const b of blocksOf(t.content)) {
      if (b.type !== 'tool_result' || names.get(b.id) !== PROPOSE_TOOL) continue;
      const amended = typeof (inputs.get(b.id) as { proposal_id?: unknown } | undefined)?.proposal_id === 'string';
      if (b.is_error) out.push({ turn: i, tool_use_id: b.id, proposal_id: null, amended, error: resultText(b.content).replace(/^Error \(([^)]+)\):\s*/, '') || 'the call failed' });
      else out.push({ turn: i, tool_use_id: b.id, proposal_id: proposalIdOf(b.content), amended, error: null });
    }
  });
  return out;
}

/**
 * Where each proposal card goes: after the turn of the session's latest result for it (an amendment moves the
 * card down to where the conversation is). Ids the transcript does not show yet go at the end (index = turns.length).
 */
export function placeProposals(turns: Array<{ content: unknown }>, ids: string[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const o of proposeOutcomes(turns)) if (o.proposal_id) at.set(o.proposal_id, o.turn + 1);
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, at.get(id) ?? turns.length);
  return out;
}

/** Why a conversation no longer takes messages, to follow "This conversation has …". Null while it is running. */
export function conversationEnded(state: string | null, reason: string | null): string | null {
  if (!state || state === 'running') return null;
  if (reason === 'budget-exceeded') return 'stopped at its budget';
  if (state === 'suspended-error') return 'stopped on an error';
  if (state === 'cancelled') return 'been cancelled';
  return `ended (${state})`;
}
