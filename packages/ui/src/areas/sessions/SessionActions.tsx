/** Session operator actions ([02] §5): retry, cancel, resume (budget raise), manual route, promote to fixture. */
import { useMemo, useState } from 'react';
import { Ban, FlaskConical, Play, RotateCcw, Route as RouteIcon } from 'lucide-react';
import { TERMINAL_SESSION_STATES, type SessionSummaryDto } from '@breadboard/shared';
import { useConfigDefinition, useSessionAction, type SessionAction } from '../../lib/queries';
import { errorMessage } from '../../lib/api';
import { formatCost, formatTokens } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, Callout, ConfirmDialog, Input, Select, TextArea } from '../../components';
import { circuitSteps, failedStepId } from './util';

type Open = null | 'retry' | 'cancel' | 'resume' | 'route' | 'promote';

export function SessionActions({ session }: { session: SessionSummaryDto }) {
  const [open, setOpen] = useState<Open>(null);
  const act = useSessionAction(session.session_id);
  const terminal = TERMINAL_SESSION_STATES.includes(session.state);
  const errored = session.state === 'suspended-error';
  const budgetStop = errored && (session.state_detail as { reason?: string })?.reason === 'budget-exceeded';
  const promotable = (session.kind === 'circuit-run' || session.kind === 'eval-run') && !!session.circuit_uid;

  const run = async (a: SessionAction, ok: string) => {
    try {
      await act.mutateAsync(a);
      toast.success(ok);
      setOpen(null);
    } catch (e) {
      toast.error('Action failed', e);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {errored && (
          <Button size="sm" variant={budgetStop ? 'secondary' : 'primary'} icon={<RotateCcw size={14} />} onClick={() => setOpen('retry')}>
            Retry
          </Button>
        )}
        {errored && (
          <Button size="sm" variant={budgetStop ? 'primary' : 'secondary'} icon={<Play size={14} />} onClick={() => setOpen('resume')}>
            Resume
          </Button>
        )}
        {errored && session.kind === 'circuit-run' && (
          <Button size="sm" icon={<RouteIcon size={14} />} onClick={() => setOpen('route')}>
            Route…
          </Button>
        )}
        {promotable && (
          <Button size="sm" variant="ghost" icon={<FlaskConical size={14} />} onClick={() => setOpen('promote')}>
            Promote to fixture
          </Button>
        )}
        {!terminal && (
          <Button size="sm" variant="ghost" icon={<Ban size={14} />} onClick={() => setOpen('cancel')} className="hover:text-danger-fg">
            Cancel
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={open === 'retry'}
        onClose={() => setOpen(null)}
        title="Retry from the failed step?"
        description="The run restarts from its last step-boundary checkpoint. Completed steps are not re-executed."
        confirmLabel="Retry"
        onConfirm={() => run({ action: 'retry' }, 'Retry scheduled')}
      />
      <CancelDialog open={open === 'cancel'} onClose={() => setOpen(null)} onConfirm={(reason) => run({ action: 'cancel', reason: reason || undefined }, 'Session cancelled')} />
      <ResumeDialog open={open === 'resume'} onClose={() => setOpen(null)} session={session} onConfirm={(budget) => run({ action: 'resume', budget }, 'Session resumed')} />
      {open === 'route' && <RouteDialog onClose={() => setOpen(null)} session={session} onConfirm={(exit, output) => run({ action: 'route', exit, output }, `Routed through “${exit}”`)} />}
      <PromoteDialog open={open === 'promote'} onClose={() => setOpen(null)} onConfirm={(fixture_title) => run({ action: 'promote-fixture', fixture_title }, 'Promoted to an eval fixture (config change committed)')} />
    </>
  );
}

function CancelDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={open} onClose={onClose} title="Cancel this session?" description="Cancellation is terminal. Artifacts produced so far are kept; child sessions are cancelled too." confirmLabel="Cancel session" cancelLabel="Keep running" variant="danger" onConfirm={() => onConfirm(reason.trim())}>
      <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. superseded by a newer task" />
    </ConfirmDialog>
  );
}

function ResumeDialog({ open, onClose, session, onConfirm }: { open: boolean; onClose: () => void; session: SessionSummaryDto; onConfirm: (budget?: { max_cost_usd?: number; max_tokens?: number }) => Promise<void> }) {
  const b = session.budget ?? { max_cost_usd: 0, max_tokens: 0, spent_usd: 0, spent_tokens: 0 };
  const budgetStop = (session.state_detail as { reason?: string })?.reason === 'budget-exceeded';
  const [cost, setCost] = useState(() => String(Math.max(b.max_cost_usd * 2, b.spent_usd * 1.5, 1).toFixed(2)));
  const [tokens, setTokens] = useState(() => String(Math.max(b.max_tokens * 2, Math.ceil(b.spent_tokens * 1.5))));
  const [raise, setRaise] = useState(budgetStop);
  const costN = Number(cost);
  const tokN = Number(tokens);
  const invalid = raise && (!(costN > 0) || !(tokN > 0) || !Number.isFinite(costN) || !Number.isFinite(tokN));
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Resume session"
      description={budgetStop ? 'This run stopped at its budget ceiling. Raise the budget to let it continue.' : 'Resume from the last checkpoint.'}
      confirmLabel="Resume"
      confirmDisabled={invalid}
      onConfirm={() => onConfirm(raise ? { max_cost_usd: costN, max_tokens: Math.round(tokN) } : undefined)}
    >
      <div className="rounded-md bg-sunken px-3 py-2 text-[12.5px] text-fg-muted">
        Spent <span className="font-medium text-fg tabular">{formatCost(b.spent_usd)}</span> of {formatCost(b.max_cost_usd)} · <span className="tabular">{formatTokens(b.spent_tokens)}</span> of {formatTokens(b.max_tokens)} tokens
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} className="accent-[var(--bb-accent)]" />
        Raise the per-run budget
      </label>
      {raise && (
        <div className="grid grid-cols-2 gap-3">
          <Input label="Max cost (USD)" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
          <Input label="Max tokens" type="number" min={0} step="1000" value={tokens} onChange={(e) => setTokens(e.target.value)} />
        </div>
      )}
    </ConfirmDialog>
  );
}

