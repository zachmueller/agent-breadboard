/**
 * Common chrome for the circuit / tool / subagent editors: top bar (identity, validation,
 * Commit / Discard / History / Chat), a tab strip, the main area, and right-hand panels
 * (history sidebar, always-visible-by-default designer chat — [10] §4).
 */
import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, AlertCircle, Loader2, History, MessageSquare, GitCommitHorizontal, Undo2, PanelRightClose } from 'lucide-react';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Modal, Confirm, TextAreaInput, Pill, TabBar, ErrorBox, Spin, ToastHost, errorMessage } from '../ui';
import { ValidationList } from './fields';
import { shortCommit } from '../lib/format';

export function ValidationStatus() {
  const wt = useWorkingTree();
  const [open, setOpen] = useState(false);
  const { errors, warnings } = wt;
  const busy = wt.state.validating;
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-hover">
        {busy ? (
          <Loader2 className="size-3.5 animate-spin text-fg-subtle" />
        ) : errors.length ? (
          <AlertCircle className="size-3.5 text-danger-fg" />
        ) : (
          <CheckCircle2 className="size-3.5 text-ok-fg" />
        )}
        <span className={clsx(errors.length ? 'text-danger-fg' : 'text-fg-muted')}>
          {busy ? 'Validating…' : errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : 'Valid'}
          {warnings.length > 0 && <span className="ml-1 text-warn-fg">· {warnings.length} warning{warnings.length > 1 ? 's' : ''}</span>}
        </span>
      </button>
      {open && (errors.length > 0 || warnings.length > 0) && (
        <div className="absolute top-8 left-0 z-40 w-[28rem] max-w-[80vw] rounded-md border border-line bg-surface p-2 shadow-pop">
          <ValidationList errors={errors} warnings={warnings} />
        </div>
      )}
    </div>
  );
}

export function CommitDialog({ open, onClose, defaultMessage, notice }: { open: boolean; onClose: () => void; defaultMessage: string; notice?: ReactNode }) {
  const wt = useWorkingTree();
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const changes = wt.changes();
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await wt.commit(message.trim() || defaultMessage);
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Commit to main"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" loading={busy} disabled={!changes.length} onClick={submit} icon={<GitCommitHorizontal className="size-4" />}>
            Commit
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <TextAreaInput autoFocus rows={3} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
        <div>
          <div className="mb-1 text-xs font-medium text-fg-muted">
            {changes.length} changed file{changes.length === 1 ? '' : 's'} (base {shortCommit(wt.state.base_commit)})
          </div>
          <ul className="space-y-0.5 font-mono text-xs">
            {changes.map((c) => (
              <li key={c.path} className={clsx(c.content === null ? 'text-danger-fg' : !(c.path in wt.state.base) ? 'text-ok-fg' : 'text-fg')}>
                {c.content === null ? 'D' : !(c.path in wt.state.base) ? 'A' : 'M'} {c.path}
              </li>
            ))}
          </ul>
        </div>
        {notice}
        {wt.errors.length > 0 && (
          <div className="rounded-md border border-danger/40 bg-danger-soft p-2">
            <div className="mb-1 text-xs font-medium text-danger-fg">Validation errors — the server will reject this commit:</div>
            <ValidationList errors={wt.errors} max={8} />
          </div>
        )}
        {err != null && <div className="text-xs text-danger-fg">{errorMessage(err)}</div>}
      </div>
    </Modal>
  );
}

export interface EditorFrameProps<T extends string> {
  kindLabel: string;
  title: ReactNode;
  subtitle?: ReactNode;
  tabs?: Array<{ id: T; label: ReactNode }>;
  tab?: T;
  onTab?: (t: T) => void;
  history?: (close: () => void) => ReactNode;
  chat?: ReactNode;
  toolbar?: ReactNode;
  defaultCommitMessage: string;
  /** Extra content in the commit dialog (e.g. the tool editor's security diff). */
  commitNotice?: ReactNode;
  children: ReactNode;
}

export function EditorFrame<T extends string>({ kindLabel, title, subtitle, tabs, tab, onTab, history, chat, toolbar, defaultCommitMessage, commitNotice, children }: EditorFrameProps<T>) {
  const wt = useWorkingTree();
  const [commitOpen, setCommitOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const dirty = wt.state.dirty.size;

  if (wt.state.status === 'loading' && !wt.state.definition)
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  if (wt.state.status === 'error' && !wt.state.definition) return <ErrorBox error={wt.state.error} title={`Could not load ${kindLabel}`} onRetry={() => void wt.reload()} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-page">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2">
        <div className="min-w-0">
          <div className="text-[11px] tracking-wide text-fg-subtle uppercase">{kindLabel}</div>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-base font-semibold">{title}</h1>
            {subtitle && <span className="truncate text-xs text-fg-muted">{subtitle}</span>}
          </div>
        </div>
        <ValidationStatus />
        {dirty > 0 && <Pill tone="warn">{dirty} unsaved</Pill>}
        <span className="font-mono text-[11px] text-fg-subtle" title="Base commit">
          @{shortCommit(wt.state.base_commit)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {toolbar}
          <Btn size="sm" variant="ghost" disabled={!dirty} icon={<Undo2 className="size-3.5" />} onClick={() => setDiscardOpen(true)}>
            Discard
          </Btn>
          <Btn size="sm" variant="primary" disabled={!dirty} icon={<GitCommitHorizontal className="size-3.5" />} onClick={() => setCommitOpen(true)}>
            Commit
          </Btn>
          {history && (
            <Btn size="sm" variant={historyOpen ? 'secondary' : 'ghost'} icon={<History className="size-3.5" />} onClick={() => setHistoryOpen(!historyOpen)} aria-pressed={historyOpen}>
              History
            </Btn>
          )}
          {chat && (
            <Btn size="sm" variant={chatOpen ? 'secondary' : 'ghost'} icon={chatOpen ? <PanelRightClose className="size-3.5" /> : <MessageSquare className="size-3.5" />} onClick={() => setChatOpen(!chatOpen)} aria-pressed={chatOpen}>
              Designer
            </Btn>
          )}
        </div>
      </div>
      {wt.state.restoredDraft && dirty > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-1 text-xs text-warn-fg">
          Restored unsaved edits from this browser session.
          <button type="button" className="underline" onClick={() => setDiscardOpen(true)}>
            Discard them
          </button>
        </div>
      )}
      {tabs && tab && onTab && <TabBar tabs={tabs} value={tab} onChange={onTab} className="bg-surface px-3" />}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">{children}</div>
        {history && historyOpen && <div className="w-[26rem] shrink-0 border-l border-line bg-surface">{history(() => setHistoryOpen(false))}</div>}
        {chat && <div className={clsx('w-[24rem] shrink-0 border-l border-line bg-surface', !chatOpen && 'hidden')}>{chat}</div>}
      </div>
      {commitOpen && <CommitDialog open onClose={() => setCommitOpen(false)} defaultMessage={defaultCommitMessage} notice={commitNotice} />}
      <Confirm
        open={discardOpen}
        title="Discard unsaved changes?"
        message={`This drops ${dirty} uncommitted file change${dirty === 1 ? '' : 's'} and restores the base commit.`}
        confirmLabel="Discard"
        danger
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          wt.discard();
          setDiscardOpen(false);
        }}
      />
      <ToastHost />
    </div>
  );
}
