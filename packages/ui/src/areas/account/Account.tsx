/** Account ([12] §3): who you are signed in as, and personal access tokens for your own tools (Claude Code over MCP, [11] §4). */
import { useState } from 'react';
import { KeyRound, Plus, TerminalSquare, UserRound } from 'lucide-react';
import { useCurrentUser } from '../../lib/auth';
import { useCreateMyToken, useMyTokens, useRevokeMyToken } from '../../lib/queries';
import { formatDateTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { CreatedPersonalTokenDto, PersonalTokenDto } from '../../lib/types';
import { Badge, Button, Callout, Checkbox, ConfirmDialog, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Input, Loading, MetaList, PageBody, PageHeader, Panel, Select, TimeAgo, type Column } from '../../components';

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
];

/** The command a member pastes into a terminal to connect Claude Code (docs/mcp.md). */
export function claudeMcpAddCommand(mcpUrl: string, secret: string): string {
  return `claude mcp add --transport http breadboard ${mcpUrl} --header "Authorization: Bearer ${secret}"`;
}

/** The server reports its public MCP URL; without a configured public URL, this origin is the best guess. */
function mcpUrlFor(reported: string | null | undefined): string {
  return reported ?? `${window.location.origin}/api/v1/mcp`;
}

export function Account() {
  const me = useCurrentUser();
  return (
    <>
      <PageHeader icon={<UserRound size={16} />} title="Account" subtitle="Who you are signed in as, and tokens for connecting your own tools to this Breadboard." />
      <PageBody className="flex flex-col gap-5">
        <Panel title="Identity">
          <MetaList
            items={[
              { label: 'Handle', value: <span className="font-mono">@{me.handle}</span> },
              { label: 'Name', value: me.display_name },
              { label: 'Access', value: me.is_admin ? <Badge tone="ok" size="xs">admin</Badge> : <Badge size="xs">member</Badge> },
              {
                label: 'Review roles',
                value: me.roles.length ? (
                  <span className="flex flex-wrap gap-1">
                    {me.roles.map((r) => (
                      <Badge key={r} size="xs" mono variant="outline">
                        {r}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-fg-subtle">none</span>
                ),
              },
              { label: 'Signed in', value: me.via_proxy ? 'by this site’s proxy or load balancer' : 'with a Breadboard session' },
            ]}
          />
        </Panel>
        <TokensPanel />
      </PageBody>
    </>
  );
}

function TokensPanel() {
  const tokens = useMyTokens();
  const revoke = useRevokeMyToken();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedPersonalTokenDto | null>(null);
  const [revoking, setRevoking] = useState<PersonalTokenDto | null>(null);
  const columns: Column<PersonalTokenDto>[] = [
    { key: 'name', header: 'Name', cell: (t) => <span className="font-medium">{t.name}</span>, sortValue: (t) => t.name },
    { key: 'access', header: 'Access', cell: (t) => (t.scopes === null ? <Badge size="xs" tone="warn">full access</Badge> : <Badge size="xs">read-only</Badge>), width: '7rem' },
    { key: 'used', header: 'Last used', cell: (t) => (t.last_used_at ? <TimeAgo at={t.last_used_at} className="text-fg-muted" /> : <span className="text-fg-subtle">Never</span>), width: '7rem', hideBelow: 'md' },
    { key: 'expires', header: 'Expires', cell: (t) => <span className="text-fg-muted">{formatDateTime(t.expires_at)}</span>, width: '10rem', hideBelow: 'lg' },
    { key: 'created', header: 'Created', cell: (t) => <TimeAgo at={t.created_at} className="text-fg-subtle" />, width: '7rem', hideBelow: 'lg' },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => {
        const expired = Date.parse(t.expires_at) < Date.now();
        return t.revoked_at ? <Badge size="xs">Revoked</Badge> : expired ? <Badge size="xs" tone="warn">Expired</Badge> : <Badge size="xs" tone="ok">Active</Badge>;
      },
      width: '6rem',
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (t) =>
        !t.revoked_at ? (
          <Button size="xs" variant="ghost" onClick={() => setRevoking(t)}>
            Revoke
          </Button>
        ) : null,
      width: '6rem',
    },
  ];
  const mcpUrl = mcpUrlFor(tokens.data?.mcp_url);
  return (
    <Panel
      title="Personal access tokens"
      description="Bearer tokens that act as you from your own tools, such as Claude Code connected to this Breadboard’s MCP server. A read-only token can inspect everything you can see but changes nothing. The secret is shown once."
      actions={
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          Create token
        </Button>
      }
      bodyClassName="p-0"
    >
      {tokens.isPending ? (
        <Loading />
      ) : tokens.error ? (
        <ErrorState error={tokens.error} className="m-4" onRetry={() => tokens.refetch()} />
      ) : (
        <DataTable
          caption="Personal access tokens"
          columns={columns}
          rows={tokens.data?.items ?? []}
          rowKey={(t) => t.token_id}
          rowClassName={(t) => (t.revoked_at ? 'opacity-60' : undefined)}
          empty={<EmptyState icon={<KeyRound size={20} />} title="No personal access tokens" description="Create one to connect Claude Code or another MCP client." compact />}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line px-4 py-3 text-[12.5px] text-fg-muted">
        <TerminalSquare size={13} aria-hidden />
        <span>MCP endpoint</span>
        <code className="font-mono text-fg">{mcpUrl}</code>
        <CopyButton value={mcpUrl} label="Copy endpoint" size={12} />
        <span>— connections send the token as a bearer header and are logged as sessions under your name.</span>
      </div>
      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setCreated(t);
          }}
        />
      )}
      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title="Token created"
        description="Copy the secret now. It is not stored in a retrievable form and will not be shown again."
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I’ve stored it
          </Button>
        }
      >
        {created?.secret ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{created.secret}</code>
              <CopyButton value={created.secret} label="Copy secret" />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium">
                <TerminalSquare size={13} aria-hidden /> Connect Claude Code
              </div>
              <div className="flex items-start gap-2 rounded-md border border-line bg-sunken px-3 py-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px]">{claudeMcpAddCommand(mcpUrlFor(created.mcp_url), created.secret)}</code>
                <CopyButton value={claudeMcpAddCommand(mcpUrlFor(created.mcp_url), created.secret)} label="Copy command" />
              </div>
              <p className="mt-1 text-[12px] text-fg-subtle">
                Run it in a terminal, then check with <code className="font-mono">claude mcp list</code>. The tools appear as <code className="font-mono">mcp__breadboard__…</code>.
              </p>
            </div>
            {created.scopes === null && <Callout tone="warn">This token has your full access: anything it does is done as you.</Callout>}
          </div>
        ) : (
          <Callout tone="warn">The server did not return a secret.</Callout>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name}?`}
        description="Clients using this token are rejected immediately. This cannot be undone."
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={async () => {
          try {
            await revoke.mutateAsync(revoking!.token_id);
            toast.success('Token revoked');
            setRevoking(null);
          } catch (e) {
            toast.error('Could not revoke', e);
          }
        }}
      />
    </Panel>
  );
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: CreatedPersonalTokenDto) => void }) {
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [days, setDays] = useState('90');
  const create = useCreateMyToken();
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Create personal access token"
      confirmLabel="Create token"
      confirmDisabled={!name.trim()}
      onConfirm={async () => {
        try {
          onCreated(await create.mutateAsync({ name: name.trim(), read_only: readOnly, expires_in_days: Number(days) }));
        } catch (e) {
          toast.error('Could not create token', e);
        }
      }}
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. Claude Code on my laptop" />
      <Checkbox
        label="Read-only"
        description="Can read sessions, transcripts, content, knowledge, configuration and evals, but cannot create, edit, run or propose anything. Recommended for investigating."
        checked={readOnly}
        onChange={(e) => setReadOnly(e.target.checked)}
      />
      {!readOnly && <Callout tone="warn">A full-access token acts exactly as you, including review verdicts and configuration merges.</Callout>}
      <Select label="Expires in" value={days} onChange={(e) => setDays(e.target.value)} options={EXPIRY_OPTIONS} />
    </ConfirmDialog>
  );
}
