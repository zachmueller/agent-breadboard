/** Properties panel bound to the live `properties` Y.Map ([07] §2): title, domains, aliases, generic keys; tags via PATCH. */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type * as Y from 'yjs';
import type { NodeDto } from '@breadboard/shared';
import { asPage, errorMessage, get } from '../../../lib/api';
import { usePatchNode } from '../../../lib/queries';
import { toast } from '../../../lib/toast';
import { Badge, IconButton, Input, TagChip, cn } from '../../../components';
import { asStringArray, useYMapSnapshot } from './useYMap';

export interface DomainDto {
  slug: string;
  description?: string;
  note_count?: number;
}

export function useKnowledgeDomains() {
  return useQuery({
    queryKey: ['knowledge', 'domains'],
    queryFn: async () => asPage<DomainDto>(await get('/knowledge/domains')).items,
    staleTime: 5 * 60_000,
  });
}

/** Keys with dedicated controls (not shown in the generic editor). */
const KNOWN_KEYS = new Set(['title', 'domains', 'aliases', 'tags']);
/** Server-owned keys ([07] §8): shown read-only. */
export const RESERVED_KEYS = new Set(['external_id', 'source_url', 'source_updated_at', 'connector', 'status', 'need-input', 'status_history', 'origin']);
/** Structured tags the user can't remove here. */
export function isStructuredTag(t: string): boolean {
  return t === 'read-only' || t === 'need-input' || t.startsWith('connector:') || t.startsWith('origin:') || t.startsWith('possible-dup-of:');
}

export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v);
}

