/** Admin ([12] §2-§5): users, roles + membership, service tokens, credential broker, health. Admins only. */
import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, KeyRound, Lock, Plus, ShieldCheck, Trash2, UserMinus, Users, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAdminList, useAdminMutation, del, get, post } from '../../lib/queries';
import { useCurrentUser } from '../../lib/auth';
import { useUrlSearch } from '../../lib/url';
import { asPage, errorMessage } from '../../lib/api';
import { formatCost, formatDateTime, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { BrokerCapabilityDto, BrokerCredentialDto, CreatedServiceTokenDto, RoleDto, RoleMemberDto, ServiceTokenDto, UserDto } from '../../lib/types';
import { cn } from '../../components/cn';
import {
  ActorLabel,
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  JsonView,
  Loading,
  PageBody,
  PageHeader,
  Panel,
  Select,
  Tabs,
  TextArea,
  TimeAgo,
  type Column,
} from '../../components';

type Tab = 'users' | 'roles' | 'tokens' | 'broker' | 'health';

export function Admin() {
  const me = useCurrentUser();
  const [search, setSearch] = useUrlSearch<{ tab?: string }>();
  const tab = (search.tab as Tab) || 'users';
  if (!me.is_admin)
    return (
      <PageBody>
        <EmptyState icon={<Lock size={20} />} title="Admins only" description="Ask a Breadboard admin for access to user, role, token and credential management." />
      </PageBody>
    );
  return (
    <>
      <PageHeader icon={<ShieldCheck size={16} />} title="Admin" subtitle="Identity, authorization, credentials and system health for this Breadboard.">
        <Tabs
          idBase="admin"
          value={tab}
          onChange={(k) => setSearch({ tab: k === 'users' ? undefined : k })}
          items={[
            { key: 'users', label: 'Users', icon: <Users size={14} /> },
            { key: 'roles', label: 'Roles', icon: <ShieldCheck size={14} /> },
            { key: 'tokens', label: 'Service tokens', icon: <KeyRound size={14} /> },
            { key: 'broker', label: 'Credential broker', icon: <Lock size={14} /> },
            { key: 'health', label: 'Health', icon: <Activity size={14} /> },
          ]}
        />
      </PageHeader>
      <PageBody wide className="flex flex-col gap-5">
        {tab === 'users' ? <UsersTab /> : tab === 'roles' ? <RolesTab /> : tab === 'tokens' ? <TokensTab /> : tab === 'broker' ? <BrokerTab /> : <HealthTab />}
      </PageBody>
    </>
  );
}

// ------------------------------------------------------------------ users ---

function UsersTab() {
  const me = useCurrentUser();
  const users = useAdminList<UserDto>('users', '/admin/users');
  const [creating, setCreating] = useState(false);
  const [deactivate, setDeactivate] = useState<UserDto | null>(null);
  const deact = useAdminMutation((id: string) => post(`/admin/users/${id}/deactivate`, {}), ['users', 'roles']);
  const columns: Column<UserDto>[] = [
    {
      key: 'handle',
      header: 'User',
      cell: (u) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{u.display_name || u.handle}</span>
          <span className="font-mono text-[12px] text-fg-subtle">@{u.handle}</span>
        </span>
      ),
      sortValue: (u) => u.handle,
    },
    { key: 'admin', header: 'Admin', cell: (u) => (u.is_admin ? <Badge size="xs" tone="accent">admin</Badge> : null), width: '6rem' },
    { key: 'oidc', header: 'Identity', cell: (u) => <span className="text-[12.5px] text-fg-muted">{u.oidc_subject ? 'OIDC' : 'Local'}</span>, width: '6rem', hideBelow: 'md' },
    { key: 'created', header: 'Created', cell: (u) => <TimeAgo at={u.created_at} className="text-fg-muted" />, sortValue: (u) => u.created_at, width: '7rem' },
    {
      key: 'status',
      header: 'Status',
      cell: (u) =>
        u.deactivated_at ? (
          <Badge size="xs" tone="neutral" icon={<XCircle size={11} />}>
            Deactivated
          </Badge>
        ) : (
          <Badge size="xs" tone="ok" icon={<CheckCircle2 size={11} />}>
            Active
          </Badge>
        ),
      width: '7rem',
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (u) =>
        !u.deactivated_at && u.user_id !== me.user_id ? (
          <Button size="xs" variant="ghost" icon={<UserMinus size={12} />} onClick={() => setDeactivate(u)}>
            Deactivate
          </Button>
        ) : null,
      width: '8rem',
    },
  ];
  return (
    <Panel
      title="Users"
      description="Users sign in through OIDC (or static local users in dev). Pre-provision a handle to grant roles before first sign-in."
      actions={
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          Add user
        </Button>
      }
      bodyClassName="p-0"
    >
      {users.isPending ? <Loading /> : users.error ? <ErrorState error={users.error} onRetry={() => users.refetch()} className="m-4" /> : <DataTable caption="Users" columns={columns} rows={users.data ?? []} rowKey={(u) => u.user_id} rowClassName={(u) => (u.deactivated_at ? 'opacity-60' : undefined)} empty={<EmptyState title="No users" compact />} />}
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={!!deactivate}
        onClose={() => setDeactivate(null)}
        title={`Deactivate @${deactivate?.handle}?`}
        description="They are signed out and can no longer authenticate. Their history and authored content remain."
        confirmLabel="Deactivate"
        variant="danger"
        onConfirm={async () => {
          try {
            await deact.mutateAsync(deactivate!.user_id);
            toast.success('User deactivated');
            setDeactivate(null);
          } catch (e) {
            toast.error('Could not deactivate', e);
          }
        }}
      />
    </Panel>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const create = useAdminMutation((b: { handle: string; display_name?: string; is_admin: boolean }) => post('/admin/users', b), ['users']);
  const valid = /^[A-Za-z0-9._-]{1,64}$/.test(handle);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Add user"
      confirmLabel="Add user"
      confirmDisabled={!valid}
      onConfirm={async () => {
        try {
          await create.mutateAsync({ handle, display_name: name.trim() || undefined, is_admin: admin });
          toast.success(`Added @${handle}`);
          onClose();
        } catch (e) {
          toast.error('Could not add user', e);
        }
      }}
    >
      <Input label="Handle" value={handle} onChange={(e) => setHandle(e.target.value.trim())} required autoFocus hint="Letters, digits, '.', '_' or '-'. Must match the OIDC username claim." error={handle && !valid ? 'Invalid handle' : undefined} />
      <Input label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
      <Checkbox label="Breadboard admin" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
    </ConfirmDialog>
  );
}