function RouteDialog({ onClose, session, onConfirm }: { onClose: () => void; session: SessionSummaryDto; onConfirm: (exit: string, output: unknown) => Promise<void> }) {
  const def = useConfigDefinition(session.circuit_uid, session.config_commit ?? undefined);
  const stepId = failedStepId(session);
  const steps = useMemo(() => circuitSteps(def.data?.definition), [def.data]);
  const step = stepId ? steps.get(stepId) : undefined;
  const [exit, setExit] = useState('');
  const [output, setOutput] = useState('{}');
  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = output.trim() ? JSON.parse(output) : undefined;
  } catch (e) {
    parseError = errorMessage(e);
  }
  const chosen = exit || step?.exits[0]?.name || '';
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Route past the failed step"
      description={
        <>
          Make the routing decision manually for <span className="font-mono">{stepId ?? 'the failed step'}</span>: choose the exit to take and supply the step output downstream steps should see.
        </>
      }
      confirmLabel="Route"
      confirmDisabled={!chosen || !!parseError}
      onConfirm={() => onConfirm(chosen, parsed)}
    >
      {def.error && <Callout tone="warn">Couldn't load the circuit definition ({errorMessage(def.error)}). Enter the exit name manually.</Callout>}
      {step?.exits.length ? (
        <Select
          label="Exit"
          value={chosen}
          onChange={(e) => setExit(e.target.value)}
          options={step.exits.map((x) => ({ value: x.name, label: `${x.name} → ${x.to}${x.description ? ` — ${x.description}` : ''}` }))}
        />
      ) : (
        <Input label="Exit name" value={exit} onChange={(e) => setExit(e.target.value)} placeholder="e.g. done" required />
      )}
      <TextArea label="Step output (JSON)" mono rows={8} value={output} onChange={(e) => setOutput(e.target.value)} error={parseError ?? undefined} hint="Validated by the server against the step's declared output schema." />
    </ConfirmDialog>
  );
}

function PromoteDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Promote to eval fixture"
      description="Pins this run's input and the knowledge revisions it read as a fixture in the circuit's eval set. This commits a configuration change."
      confirmLabel="Promote"
      confirmDisabled={!title.trim()}
      onConfirm={() => onConfirm(title.trim())}
    >
      <Input label="Fixture title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ambiguous refund request" autoFocus required />
    </ConfirmDialog>
  );
}
