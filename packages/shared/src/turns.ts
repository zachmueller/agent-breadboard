/**
 * Normalised view of a turn's `content` ([02] §3): text, tool calls and tool results. Tolerates
 * Anthropic-style (`tool_use` / `tool_result`) and Bedrock Converse-style (`toolUse` / `toolResult`)
 * blocks, plain strings and `{text}`. Shared by the UI's turn renderer and the MCP transcript tool,
 * so both agree on what a turn contains.
 */
export type TurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id?: string; name: string; input: unknown }
  | { kind: 'tool_result'; id?: string; content: unknown; is_error?: boolean }
  | { kind: 'other'; value: unknown };

export function toBlocks(content: unknown): TurnBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.flatMap(toBlocks);
  if (typeof content !== 'object') return [{ kind: 'text', text: String(content) }];
  const o = content as Record<string, unknown>;
  if (o.type === 'text' || (typeof o.text === 'string' && Object.keys(o).length <= 2)) return [{ kind: 'text', text: String(o.text ?? '') }];
  if (o.type === 'tool_use' || o.type === 'tool-call' || o.type === 'tool_call') return [{ kind: 'tool_use', id: o.id as string, name: String(o.name ?? 'tool'), input: o.input ?? o.arguments }];
  if (o.toolUse && typeof o.toolUse === 'object') {
    const t = o.toolUse as Record<string, unknown>;
    return [{ kind: 'tool_use', id: t.toolUseId as string, name: String(t.name ?? 'tool'), input: t.input }];
  }
  if (o.type === 'tool_result' || o.type === 'tool-result') return [{ kind: 'tool_result', id: (o.tool_use_id ?? o.id) as string, content: o.content ?? o.output, is_error: !!o.is_error }];
  if (o.toolResult && typeof o.toolResult === 'object') {
    const t = o.toolResult as Record<string, unknown>;
    return [{ kind: 'tool_result', id: t.toolUseId as string, content: t.content, is_error: t.status === 'error' }];
  }
  if (Array.isArray(o.content)) return toBlocks(o.content);
  if (typeof o.content === 'string') return [{ kind: 'text', text: o.content }];
  if (Array.isArray(o.tool_calls)) {
    const text = typeof o.text === 'string' && o.text ? [{ kind: 'text' as const, text: o.text }] : [];
    return [...text, ...(o.tool_calls as Array<Record<string, unknown>>).map((t) => ({ kind: 'tool_use' as const, id: t.id as string, name: String(t.name ?? 'tool'), input: t.input ?? t.arguments }))];
  }
  return [{ kind: 'other', value: content }];
}

/** The plain text of a tool result when it is a string or a list of `{text}` parts; null otherwise. */
export function resultText(c: unknown): string | null {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string')) return c.map((x) => (x as { text: string }).text).join('\n');
  return null;
}