// ------------------------------------------------------------------ roles ---

function memberIds(r: RoleDto): Set<string> {
  return new Set((r.members ?? []).map((m) => (typeof m === 'string' ? m : (m as RoleMemberDto).user_id)));
}

function RolesTab() {
  const roles = useAdminList<RoleDto>('roles', '/admin/roles');
  const users = useAdminList<UserDto>('users', '/admin/users');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = useAdminMutation(({ slug, user_id, member }: { slug: string; user_id: string; member: boolean }) => post(`/admin/roles/${slug}/members`, { user_id, member }), ['roles']);
  const remove = useAdminMutation((slug: string) => del(`/admin/roles/${slug}`), ['roles']);
  const active = (users.data ?? []).filter((u) => !u.deactivated_at);
  const roleList = roles.data ?? [];
  const members = useMemo(() => new Map(roleList.map((r) => [r.slug, memberIds(r)])), [roleList]);

  const onToggle = async (slug: string, user_id: string, member: boolean) => {
    const k = `${slug}:${user_id}`;
    setBusy(k);
    try {
      await toggle.mutateAsync({ slug, user_id, member });
    } catch (e) {
      toast.error('Membership not changed', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Roles"
      description="Roles target need-input requests and gate reviewers (e.g. need-input:role=legal). Toggle membership in the matrix."
      actions={
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New role
        </Button>
      }
      bodyClassName="p-0"
    >
      {roles.isPending || users.isPending ? (
        <Loading />
      ) : roles.error || users.error ? (
        <ErrorState error={roles.error ?? users.error} className="m-4" onRetry={() => (roles.refetch(), users.refetch())} />
      ) : !roleList.length ? (
        <EmptyState icon={<ShieldCheck size={20} />} title="No roles yet" description="Create a role, then add members." compact className="py-10" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Role membership</caption>
            <thead>
              <tr className="border-b border-line bg-sunken text-left text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">
                <th scope="col" className="sticky left-0 bg-sunken px-4 py-2">
                  Role
                </th>
                {active.map((u) => (
                  <th key={u.user_id} scope="col" className="px-2 py-2 text-center font-mono normal-case tracking-normal" title={u.display_name}>
                    @{u.handle}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roleList.map((r) => (
                <tr key={r.slug} className="border-b border-line last:border-0 hover:bg-hover/50">
                  <th scope="row" className="sticky left-0 bg-surface px-4 py-2 text-left font-normal">
                    <span className="font-mono font-medium text-fg">{r.slug}</span>
                    {r.description && <span className="block max-w-[18rem] truncate text-[12px] text-fg-subtle">{r.description}</span>}
                  </th>
                  {active.map((u) => {
                    const on = members.get(r.slug)?.has(u.user_id) ?? false;
                    const k = `${r.slug}:${u.user_id}`;
                    return (
                      <td key={u.user_id} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy === k}
                          onChange={() => onToggle(r.slug, u.user_id, !on)}
                          aria-label={`${u.handle} in ${r.slug}`}
                          className={cn('size-4 cursor-pointer rounded accent-[var(--bb-accent)]', busy === k && 'animate-pulse')}
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setDeleting(r)} aria-label={`Delete role ${r.slug}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateRoleDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete role ${deleting?.slug}?`}
        description="Existing need-input requests targeting this role stay open but will no longer reach anyone through it."
        confirmLabel="Delete role"
        variant="danger"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(deleting!.slug);
            toast.success('Role deleted');
            setDeleting(null);
          } catch (e) {
            toast.error('Could not delete role', e);
          }
        }}
      />
    </Panel>
  );
}

function CreateRoleDialog({ onClose }: { onClose: () => void }) {
  const [slug, setSlug] = useState('');
  const [desc, setDesc] = useState('');
  const create = useAdminMutation((b: { slug: string; description: string }) => post('/admin/roles', b), ['roles']);
  const valid = /^[a-z0-9-]{1,64}$/.test(slug);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="New role"
      confirmLabel="Create role"
      confirmDisabled={!valid}
      onConfirm={async () => {
        try {
          await create.mutateAsync({ slug, description: desc.trim() });
          toast.success(`Created ${slug}`);
          onClose();
        } catch (e) {
          toast.error('Could not create role', e);
        }
      }}
    >
      <Input label="Slug" value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} required autoFocus hint="Lowercase letters, digits and '-'." error={slug && !valid ? 'Invalid slug' : undefined} />
      <Input label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
    </ConfirmDialog>
  );
}

// --------------------------------------------------------- service tokens ---

function TokensTab() {
  const tokens = useAdminList<ServiceTokenDto>('tokens', '/admin/service-tokens');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<CreatedServiceTokenDto | null>(null);
  const [revoking, setRevoking] = useState<ServiceTokenDto | null>(null);
  const revoke = useAdminMutation((id: string) => post(`/admin/service-tokens/${id}/revoke`, {}), ['tokens']);
  const columns: Column<ServiceTokenDto>[] = [
    { key: 'name', header: 'Name', cell: (t) => <span className="font-medium">{t.name}</span>, sortValue: (t) => t.name },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (t) => (
        <span className="flex flex-wrap gap-1">
          {t.scopes.map((s) => (
            <Badge key={s} size="xs" mono variant="outline">
              {s}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: 'used', header: 'Last used', cell: (t) => (t.last_used_at ? <TimeAgo at={t.last_used_at} className="text-fg-muted" /> : <span className="text-fg-subtle">Never</span>), width: '7rem', hideBelow: 'md' },
    { key: 'expires', header: 'Expires', cell: (t) => (t.expires_at ? <span className="text-fg-muted">{formatDateTime(t.expires_at)}</span> : <span className="text-fg-subtle">Never</span>), width: '10rem', hideBelow: 'lg' },
    { key: 'by', header: 'Created', cell: (t) => <span className="inline-flex items-center gap-1.5 text-[12.5px]">{t.created_by && <ActorLabel actor={t.created_by} />}<TimeAgo at={t.created_at} className="text-fg-subtle" /></span>, hideBelow: 'lg' },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => {
        const expired = !!t.expires_at && Date.parse(t.expires_at) < Date.now();
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
  return (
    <Panel
      title="Service tokens"
      description="Scoped bearer tokens for API, MCP and Task injection clients. The secret is shown once at creation."
      actions={
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          Create token
        </Button>
      }
      bodyClassName="p-0"
    >
      {tokens.isPending ? <Loading /> : tokens.error ? <ErrorState error={tokens.error} className="m-4" onRetry={() => tokens.refetch()} /> : <DataTable caption="Service tokens" columns={columns} rows={tokens.data ?? []} rowKey={(t) => t.token_id} rowClassName={(t) => (t.revoked_at ? 'opacity-60' : undefined)} empty={<EmptyState icon={<KeyRound size={20} />} title="No service tokens" compact />} />}
      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setSecret(t);
          }}
        />
      )}
      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Token created"
        description="Copy the secret now. It is not stored in a retrievable form and will not be shown again."
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            I've stored it
          </Button>
        }
      >
        {secret?.secret ? (
          <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{secret.secret}</code>
            <CopyButton value={secret.secret} label="Copy secret" />
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

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: CreatedServiceTokenDto) => void }) {
  const scopesQ = useQuery({ queryKey: ['admin', 'token-scopes'], queryFn: async () => ((await get<{ scopes?: string[] }>('/admin/service-tokens/scopes')).scopes ?? []) as string[], staleTime: Infinity });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const create = useAdminMutation((b: { name: string; scopes: string[]; expires_at?: string }) => post<CreatedServiceTokenDto>('/admin/service-tokens', b), ['tokens']);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Create service token"
      confirmLabel="Create token"
      confirmDisabled={!name.trim() || !scopes.length}
      onConfirm={async () => {
        try {
          const t = (await create.mutateAsync({ name: name.trim(), scopes, expires_at: expires ? new Date(expires).toISOString() : undefined })) as CreatedServiceTokenDto;
          onCreated(t);
        } catch (e) {
          toast.error('Could not create token', e);
        }
      }}
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. ticketing-bridge" />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[12.5px] font-medium text-fg">Scopes</legend>
        {scopesQ.isPending ? (
          <Loading className="py-3" />
        ) : scopesQ.error ? (
          <ErrorState error={scopesQ.error} compact />
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {(scopesQ.data ?? []).map((s) => (
              <Checkbox key={s} label={<span className="font-mono text-[12.5px]">{s}</span>} checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
            ))}
          </div>
        )}
      </fieldset>
      <Input label="Expires (optional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} min={new Date(Date.now() + 864e5).toISOString().slice(0, 10)} />
    </ConfirmDialog>
  );
}

// ----------------------------------------------------------------- broker ---

function BrokerTab() {
  const creds = useAdminList<BrokerCredentialDto>('credentials', '/admin/broker/credentials');
  const caps = useAdminList<BrokerCapabilityDto>('capabilities', '/admin/broker/capabilities');
  const audit = useQuery({ queryKey: ['admin', 'broker-audit'], queryFn: async () => asPage<Record<string, unknown>>(await get('/admin/broker/audit', { limit: 100 })).items });
  const [newCred, setNewCred] = useState(false);
  const [newCap, setNewCap] = useState(false);
  const [removing, setRemoving] = useState<{ what: 'credentials' | 'capabilities'; name: string } | null>(null);
  const remove = useAdminMutation(({ what, name }: { what: string; name: string }) => del(`/admin/broker/${what}/${encodeURIComponent(name)}`), ['credentials', 'capabilities']);

  const credCols: Column<BrokerCredentialDto>[] = [
    { key: 'name', header: 'Name', cell: (c) => <span className="font-mono font-medium">{c.name}</span>, sortValue: (c) => c.name },
    { key: 'kind', header: 'Kind', cell: (c) => <Badge size="xs">{c.kind}</Badge>, width: '8rem' },
    { key: 'created', header: 'Stored', cell: (c) => <TimeAgo at={c.updated_at ?? c.created_at} className="text-fg-muted" />, width: '7rem' },
    { key: 'x', header: <span className="sr-only">Actions</span>, align: 'right', cell: (c) => <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} aria-label={`Delete ${c.name}`} onClick={() => setRemoving({ what: 'credentials', name: c.name })} />, width: '3rem' },
  ];
  const capCols: Column<BrokerCapabilityDto>[] = [
    {
      key: 'name',
      header: 'Capability',
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-mono font-medium">{c.name}</span>
          {c.description && <span className="text-[12px] text-fg-subtle">{c.description}</span>}
        </span>
      ),
      sortValue: (c) => c.name,
    },
    { key: 'cred', header: 'Credential', cell: (c) => (c.credential ? <span className="font-mono text-[12.5px]">{c.credential}</span> : <span className="text-fg-subtle">none (egress only)</span>) },
    {
      key: 'scope',
      header: 'Scope',
      cell: (c) => (
        <span className="flex flex-col gap-0.5 font-mono text-[12px] text-fg-muted">
          <span>{(c.scope.hosts ?? []).join(', ')}</span>
          {(c.scope.methods?.length || c.scope.path_prefixes?.length) && (
            <span className="text-fg-subtle">
              {(c.scope.methods ?? ['*']).join('|')} {(c.scope.path_prefixes ?? []).join(', ')}
            </span>
          )}
        </span>
      ),
    },
    { key: 'x', header: <span className="sr-only">Actions</span>, align: 'right', cell: (c) => <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} aria-label={`Delete ${c.name}`} onClick={() => setRemoving({ what: 'capabilities', name: c.name })} />, width: '3rem' },
  ];

  return (
    <>
      <Callout tone="info" title="Tools never hold credentials">
        Tool extensions declare the capabilities they need; the broker injects the credential on their behalf and enforces host, method and path scope. Secrets are write-only here.
      </Callout>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title="Credentials"
          actions={
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setNewCred(true)}>
              Add credential
            </Button>
          }
          bodyClassName="p-0"
        >
          {creds.isPending ? <Loading /> : creds.error ? <ErrorState error={creds.error} className="m-4" /> : <DataTable caption="Credentials" columns={credCols} rows={creds.data ?? []} rowKey={(c) => c.credential_id ?? c.name} empty={<EmptyState title="No credentials stored" compact />} dense />}
        </Panel>
        <Panel
          title="Capabilities"
          actions={
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setNewCap(true)}>
              Define capability
            </Button>
          }
          bodyClassName="p-0"
        >
          {caps.isPending ? <Loading /> : caps.error ? <ErrorState error={caps.error} className="m-4" /> : <DataTable caption="Capabilities" columns={capCols} rows={caps.data ?? []} rowKey={(c) => c.capability_id ?? c.name} empty={<EmptyState title="No capabilities defined" compact />} dense />}
        </Panel>
      </div>
      <Panel title="Recent broker activity" description="Every brokered request, allowed or denied." bodyClassName="p-0">
        {audit.isPending ? <Loading /> : audit.error ? <ErrorState error={audit.error} className="m-4" /> : <AuditTable rows={audit.data ?? []} />}
      </Panel>
      {newCred && <CredentialDialog onClose={() => setNewCred(false)} />}
      {newCap && <CapabilityDialog credentials={(creds.data ?? []).map((c) => c.name)} onClose={() => setNewCap(false)} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Delete ${removing?.what === 'credentials' ? 'credential' : 'capability'} ${removing?.name}?`}
        description="Tools relying on it will fail their brokered calls until it is replaced."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(removing!);
            toast.success('Deleted');
            setRemoving(null);
          } catch (e) {
            toast.error('Could not delete', e);
          }
        }}
      />
    </>
  );
}

function AuditTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const cols: Column<Record<string, unknown>>[] = [
    { key: 'at', header: 'When', cell: (r) => <TimeAgo at={String(r.at ?? '')} className="text-fg-muted" />, width: '7rem' },
    { key: 'cap', header: 'Capability', cell: (r) => <span className="font-mono text-[12.5px]">{String(r.capability ?? '')}</span> },
    { key: 'req', header: 'Request', cell: (r) => <span className="font-mono text-[12px] text-fg-muted">{String(r.method ?? '')} {String(r.target_host ?? '')}{String(r.target_path ?? '')}</span> },
    { key: 'session', header: 'Session', cell: (r) => (r.session_id ? <span className="font-mono text-[12px]">{String(r.session_id).slice(0, 14)}</span> : <span className="text-fg-subtle">—</span>), hideBelow: 'lg' },
    {
      key: 'ok',
      header: 'Result',
      cell: (r) =>
        r.ok ? (
          <Badge size="xs" tone="ok" icon={<CheckCircle2 size={11} />}>
            {r.response_status ? String(r.response_status) : 'ok'}
          </Badge>
        ) : (
          <Badge size="xs" tone="danger" icon={<XCircle size={11} />} title={String(r.error ?? '')}>
            {r.response_status ? String(r.response_status) : 'denied'}
          </Badge>
        ),
      width: '6rem',
    },
  ];
  return <DataTable caption="Broker audit" columns={cols} rows={rows} rowKey={(r) => String(r.audit_id ?? `${r.at}-${r.capability}`)} empty={<EmptyState title="No brokered requests yet" compact />} dense maxHeight="28rem" />;
}

function CredentialDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('bearer');
  const [secret, setSecret] = useState('');
  const [structured, setStructured] = useState(false);
  const create = useAdminMutation((b: { name: string; kind: string; secret: string | Record<string, string> }) => post('/admin/broker/credentials', b), ['credentials']);
  let value: string | Record<string, string> | null = secret || null;
  let err: string | null = null;
  if (structured && secret.trim()) {
    try {
      const v = JSON.parse(secret);
      if (typeof v !== 'object' || v === null || Array.isArray(v) || !Object.values(v).every((x) => typeof x === 'string')) err = 'Must be a JSON object of string values.';
      else value = v as Record<string, string>;
    } catch (e) {
      err = errorMessage(e);
    }
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Add credential"
      description="Stored encrypted by the broker. It can be replaced or deleted, never read back."
      confirmLabel="Store credential"
      confirmDisabled={!name.trim() || !value || !!err}
      onConfirm={async () => {
        try {
          await create.mutateAsync({ name: name.trim(), kind, secret: value! });
          toast.success('Credential stored');
          onClose();
        } catch (e) {
          toast.error('Could not store credential', e);
        }
      }}
    >
      <div className="grid grid-cols-[1fr_9rem] gap-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. github-token" />
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} options={['bearer', 'basic', 'header', 'aws', 'oauth2', 'other'].map((k) => ({ value: k, label: humanize(k) }))} />
      </div>
      <Checkbox label="Structured secret (JSON object of strings)" checked={structured} onChange={(e) => setStructured(e.target.checked)} />
      {structured ? (
        <TextArea label="Secret" mono rows={5} value={secret} onChange={(e) => setSecret(e.target.value)} error={err ?? undefined} placeholder={'{"username": "…", "password": "…"}'} autoComplete="off" />
      ) : (
        <Input label="Secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoComplete="off" />
      )}
    </ConfirmDialog>
  );
}

const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function CapabilityDialog({ credentials, onClose }: { credentials: string[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [credential, setCredential] = useState('');
  const [desc, setDesc] = useState('');
  const [hosts, setHosts] = useState('');
  const [methods, setMethods] = useState('');
  const [paths, setPaths] = useState('');
  const create = useAdminMutation((b: Record<string, unknown>) => post('/admin/broker/capabilities', b), ['capabilities']);
  const hostList = splitList(hosts);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Define capability"
      description="A named, scoped permission tools can declare. Requests outside the scope are denied and audited."
      confirmLabel="Define capability"
      confirmDisabled={!name.trim() || !hostList.length}
      onConfirm={async () => {
        const m = splitList(methods).map((x) => x.toUpperCase());
        const p = splitList(paths);
        try {
          await create.mutateAsync({ name: name.trim(), credential: credential || null, description: desc.trim() || undefined, scope: { hosts: hostList, ...(m.length ? { methods: m } : {}), ...(p.length ? { path_prefixes: p } : {}) } });
          toast.success('Capability defined');
          onClose();
        } catch (e) {
          toast.error('Could not define capability', e);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. github.read" />
        <Select label="Credential" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="None (egress only)" options={credentials.map((c) => ({ value: c, label: c }))} />
      </div>
      <Input label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <Input label="Hosts" value={hosts} onChange={(e) => setHosts(e.target.value)} required placeholder="api.github.com, *.example.com" hint="Comma or space separated." />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Methods (optional)" value={methods} onChange={(e) => setMethods(e.target.value)} placeholder="GET, POST" />
        <Input label="Path prefixes (optional)" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/repos/" />
      </div>
    </ConfirmDialog>
  );
}

// ----------------------------------------------------------------- health ---

interface HealthDetail {
  sandbox?: { kind?: string; ok?: boolean; detail?: string; warm?: Record<string, number>; error?: string };
  gateway?: { providers?: unknown; fallback_events?: unknown };
  dispatcher?: { running?: number; max_concurrent_runs?: number; queued?: number; spend_last_hour_usd?: number; max_spend_usd_per_hour?: number; error?: string; [k: string]: unknown };
  connectors?: unknown;
  db?: string;
}

function HealthTab() {
  const basic = useQuery({ queryKey: ['health'], queryFn: () => get<Record<string, unknown>>('/health'), refetchInterval: 30_000 });
  const detail = useQuery({ queryKey: ['admin', 'health-detail'], queryFn: () => get<HealthDetail>('/admin/health/detail'), refetchInterval: 30_000 });
  if (detail.isPending || basic.isPending) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  const d = detail.data ?? {};
  const b = basic.data ?? {};
  const sandboxOk = d.sandbox?.ok !== false && !d.sandbox?.error;
  const disp = d.dispatcher ?? {};
  const fallbacks = Array.isArray(d.gateway?.fallback_events) ? (d.gateway!.fallback_events as unknown[]) : [];
  const connectors = Array.isArray(d.connectors) ? (d.connectors as Array<Record<string, unknown>>) : [];
  const brokenConnectors = connectors.filter((c) => c.last_error);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HealthTile label="Server" ok={b.ok !== false} value={`${String(b.name ?? 'breadboard')} ${String(b.version ?? '')}`.trim()} detail={b.db ? `db: ${typeof b.db === 'string' ? b.db : JSON.stringify(b.db)}` : d.db ? `db: ${d.db}` : undefined} />
        <HealthTile label="Tool sandbox" ok={sandboxOk} value={d.sandbox?.kind ?? 'unknown'} detail={d.sandbox?.error ?? d.sandbox?.detail} />
        <HealthTile
          label="Dispatcher"
          ok={!disp.error}
          value={disp.error ? 'unavailable' : `${disp.running ?? 0} / ${disp.max_concurrent_runs ?? '∞'} running`}
          detail={disp.error ? String(disp.error) : `${disp.queued ?? 0} queued · ${formatCost(disp.spend_last_hour_usd ?? 0)} of ${disp.max_spend_usd_per_hour != null ? formatCost(disp.max_spend_usd_per_hour) : '∞'} this hour`}
        />
        <HealthTile label="Connectors" ok={!brokenConnectors.length} warn={brokenConnectors.length > 0} value={`${connectors.length} configured`} detail={brokenConnectors.length ? `${brokenConnectors.length} failing` : 'All syncing'} />
      </div>
      {d.sandbox?.kind === 'process' && (
        <Callout tone="warn" title="Unisolated sandbox">
          Tools run as local processes without container isolation. Use the Docker runtime outside local development.
        </Callout>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Model gateway">
          <JsonView value={d.gateway?.providers ?? null} defaultExpandDepth={2} />
          <h3 className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Recent fallbacks ({fallbacks.length})</h3>
          {fallbacks.length ? <JsonView value={fallbacks.slice(0, 20)} defaultExpandDepth={1} maxHeight="16rem" /> : <p className="text-[12.5px] text-fg-subtle">No fallbacks recorded.</p>}
        </Panel>
        <Panel title="Connectors">
          {connectors.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {connectors.map((c, i) => (
                <li key={String(c.tool_uid ?? i)} className="flex items-center gap-3 py-2 text-[13px]">
                  {c.last_error ? <AlertTriangle size={14} className="text-danger-fg" aria-label="Failing" /> : <CheckCircle2 size={14} className="text-ok-fg" aria-label="Healthy" />}
                  <span className="font-mono">{String(c.slug ?? c.tool_uid ?? 'connector')}</span>
                  {c.last_error ? <span className="min-w-0 flex-1 truncate text-[12px] text-danger-fg" title={String(c.last_error)}>{String(c.last_error)}</span> : <span className="flex-1" />}
                  <span className="text-[12px] text-fg-subtle">{c.last_sync_at ? <TimeAgo at={String(c.last_sync_at)} prefix="synced " /> : 'never synced'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-fg-subtle">No knowledge connectors configured.</p>
          )}
        </Panel>
      </div>
      <Panel title="Raw health detail">
        <JsonView value={d} defaultExpandDepth={1} maxHeight="24rem" />
      </Panel>
    </>
  );
}

function HealthTile({ label, ok, warn, value, detail }: { label: string; ok: boolean; warn?: boolean; value: string; detail?: string }) {
  const tone = ok ? 'ok' : warn ? 'warn' : 'danger';
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
        <Icon size={14} className={tone === 'ok' ? 'text-ok-fg' : tone === 'warn' ? 'text-warn-fg' : 'text-danger-fg'} aria-hidden />
        {label}
        <span className="sr-only">{ok ? 'healthy' : warn ? 'degraded' : 'unhealthy'}</span>
      </span>
      <span className="truncate text-[15px] font-semibold text-fg">{value}</span>
      {detail && <span className="line-clamp-2 text-[12px] text-fg-subtle" title={detail}>{detail}</span>}
    </div>
  );
}
