/** Form-level diff for Subagent history and designer-chat proposals ([05] §6): grant changes first, then the prompt, then raw YAML. */
import { Plus, Minus, PenLine } from 'lucide-react';
import type { DiffRenderer, Snapshot } from '../components/snapshot';
import { MultiFileDiff, TextDiff } from '../components/Diff';
import { useTreeIndex } from '../lib/configApi';
import { subagentFieldDiff, type FieldChange } from './model';

const ICON = { added: Plus, removed: Minus, changed: PenLine } as const;
const LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;
const CLS = { added: 'text-ok-fg', removed: 'text-danger-fg', changed: 'text-info-fg' } as const;

export function FieldChanges({ changes, empty }: { changes: FieldChange[]; empty?: string }) {
  if (!changes.length) return empty ? <div className="text-xs text-fg-subtle">{empty}</div> : null;
  return (
    <ul className="space-y-1 text-xs">
      {changes.map((c, i) => {
        const I = ICON[c.kind];
        return (
          <li key={i} className="flex items-start gap-1.5">
            <I className={`mt-0.5 size-3.5 shrink-0 ${CLS[c.kind]}`} aria-hidden />
            <span className={`w-16 shrink-0 font-medium ${CLS[c.kind]}`}>{LABEL[c.kind]}</span>
            <span className="shrink-0 rounded bg-sunken px-1 font-mono text-[10px] text-fg-muted">{c.field}</span>
            <span className="break-all">{c.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function SubagentDiff({ base, next }: { base: Snapshot; next: Snapshot }) {
  const idx = useTreeIndex();
  const label = (kind: string, uid: string) => idx.get(kind, uid)?.slug ?? uid;
  const changes = subagentFieldDiff(base.parsed, next.parsed, label);
  const bp = String(base.parsed?.system_prompt ?? '');
  const np = String(next.parsed?.system_prompt ?? '');
  return (
    <div className="h-full space-y-3 overflow-auto p-2">
      <section className="rounded-md border border-line p-3">
        <h3 className="mb-2 text-sm font-semibold">Configuration changes</h3>
        {base.parsed == null && next.parsed != null ? <div className="text-xs text-fg-muted">New subagent.</div> : <FieldChanges changes={changes} empty="No semantic changes (formatting or comments only)." />}
      </section>
      {bp !== np && (
        <section className="rounded-md border border-line p-3">
          <h3 className="mb-2 text-sm font-semibold">System prompt</h3>
          <TextDiff oldText={bp} newText={np} oldLabel={base.label} newLabel={next.label} />
        </section>
      )}
      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Raw YAML diff</summary>
        <div className="p-2">
          <MultiFileDiff base={base.files} next={next.files} oldLabel={base.label} newLabel={next.label} />
        </div>
      </details>
    </div>
  );
}

export const subagentDiffRenderer: DiffRenderer = (base, next) => <SubagentDiff base={base} next={next} />;