/** Parse an edited value: JSON-looking input is parsed, anything else stays a string. */
export function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (/^(\{|\[|"|-?\d|true$|false$|null$)/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function PropertiesPanel({ doc, node, readOnly }: { doc: Y.Doc; node: NodeDto | undefined; readOnly: boolean }) {
  const map = useMemo(() => doc.getMap<unknown>('properties'), [doc]);
  const props = useYMapSnapshot(map);
  const set = (k: string, v: unknown) => doc.transact(() => (v === undefined ? map.delete(k) : map.set(k, v)));

  return (
    <div className="flex flex-col gap-5 p-4">
      <TitleField value={typeof props.title === 'string' ? props.title : (node?.title ?? '')} readOnly={readOnly} onCommit={(v) => set('title', v)} />
      <DomainsField value={asStringArray(props.domains)} readOnly={readOnly} onChange={(v) => set('domains', v)} />
      <ChipListField label="Aliases" hint="Alternative names used by search and link autocomplete." value={asStringArray(props.aliases)} readOnly={readOnly} onChange={(v) => set('aliases', v.length ? v : undefined)} />
      {node && <TagsField node={node} readOnly={readOnly} />}
      <GenericFields props={props} readOnly={readOnly} onSet={set} />
    </div>
  );
}

function SectionLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="mb-1.5">
      <div className="text-xs font-medium tracking-wide text-fg-muted uppercase">{children}</div>
      {hint && <div className="text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}

function TitleField({ value, readOnly, onCommit }: { value: string; readOnly: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <Input
      label="Title"
      size="sm"
      value={draft}
      disabled={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function DomainsField({ value, readOnly, onChange }: { value: string[]; readOnly: boolean; onChange: (v: string[]) => void }) {
  const domains = useKnowledgeDomains();
  const known = domains.data ?? [];
  const all = [...known.map((d) => d.slug), ...value.filter((v) => !known.some((d) => d.slug === v))];
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((v) => v !== slug) : [...value, slug]);
  return (
    <div>
      <SectionLabel hint="Knowledge Domains scope which subagents and circuits can read this note.">Domains</SectionLabel>
      {domains.isPending ? (
        <div className="text-xs text-fg-subtle">Loading domains…</div>
      ) : !all.length ? (
        <div className="text-xs text-fg-subtle">No domains are configured.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Domains">
          {all.map((slug) => {
            const on = value.includes(slug);
            const d = known.find((x) => x.slug === slug);
            return (
              <button
                key={slug}
                type="button"
                aria-pressed={on}
                disabled={readOnly}
                title={d?.description || slug}
                onClick={() => toggle(slug)}
                className={cn(
                  'h-6 rounded-md border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface text-fg-muted hover:bg-hover',
                  !d && 'border-dashed',
                )}
              >
                {slug}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChipListField({ label, hint, value, readOnly, onChange }: { label: string; hint?: string; value: string[]; readOnly: boolean; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div>
      <SectionLabel hint={hint}>{label}</SectionLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((v) => (
          <TagChip key={v} tag={v} onRemove={readOnly ? undefined : () => onChange(value.filter((x) => x !== v))} />
        ))}
        {!readOnly && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={add}
            placeholder={value.length ? 'Add…' : `Add ${label.toLowerCase()}…`}
            aria-label={`Add ${label.toLowerCase()}`}
            className="h-6 min-w-[6rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xs outline-none focus:border-line"
          />
        )}
      </div>
    </div>
  );
}

function TagsField({ node, readOnly }: { node: NodeDto; readOnly: boolean }) {
  const mut = usePatchNode(node.uid);
  const save = (tags: string[]) =>
    mut.mutate(
      { tags },
      { onError: (e) => toast.error('Couldn’t update tags', errorMessage(e)) },
    );
  const tags = node.tags ?? [];
  const editable = tags.filter((t) => !isStructuredTag(t));
  const structured = tags.filter(isStructuredTag);
  return (
    <div>
      <ChipListField label="Tags" value={editable} readOnly={readOnly || mut.isPending} onChange={(v) => save([...structured, ...v])} />
      {structured.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {structured.map((t) => (
            <Badge key={t} size="xs" variant="outline" mono title="System tag">
              {t}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function GenericFields({ props, readOnly, onSet }: { props: Record<string, unknown>; readOnly: boolean; onSet: (k: string, v: unknown) => void }) {
  const keys = Object.keys(props)
    .filter((k) => !KNOWN_KEYS.has(k))
    .sort();
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const keyError = newKey && (KNOWN_KEYS.has(newKey) || RESERVED_KEYS.has(newKey) || keys.includes(newKey)) ? 'Key already exists or is reserved' : null;
  const add = () => {
    const k = newKey.trim();
    if (!k || keyError) return;
    onSet(k, parseValue(newVal));
    setNewKey('');
    setNewVal('');
  };
  return (
    <div>
      <SectionLabel hint="Free-form properties; JSON values are parsed.">Other properties</SectionLabel>
      {keys.length === 0 && <div className="mb-2 text-xs text-fg-subtle">None.</div>}
      <dl className="flex flex-col gap-1.5">
        {keys.map((k) => (
          <KvRow key={k} k={k} value={props[k]} readOnly={readOnly || RESERVED_KEYS.has(k)} reserved={RESERVED_KEYS.has(k)} onSet={onSet} />
        ))}
      </dl>
      {!readOnly && (
        <div className="mt-3 flex items-start gap-1.5">
          <Input size="sm" placeholder="key" aria-label="New property key" value={newKey} onChange={(e) => setNewKey(e.target.value)} error={keyError ?? undefined} wrapperClassName="w-28" className="font-mono" />
          <Input size="sm" placeholder="value" aria-label="New property value" value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} wrapperClassName="flex-1" />
          <IconButton label="Add property" variant="secondary" onClick={add} disabled={!newKey.trim() || !!keyError}>
            <Plus size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function KvRow({ k, value, readOnly, reserved, onSet }: { k: string; value: unknown; readOnly: boolean; reserved: boolean; onSet: (k: string, v: unknown) => void }) {
  const shown = formatValue(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    if (draft !== shown) onSet(k, parseValue(draft));
  };
  return (
    <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-1.5">
      <dt className="truncate font-mono text-xs text-fg-muted" title={reserved ? `${k} (server-owned)` : k}>
        {k}
      </dt>
      <dd className="min-w-0">
        {readOnly ? (
          <div className="truncate rounded px-1.5 py-1 text-xs text-fg" title={shown}>
            {shown || <span className="text-fg-subtle">empty</span>}
          </div>
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            aria-label={`Value of ${k}`}
            className="h-7 w-full rounded-md border border-line bg-surface px-2 text-xs outline-none focus:border-accent"
          />
        )}
      </dd>
      {!readOnly ? (
        <IconButton label={`Remove ${k}`} size="xs" onClick={() => onSet(k, undefined)}>
          <Trash2 size={13} />
        </IconButton>
      ) : (
        <span />
      )}
    </div>
  );
}

