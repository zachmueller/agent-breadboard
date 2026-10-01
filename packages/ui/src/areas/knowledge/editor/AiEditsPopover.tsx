/**
 * AI-edit revert ([07] §5.3): every AI write cuts a `pre-ai-edit` revision first; reverting one
 * applies the server-computed reverse delta as a new change (history is never rewritten).
 */
import { useEffect, useRef, useState } from 'react';
import { Bot, GitCompareArrows, Undo2 } from 'lucide-react';
import type { NodeRevision } from '@breadboard/shared';
import { toast } from '../../../lib/toast';
import { formatDateTime } from '../../../lib/format';
import { ActorLabel, Badge, Button, ConfirmDialog, EmptyState, ErrorState, Spinner, cn } from '../../../components';
import { afterRevision, aiEditRevisions, revLabel } from './revisionDiff';
import { useRevertAiEdit } from './mutations';
import { useSortedRevisions } from './RevisionsPanel';

export function AiEditsPopover({ uid, readOnly, onCompare }: { uid: string; readOnly: boolean; onCompare: (pair: [number, number]) => void }) {
  const list = useSortedRevisions(uid);
  const edits = aiEditRevisions(list.items);
  const [open, setOpen] = useState(false);
  const [reverting, setReverting] = useState<NodeRevision | null>(null);
  const revert = useRevertAiEdit(uid);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <Button size="xs" variant="ghost" icon={<Bot size={14} />} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        AI edits
        {edits.length > 0 && (
          <Badge size="xs" tone="info" className="ml-0.5">
            {edits.length}
          </Badge>
        )}
      </Button>
      {open && (
        <div ref={panel} role="dialog" aria-label="AI edits" className="absolute right-0 top-full z-30 mt-1 w-[22rem] overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
          <div className="border-b border-line px-3 py-2">
            <div className="text-[13px] font-semibold">AI edits</div>
            <div className="text-xs text-fg-subtle">Each AI write can be reverted in one click. The revert is applied as a new change.</div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {list.isPending ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : list.error ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} compact className="m-3" />
            ) : !edits.length ? (
              <EmptyState compact icon={<Bot size={18} />} title="No AI edits" description="When a subagent edits this note, its write shows up here." />
            ) : (
              <ul className="flex flex-col">
                {edits.map((r) => (
                  <li key={r.revision_id} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px]">
                        AI write after <span className="font-mono font-medium">{revLabel(r.revision_id)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-fg-subtle">
                        <ActorLabel actor={r.created_by} icon={false} />
                        <span aria-hidden>·</span>
                        <span>{formatDateTime(r.created_at)}</span>
                      </div>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<GitCompareArrows size={13} />}
                      onClick={() => {
                        setOpen(false);
                        onCompare([r.revision_id, afterRevision(list.items, r.revision_id)]);
                      }}
                    >
                      Diff
                    </Button>
                    <Button size="xs" variant="secondary" icon={<Undo2 size={13} />} disabled={readOnly} className={cn(readOnly && 'opacity-60')} onClick={() => setReverting(r)}>
                      Revert
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!reverting}
        onClose={() => setReverting(null)}
        title="Revert this AI edit?"
        description={reverting ? `Undo the AI write made after ${revLabel(reverting.revision_id)}. Later edits by others are kept where they don’t conflict.` : undefined}
        confirmLabel="Revert edit"
        variant="danger"
        loading={revert.isPending}
        onConfirm={async () => {
          if (!reverting) return;
          try {
            await revert.mutateAsync(reverting.revision_id);
            toast.success('AI edit reverted');
            setReverting(null);
            setOpen(false);
          } catch (e) {
            toast.error('Revert failed', e);
          }
        }}
      />
    </div>
  );
}
