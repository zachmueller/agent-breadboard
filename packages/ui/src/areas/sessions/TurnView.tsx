/**
 * Renders model conversation turns ([02] §8): text, tool calls (expandable), tool results, and
 * per-turn model id / tokens / cost. Content is normalised by `toBlocks` from @breadboard/shared,
 * which the MCP transcript tool uses too.
 */
import { useState } from 'react';
import { Bot, ChevronRight, CornerDownRight, Cpu, User, Wrench, AlertTriangle, Settings2 } from 'lucide-react';
import { resultText, toBlocks, type Turn, type TurnBlock as Block } from '@breadboard/shared';

// Re-exported for the Intake chat and the sessions barrel, which normalise turns the same way.
export { toBlocks };
import { formatCost, formatDuration, formatTokens } from '../../lib/format';
import { Badge, JsonView, Markdown, Tooltip, cn } from '../../components';

export type TurnLike = Turn & { attempt?: number; latency_ms?: number | null; fallback_from?: string | null };

function ToolCall({ block, result }: { block: Extract<Block, { kind: 'tool_use' }>; result?: Extract<Block, { kind: 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-line bg-sunken">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover">
        <ChevronRight size={13} className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')} aria-hidden />
        <Wrench size={13} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="font-mono font-medium">{block.name}</span>
        {result && (result.is_error ? <Badge tone="danger" size="xs">error</Badge> : <Badge tone="ok" size="xs">ok</Badge>)}
        {!open && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-subtle">{JSON.stringify(block.input ?? {})}</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Input</div>
            <JsonView value={block.input ?? {}} defaultExpandDepth={2} maxHeight="320px" />
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Result</div>
              <ToolResultBody block={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultBody({ block }: { block: Extract<Block, { kind: 'tool_result' }> }) {
  const t = resultText(block.content);
  if (t !== null) {
    try {
      return <JsonView value={JSON.parse(t)} defaultExpandDepth={1} maxHeight="320px" />;
    } catch {
      return <pre className={cn('max-h-80 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 font-mono text-[12px]', block.is_error && 'text-danger-fg')}>{t}</pre>;
    }
  }
  return <JsonView value={block.content} defaultExpandDepth={1} maxHeight="320px" />;
}

const ROLE = {
  system: { icon: Settings2, label: 'System' },
  user: { icon: User, label: 'User' },
  assistant: { icon: Bot, label: 'Assistant' },
  tool: { icon: CornerDownRight, label: 'Tool results' },
} as const;

/** One turn. `results` maps tool_use id → result block found in later turns, so calls show their outcome inline. */
export function TurnItem({ turn, results }: { turn: TurnLike; results?: Map<string, Extract<Block, { kind: 'tool_result' }>> }) {
  const [showSystem, setShowSystem] = useState(false);
  const blocks = toBlocks(turn.content);
  const r = ROLE[turn.role as keyof typeof ROLE] ?? ROLE.assistant;
  const Icon = r.icon;
  // A tool turn whose results are already shown inline under the calls collapses to a hint.
  const allInline = turn.role === 'tool' && results && blocks.every((b) => b.kind === 'tool_result' && b.id && results.has(b.id));
  if (allInline) return null;
  const isSystem = turn.role === 'system';
  return (
    <div className={cn('flex gap-3', turn.role === 'user' && 'rounded-lg bg-sunken/60 -mx-2 px-2 py-2')}>
      <div className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', turn.role === 'assistant' ? 'bg-accent-soft text-accent-text' : 'bg-raised text-fg-muted')}>
        <Icon size={13} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-subtle">
          <span className="font-medium text-fg-muted">{turn.username ? `@${turn.username}` : r.label}</span>
          {turn.model_id && (
            <span className="inline-flex items-center gap-1 font-mono">
              <Cpu size={11} aria-hidden />
              {turn.model_id}
            </span>
          )}
          {turn.fallback_from && (
            <Tooltip content={`Served by fallback after ${turn.fallback_from} failed`}>
              <Badge tone="warn" size="xs" icon={<AlertTriangle size={10} />}>
                fallback
              </Badge>
            </Tooltip>
          )}
          {(turn.tokens_in ?? 0) + (turn.tokens_out ?? 0) > 0 && (
            <span className="tabular">
              {formatTokens(turn.tokens_in)} in · {formatTokens(turn.tokens_out)} out
            </span>
          )}
          {turn.cost_usd ? <span className="tabular">{formatCost(turn.cost_usd)}</span> : null}
          {turn.latency_ms ? <span className="tabular">{formatDuration(turn.latency_ms)}</span> : null}
          {turn.attempt && turn.attempt > 1 ? <Badge size="xs">attempt {turn.attempt}</Badge> : null}
        </div>
        {isSystem && !showSystem ? (
          <button type="button" onClick={() => setShowSystem(true)} className="text-[12.5px] text-accent-text hover:underline">
            Show system prompt ({blocks.reduce((a, b) => a + (b.kind === 'text' ? b.text.length : 0), 0).toLocaleString()} chars)
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {blocks.map((b, i) => {
              if (b.kind === 'text') return b.text.trim() ? <Markdown key={i} source={b.text} size="sm" /> : null;
              if (b.kind === 'tool_use') return <ToolCall key={i} block={b} result={b.id ? results?.get(b.id) : undefined} />;
              if (b.kind === 'tool_result')
                return (
                  <div key={i} className="rounded-md border border-line bg-sunken px-2.5 py-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Tool result{b.is_error ? ' · error' : ''}</div>
                    <ToolResultBody block={b} />
                  </div>
                );
              return <JsonView key={i} value={b.value} defaultExpandDepth={1} maxHeight="320px" />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A list of turns with tool results folded under their calls. */
export function TurnList({ turns }: { turns: TurnLike[] }) {
  const results = new Map<string, Extract<Block, { kind: 'tool_result' }>>();
  for (const t of turns) for (const b of toBlocks(t.content)) if (b.kind === 'tool_result' && b.id) results.set(b.id, b);
  return (
    <div className="flex flex-col gap-4">
      {turns.map((t) => (
        <TurnItem key={t.turn_id} turn={t} results={results} />
      ))}
    </div>
  );
}
