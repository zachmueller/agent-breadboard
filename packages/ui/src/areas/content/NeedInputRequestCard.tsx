/** One open need-input request with its actions ([09] §3, [02] §5.4): resolve, or approve / request-changes for gates. */
import { useState } from 'react';
import { CheckCircle2, MessageSquareReply, PauseCircle, ShieldCheck, ThumbsUp, Undo2, UserRound, Users } from 'lucide-react';
import { requestTargetsUser, type NeedInputRequest } from '@breadboard/shared';
import { useGateVerdict, useResolveRequest } from '../../lib/queries';
import { useCurrentUser } from '../../lib/auth';
import { errorMessage } from '../../lib/api';
import { toast } from '../../lib/toast';
import { cn } from '../../components/cn';
import { ActorLabel, Badge, Button, ConfirmDialog, Markdown, SessionChip, TextArea, TimeAgo } from '../../components';

export function asRequest(r: Record<string, unknown>): NeedInputRequest {
  return {
    request_id: String(r.request_id ?? ''),
    role: (r.role as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    prompt: (r.prompt as string | null) ?? null,
    requested_by: r.requested_by as NeedInputRequest['requested_by'],
    requested_at: String(r.requested_at ?? ''),
    gate: (r.gate as NeedInputRequest['gate']) ?? null,
  };
}

/** Open requests stored on a node (`properties['need-input']`). */
export function openRequests(properties: Record<string, unknown> | null | undefined): NeedInputRequest[] {
  const v = properties?.['need-input'];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>).filter((x) => x && typeof x === 'object').map(asRequest) : [];
}

export function TargetLabel({ req }: { req: Pick<NeedInputRequest, 'role' | 'username'> }) {
  if (!req.role && !req.username) return <span className="text-fg-subtle">Anyone</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {req.role && (
        <Badge size="xs" icon={<Users size={11} />} mono>
          {req.role}
        </Badge>
      )}
      {req.username && (
        <Badge size="xs" icon={<UserRound size={11} />} mono>
          @{req.username}
        </Badge>
      )}
    </span>
  );
}

type Dialog = null | 'resolve' | 'approve' | 'request-changes';

export function NeedInputRequestCard({
  nodeUid,
  request,
  gatingSession,
  compact,
  className,
}: {
  nodeUid: string;
  request: NeedInputRequest;
  /** Blocked session, when the request is a gate (from the review queue's `gating_session`). */
  gatingSession?: { session_id: string; state?: string | null } | null;
  compact?: boolean;
  className?: string;
}) {
  const me = useCurrentUser();
  const mine = requestTargetsUser(request, { handle: me.handle, roles: me.roles });
  const isGate = !!request.gate;
  const [dialog, setDialog] = useState<Dialog>(null);
  const blockedId = gatingSession?.session_id ?? request.gate?.session_id ?? null;

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border bg-surface px-3.5 py-3', isGate ? 'border-warn/60' : 'border-line', className)}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        {isGate ? (
          <Badge size="xs" tone="warn" variant="solid" icon={<ShieldCheck size={11} />}>
            Gate
          </Badge>
        ) : (
          <Badge size="xs" tone="info" icon={<MessageSquareReply size={11} />}>
            Needs input
          </Badge>
        )}
        <TargetLabel req={request} />
        {blockedId && (
          <span className="inline-flex items-center gap-1 text-fg-muted">
            <PauseCircle size={13} className="text-warn-fg" aria-hidden />
            blocks
            <SessionChip id={blockedId} state={gatingSession?.state ?? 'suspended-gate'} step={request.gate?.step_id} />
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-fg-subtle">
          <ActorLabel actor={request.requested_by} />
          <TimeAgo at={request.requested_at} />
        </span>
      </div>
      {request.prompt ? (
        <Markdown source={request.prompt} size="sm" className={cn('text-fg', compact && 'line-clamp-3')} />
      ) : (
        <p className="text-[13px] italic text-fg-subtle">No prompt given.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {isGate ? (
          <>
            <Button size="xs" variant="primary" icon={<ThumbsUp size={12} />} onClick={() => setDialog('approve')}>
              Approve
            </Button>
            <Button size="xs" icon={<Undo2 size={12} />} onClick={() => setDialog('request-changes')}>
              Request changes
            </Button>
          </>
        ) : (
          <Button size="xs" variant="primary" icon={<CheckCircle2 size={12} />} onClick={() => setDialog('resolve')}>
            Resolve
          </Button>
        )}
        {!mine && <span className="text-[12px] text-fg-subtle">Not targeted at you; you can still respond.</span>}
      </div>
      {dialog === 'resolve' && <ResolveDialog nodeUid={nodeUid} request={request} onClose={() => setDialog(null)} />}
      {(dialog === 'approve' || dialog === 'request-changes') && <VerdictDialog nodeUid={nodeUid} request={request} verdict={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ResolveDialog({ nodeUid, request, onClose }: { nodeUid: string; request: NeedInputRequest; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const resolve = useResolveRequest(nodeUid);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Resolve request"
      confirmLabel="Resolve"
      onConfirm={async () => {
        try {
          await resolve.mutateAsync({ request_id: request.request_id, comment: comment.trim() || undefined });
          toast.success('Request resolved');
          onClose();
        } catch (e) {
          toast.error('Could not resolve', e);
        }
      }}
    >
      <Markdown source={request.prompt} size="sm" className="text-fg-muted" />
      <TextArea label="Response (optional)" hint="Posted as a comment on the node." rows={4} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
    </ConfirmDialog>
  );
}

function VerdictDialog({ nodeUid, request, verdict, onClose }: { nodeUid: string; request: NeedInputRequest; verdict: 'approve' | 'request-changes'; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const [edits, setEdits] = useState('');
  const gate = useGateVerdict(nodeUid);
  let parsed: unknown;
  let parseError: string | null = null;
  const changes = verdict === 'request-changes';
  if (changes && edits.trim()) {
    try {
      parsed = JSON.parse(edits);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) parseError = 'Edits must be a JSON object.';
    } catch (e) {
      parseError = errorMessage(e);
    }
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={changes ? 'Request changes' : 'Approve'}
      description={
        changes
          ? 'The gate resolves through its changes exit once all targeted verdicts are in. Your comment is passed to the revising step.'
          : 'The gate resolves through its approve exit once all targeted verdicts are in.'
      }
      confirmLabel={changes ? 'Request changes' : 'Approve'}
      variant={changes ? 'secondary' : 'primary'}
      confirmDisabled={!!parseError || (changes && !comment.trim())}
      onConfirm={async () => {
        try {
          await gate.mutateAsync({ request_id: request.request_id, verdict, comment: comment.trim() || undefined, edits: parsed });
          toast.success(changes ? 'Changes requested' : 'Approved');
          onClose();
        } catch (e) {
          toast.error('Verdict not recorded', e);
        }
      }}
    >
      <TextArea label={changes ? 'What should change?' : 'Comment (optional)'} rows={4} value={comment} onChange={(e) => setComment(e.target.value)} required={changes} autoFocus />
      {changes && (
      <TextArea
        label="Direct edits (optional JSON object)"
        hint={'Merged into the gate output the changes exit receives, e.g. {"summary": "…"}. Must satisfy the gate output schema.'}
        mono
        rows={4}
        value={edits}
        onChange={(e) => setEdits(e.target.value)}
        error={parseError ?? undefined}
        placeholder="{}"
      />
      )}
    </ConfirmDialog>
  );
}
