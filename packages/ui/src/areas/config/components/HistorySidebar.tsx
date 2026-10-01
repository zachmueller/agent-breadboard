/**
 * Version history sidebar ([03] §8.2, [06] §10): commit list for the definition's path; select a
 * commit to see the native diff (vs current or vs its parent), revert in one click, or launch
 * evals against that version.
 */
import { useState } from 'react';
import clsx from 'clsx';
import { X, RotateCcw, FlaskConical } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useHistory, configApi, evalsApi, type HistoryEntry } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Modal, Confirm, Spin, ErrorBox, notify, errorMessage, TabBar } from '../ui';
import { fmtRelative, fmtDate, shortCommit } from '../lib/format';
import { useSnapshot, snapshotFromFiles, type DiffRenderer } from './snapshot';

export function HistorySidebar({ onClose, renderDiff, canRunEvals }: { onClose: () => void; renderDiff: DiffRenderer; canRunEvals?: boolean }) {
  const wt = useWorkingTree();
  const hist = useHistory(wt.historyPath, 100);
  const [selected, setSelected] = useState<number | null>(null);
  const items = hist.data ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="text-sm font-semibold">Version history</div>
        <button type="button" aria-label="Close history" onClick={onClose} className="rounded p-1 text-fg-subtle hover:bg-hover">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {hist.isLoading && (
          <div className="p-4">
            <Spin />
          </div>
        )}
        {hist.error && <ErrorBox error={hist.error} onRetry={() => void hist.refetch()} />}
        <ol>
          {items.map((c, i) => (
            <li key={c.commit}>
              <button type="button" onClick={() => setSelected(i)} className={clsx('w-full border-b border-line px-3 py-2 text-left hover:bg-hover', selected === i && 'bg-accent-soft')}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm">{c.message || '(no message)'}</span>
                  {c.commit === wt.state.base_commit && <span className="shrink-0 text-[10px] font-medium text-accent-text">CURRENT</span>}
                </div>
                <div className="flex gap-2 text-[11px] text-fg-subtle">
                  <span className="font-mono">{shortCommit(c.commit)}</span>
                  <span>{c.author}</span>
                  <span title={fmtDate(c.date)}>{fmtRelative(c.date)}</span>
                </div>
              </button>
            </li>
          ))}
        </ol>
        {!hist.isLoading && !items.length && !hist.error && <div className="p-4 text-xs text-fg-subtle">No history yet.</div>}
      </div>
      {selected !== null && items[selected] && (
        <CommitDiffModal entry={items[selected]!} parent={items[selected + 1] ?? null} onClose={() => setSelected(null)} renderDiff={renderDiff} canRunEvals={canRunEvals} />
      )}
    </div>
  );
}

function CommitDiffModal({ entry, parent, onClose, renderDiff, canRunEvals }: { entry: HistoryEntry; parent: HistoryEntry | null; onClose: () => void; renderDiff: DiffRenderer; canRunEvals?: boolean }) {
  const wt = useWorkingTree();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'vs-current' | 'in-commit'>('vs-current');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const selected = useSnapshot(wt.kind, wt.uid, entry.commit, shortCommit(entry.commit));
  const parentSnap = useSnapshot(wt.kind, wt.uid, parent?.commit ?? null, parent ? shortCommit(parent.commit) : 'empty');
  const current = snapshotFromFiles(
    Object.fromEntries(Object.entries(wt.state.base)),
    wt.kind,
    wt.uid,
    `current (${shortCommit(wt.state.base_commit)})`,
    wt.state.base_commit,
  );
  const empty = snapshotFromFiles({}, wt.kind, wt.uid, 'before', null);

  const revert = useMutation({
    mutationFn: () => configApi.revert(entry.commit, wt.historyPath),
    onSuccess: async () => {
      notify(`Reverted ${wt.historyPath} to ${shortCommit(entry.commit)}`, 'ok');
      setConfirmRevert(false);
      onClose();
      await wt.reload({ keepEdits: false });
      void qc.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });
  const runEvals = useMutation({
    mutationFn: () => evalsApi.launch({ circuit: wt.uid, ref: entry.commit }),
    onSuccess: (r) => {
      notify(`Eval run ${r.eval_run_id || ''} started against ${shortCommit(entry.commit)} — see the Evals tab`, 'ok');
      void qc.invalidateQueries({ queryKey: ['evals'] });
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });

  const loading = selected.isLoading || (mode === 'in-commit' && parent && parentSnap.isLoading);
  const err = selected.error ?? (mode === 'in-commit' ? parentSnap.error : null);
  let body: React.ReactNode = null;
  if (loading) body = <Spin />;
  else if (err) body = <ErrorBox error={err} />;
  else if (selected.data) {
    body = mode === 'vs-current' ? renderDiff(selected.data, current) : renderDiff(parent ? (parentSnap.data ?? empty) : empty, selected.data);
  }

  return (
    <>
      <Modal
        open
        wide
        onClose={onClose}
        title={
          <span>
            <span className="font-mono">{shortCommit(entry.commit)}</span> — {entry.message || '(no message)'}
          </span>
        }
        footer={
          <>
            {canRunEvals && (
              <Btn icon={<FlaskConical className="size-4" />} loading={runEvals.isPending} onClick={() => runEvals.mutate()}>
                Run evals against this version
              </Btn>
            )}
            <Btn variant="primary" icon={<RotateCcw className="size-4" />} disabled={entry.commit === wt.state.base_commit} onClick={() => setConfirmRevert(true)}>
              Revert to this version
            </Btn>
          </>
        }
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span>
            {entry.author} · {fmtDate(entry.date)}
          </span>
          <TabBar
            value={mode}
            onChange={setMode}
            tabs={[
              { id: 'vs-current', label: 'This version → current' },
              { id: 'in-commit', label: 'Changes in this commit' },
            ]}
          />
        </div>
        {body}
      </Modal>
      <Confirm
        open={confirmRevert}
        title="Revert to this version?"
        message={
          <>
            Creates a new commit on main restoring <span className="font-mono">{wt.historyPath}</span> to <span className="font-mono">{shortCommit(entry.commit)}</span>.
            {wt.state.dirty.size > 0 && <div className="mt-2 text-warn-fg">Your {wt.state.dirty.size} unsaved change(s) will be dropped.</div>}
          </>
        }
        confirmLabel="Revert"
        busy={revert.isPending}
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => revert.mutate()}
      />
    </>
  );
}
