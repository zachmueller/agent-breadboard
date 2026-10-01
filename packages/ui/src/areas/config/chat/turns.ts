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
