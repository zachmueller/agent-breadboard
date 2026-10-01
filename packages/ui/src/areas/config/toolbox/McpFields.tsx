/**
 * MCP onboarding fields ([06] §9, shared `zMcpServer`): transport, endpoint or command/args/env,
 * broker auth capability, default tool allowlist. Used by the onboarding dialog and the MCP editor.
 */
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, Btn, Field, SelectInput, TextInput } from '../ui';
import { LazyInput, TagsInput } from '../components/fields';
import { listOf } from '../lib/configApi';
import { setOrDelete } from '../circuits/StepInspector';

export type Patch = (fn: (d: any) => void) => void;

/** Broker capability names (admin-only endpoint; silently empty for non-admins). */
export function useBrokerCapabilities() {
  return useQuery({
    queryKey: ['broker', 'capabilities'],
    queryFn: async () => listOf<{ name: string; description?: string; credential?: string | null }>(await api.get('/admin/broker/capabilities')),
    retry: false,
    staleTime: 60_000,
  });
}

export function McpFields({ value, patch, compact }: { value: any; patch: Patch; compact?: boolean }) {
  const caps = useBrokerCapabilities();
  const transport: string = value?.transport ?? 'http';
  const env: Record<string, string> = value?.env && typeof value.env === 'object' ? value.env : {};
  const allow: string[] | undefined = Array.isArray(value?.tools?.allow) ? value.tools.allow : undefined;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[10rem_1fr]">
        <Field label="Transport">
          <SelectInput
            value={transport}
            onChange={(e) =>
              patch((d) => {
                d.transport = e.target.value;
                if (e.target.value === 'stdio') delete d.endpoint;
                else {
                  delete d.command;
                  delete d.args;
                }
              })
            }
          >
            <option value="http">http (streamable)</option>
            <option value="sse">sse</option>
            <option value="stdio">stdio</option>
          </SelectInput>
        </Field>
        {transport === 'stdio' ? (
          <Field label="Command" hint="Launched inside the Breadboard sandbox.">
            <LazyInput mono value={value?.command ?? ''} placeholder="npx" onCommit={(v) => patch((d) => setOrDelete(d, 'command', v))} />
          </Field>
        ) : (
          <Field label="Endpoint">
            <LazyInput mono value={value?.endpoint ?? ''} placeholder="https://mcp.example.com/mcp" validate={(v) => (!v || /^https?:\/\//.test(v) ? null : 'must be an http(s) URL')} onCommit={(v) => patch((d) => setOrDelete(d, 'endpoint', v))} />
          </Field>
        )}
      </div>
      {transport === 'stdio' && (
        <>
          <Field label="Arguments">
            <TagsInput value={Array.isArray(value?.args) ? value.args : []} onChange={(v) => patch((d) => setOrDelete(d, 'args', v.length ? v : undefined))} placeholder="-y, @scope/server" />
          </Field>
          <Field label="Environment" hint="Non-secret values only; secrets come from the broker capability below.">
            <div className="space-y-1">
              {Object.entries(env).map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <TextInput className="w-40 font-mono text-xs" value={k} readOnly />
                  <LazyInput mono value={v} onCommit={(nv) => patch((d) => void ((d.env ??= {})[k] = nv))} />
                  <Btn size="xs" variant="ghost" aria-label={`Remove ${k}`} icon={<Trash2 className="size-3.5" />} onClick={() => patch((d) => (delete d.env?.[k], d.env && !Object.keys(d.env).length && delete d.env))} />
                </div>
              ))}
              <Btn
                size="xs"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={() => {
                  const k = window.prompt('Environment variable name');
                  if (k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) patch((d) => void ((d.env ??= {})[k] = ''));
                }}
              >
                Add variable
              </Btn>
            </div>
          </Field>
        </>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Auth capability" hint="Broker capability whose credential is attached when connecting. Leave empty for unauthenticated servers.">
          <LazyInput mono value={value?.auth?.capability ?? ''} placeholder={caps.data?.[0]?.name ?? 'capability name'} onCommit={(v) => patch((d) => (v ? (d.auth = { ...(d.auth ?? {}), capability: v }) : delete d.auth))} />
          {(caps.data ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
              {caps.data!.map((c) => (
                <button key={c.name} type="button" title={c.description} className="rounded border border-line px-1.5 font-mono hover:bg-hover" onClick={() => patch((d) => (d.auth = { ...(d.auth ?? {}), capability: c.name }))}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </Field>
        {value?.auth && (
          <Field label="Apply credential as" hint={transport === 'stdio' ? 'env:<NAME> for stdio servers.' : 'header = Authorization: Bearer.'}>
            <LazyInput mono value={value.auth.apply ?? 'header'} onCommit={(v) => patch((d) => (d.auth.apply = v || 'header'))} />
          </Field>
        )}
      </div>
      <Field label="Default tool allowlist" hint="Server tools Subagents may call. Empty list = none; per-Subagent grants can narrow further.">
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={allow === undefined} onChange={(e) => patch((d) => (e.target.checked ? delete d.tools?.allow : (d.tools = { ...(d.tools ?? {}), allow: [] })))} />
            Allow every tool the server offers
          </label>
          {allow !== undefined && <TagsInput value={allow} onChange={(v) => patch((d) => (d.tools = { ...(d.tools ?? {}), allow: v }))} placeholder="search, read_document" />}
        </div>
      </Field>
      {!compact && (
        <Field label="Description">
          <LazyInput value={value?.description ?? ''} onCommit={(v) => patch((d) => (d.description = v))} />
        </Field>
      )}
    </div>
  );
}
