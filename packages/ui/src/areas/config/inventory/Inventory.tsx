/**
 * Shared inventory chrome ([03] §8.1, [05] §7, [06] §10): page header, search box, tables, the
 * "new definition" dialog (`POST /config/new` skeleton, then `POST /config/commit`), last-modified cell.
 */
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Btn, Modal, Field, TextInput, SelectInput, errorMessage, notify, Spin } from '../ui';
import { ConfigPicker } from '../components/ConfigPicker';
import { useGo } from '../components/AppLink';
import { configApi, qk, useHistory, usePresets } from '../lib/configApi';
import { fmtRelative, fmtDate, hrefFor, slugify } from '../lib/format';
import { uidFromChanges, SLUG_RE } from '../lib/inventory';

export function InventoryShell({ title, subtitle, actions, query, onQuery, children }: { title: string; subtitle: ReactNode; actions?: ReactNode; query: string; onQuery: (q: string) => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-page">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          <div className="text-xs text-fg-muted">{subtitle}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute top-2 left-2 size-4 text-fg-subtle" />
            <TextInput aria-label="Search" className="h-8 w-64 pl-8" placeholder="Search slug, title, tags…" value={query} onChange={(e) => onQuery(e.target.value)} />
          </label>
          {actions}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-sunken text-left text-xs text-fg-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function TableEmpty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-xs text-fg-subtle">{children}</div>;
}

/** Last commit touching a definition path (one history call per visible row). */
export function LastModified({ path }: { path: string }) {
  const h = useHistory(path, 1);
  if (h.isLoading) return <Spin className="size-3" />;
  const c = h.data?.[0];
  if (!c) return <span className="text-fg-subtle">–</span>;
  return (
    <span title={`${fmtDate(c.date)} · ${c.author} · ${c.message}`} className="whitespace-nowrap">
      {fmtRelative(c.date)}
      <span className="ml-1 text-fg-subtle">{c.author}</span>
    </span>
  );
}

export type NewKind = 'circuit' | 'subagent' | 'tool' | 'mcp';
const NOUN: Record<NewKind, string> = { circuit: 'circuit', subagent: 'subagent', tool: 'tool extension', mcp: 'MCP server' };

/** Mint a skeleton, commit it to main, open its editor. */
export function NewDefinitionDialog({ kind, open, onClose, extra }: { kind: NewKind; open: boolean; onClose: () => void; extra?: ReactNode }) {
  const go = useGo();
  const qc = useQueryClient();
  const presets = usePresets();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript');
  const [subagent, setSubagent] = useState<string | null>(null);
  const [preset, setPreset] = useState('medium');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const effSlug = slugTouched ? slug : slugify(title);
  const slugErr = effSlug && !SLUG_RE.test(effSlug) ? 'lowercase letters, digits and dashes' : null;
  const presetNames = Object.keys(presets.data?.presets ?? {});
  const ready = !!effSlug && !slugErr && (kind !== 'circuit' || !!subagent);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Parameters<typeof configApi.newDefinition>[0] & Record<string, unknown> = { kind, slug: effSlug, title: title.trim() || effSlug };
      if (kind === 'tool') body.language = language;
      if (kind === 'circuit' && subagent) body.subagent = subagent;
      if (kind === 'subagent') body.model_preset = preset;
      if (kind === 'mcp' && endpoint.trim()) body.endpoint = endpoint.trim();
      const { changes, uid: mintedUid } = await configApi.newDefinition(body);
      const uid = mintedUid ?? uidFromChanges(changes, kind);
      await configApi.commit(changes, `Add ${NOUN[kind]} ${effSlug}`);
      await qc.invalidateQueries({ queryKey: qk.tree() });
      notify(`Created ${NOUN[kind]} ${effSlug}`, 'ok');
      onClose();
      const href = uid ? hrefFor(kind, uid) : null;
      if (href) go(href);
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
      title={`New ${NOUN[kind]}`}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" loading={busy} disabled={!ready} onClick={submit}>
            Create and commit
          </Btn>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Title">
          <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'circuit' ? 'Literature review' : kind === 'subagent' ? 'Research scout' : 'Search scholarly'} />
        </Field>
        <Field label="Slug" hint="Display metadata only; the file is named by an immutable UID." error={slugErr}>
          <TextInput
            className="font-mono"
            value={effSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        {kind === 'tool' && (
          <Field label="Language">
            <div className="flex gap-4 pt-1 text-sm">
              {(['typescript', 'python'] as const).map((l) => (
                <label key={l} className="flex items-center gap-1.5">
                  <input type="radio" name="tool-language" checked={language === l} onChange={() => setLanguage(l)} />
                  {l === 'typescript' ? 'TypeScript' : 'Python'}
                </label>
              ))}
            </div>
          </Field>
        )}
        {kind === 'circuit' && (
          <Field label="Entry-step subagent" hint="The skeleton has one LLM step; pick who runs it.">
            <ConfigPicker kind="subagent" value={subagent} onChange={setSubagent} placeholder="Pick a subagent" showLink={false} />
          </Field>
        )}
        {kind === 'subagent' && (
          <Field label="Model preset">
            <SelectInput value={preset} onChange={(e) => setPreset(e.target.value)}>
              {(presetNames.length ? presetNames : ['small', 'medium', 'large']).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </SelectInput>
          </Field>
        )}
        {kind === 'mcp' && (
          <Field label="Endpoint" hint="HTTP/SSE URL. For stdio servers, set transport and command in the editor after creating.">
            <TextInput className="font-mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
        )}
        {extra}
        <p className="text-xs text-fg-muted">The skeleton is committed straight to main so you can open the editor; refine it there (or through the designer chat).</p>
        {err != null && <div className="text-xs text-danger-fg">{errorMessage(err)}</div>}
      </div>
    </Modal>
  );
}
