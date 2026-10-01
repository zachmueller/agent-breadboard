/**
 * Fixture manifest editor ([04] §3, §8): tag, retire, annotate pinned inputs in `fixtures.yaml`,
 * and promote a production Session into a fixture (server commits it to main).
 */
import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, ChevronDown, ChevronRight, ArrowUpFromLine } from 'lucide-react';
import { useWorkingTree } from '../../model/workingTree';
import { Btn, Pill, TextInput, Modal, Field, errorMessage, notify, Json } from '../../ui';
import { LazyInput, TagsInput, ValidationList } from '../../components/fields';
import { CodeEditor } from '../../components/CodeEditor';
import { AppLink } from '../../components/AppLink';
import { parseYamlValue } from '../../lib/yamlDoc';
import { evalsApi } from '../../lib/configApi';
import { fixturesPathOf, fixturesTemplate, errorsForFile } from './shared';
import { setOrDelete } from '../StepInspector';

export function FixturesEditor() {
  const wt = useWorkingTree();
  const path = fixturesPathOf(wt);
  const [showRetired, setShowRetired] = useState(false);
  const [filter, setFilter] = useState('');
  const [yamlMode, setYamlMode] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [promote, setPromote] = useState(false);
  useEffect(() => {
    if (path) wt.ensureFile(path);
  }, [path]);
  const text = path ? wt.getFile(path) : undefined;
  const parsed = useMemo(() => (text ? parseYamlValue(text) : null), [text]);
  if (!path) return null;
  if (text === undefined && !wt.state.missing.has(path)) return <div className="p-4 text-xs text-fg-subtle">Loading fixtures…</div>;

  const fixtures: any[] = parsed?.ok && Array.isArray((parsed.value as any)?.fixtures) ? (parsed.value as any).fixtures : [];
  const allTags = [...new Set(fixtures.flatMap((f) => (Array.isArray(f?.tags) ? f.tags : [])))].sort();
  const visible = fixtures
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => (showRetired || !f?.retired) && (!filter || f?.tags?.includes(filter)));
  const edit = (i: number, fn: (f: any) => void) => wt.editYamlFile((d) => d.fixtures?.[i] && fn(d.fixtures[i]), path);
  const errors = errorsForFile(wt.errors, path);
  const retired = fixtures.filter((f) => f?.retired).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-muted">
          {fixtures.length - retired} active{retired ? `, ${retired} retired` : ''}
        </span>
        {allTags.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-fg-subtle">tag</span>
            <button type="button" className={`rounded px-1.5 py-0.5 ${!filter ? 'bg-hover font-medium' : 'hover:bg-hover'}`} onClick={() => setFilter('')}>
              all
            </button>
            {allTags.map((t) => (
              <button key={t} type="button" className={`rounded px-1.5 py-0.5 font-mono ${filter === t ? 'bg-hover font-medium' : 'hover:bg-hover'}`} onClick={() => setFilter(t)}>
                {t}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> show retired
        </label>
        {wt.state.dirty.has(path) && <Pill tone="warn">unsaved</Pill>}
        <div className="ml-auto flex gap-1">
          <Btn size="xs" variant="ghost" onClick={() => setYamlMode(!yamlMode)}>
            {yamlMode ? 'Table' : 'YAML'}
          </Btn>
          <Btn size="xs" variant="secondary" icon={<ArrowUpFromLine className="size-3.5" />} onClick={() => setPromote(true)}>
            Promote session
          </Btn>
        </div>
      </div>
      {errors.length > 0 && <ValidationList errors={errors} />}

      {text == null ? (
        <div className="rounded-md border border-dashed border-line p-6 text-center">
          <div className="mb-1 text-sm font-medium">No fixtures yet</div>
          <p className="mb-3 text-xs text-fg-muted">Fixtures pin circuit inputs; eval runs execute the circuit fresh against them. Promote interesting production Sessions, or start an empty manifest.</p>
          <Btn size="sm" icon={<FilePlus2 className="size-3.5" />} onClick={() => wt.setFile(path, fixturesTemplate(wt.uid))}>
            Create fixtures.yaml
          </Btn>
        </div>
      ) : yamlMode || !parsed?.ok ? (
        <>
          {parsed && !parsed.ok && <div className="text-xs text-danger-fg">YAML error: {parsed.error}</div>}
          <CodeEditor language="yaml" value={text} onChange={(t) => wt.setFile(path, t)} minHeight={300} ariaLabel="fixtures.yaml" />
        </>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-line p-4 text-center text-xs text-fg-subtle">No fixtures match.</div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line">
          <table className="w-full text-xs">
            <thead className="bg-sunken text-left text-fg-muted">
              <tr>
                <th className="w-6" />
                <th className="px-2 py-1.5 font-medium">Fixture</th>
                <th className="px-2 py-1.5 font-medium">Tags</th>
                <th className="px-2 py-1.5 font-medium">Source</th>
                <th className="px-2 py-1.5 font-medium">Notes</th>
                <th className="px-2 py-1.5 font-medium">Retired</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ f, i }) => {
                const id = String(f?.fixture_id ?? i);
                const expanded = open.has(id);
                return (
                  <FixtureRows
                    key={id}
                    f={f}
                    expanded={expanded}
                    onToggle={() => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
                    edit={(fn) => edit(i, fn)}
                    tagSuggestions={allTags}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {promote && <PromoteDialog onClose={() => setPromote(false)} fixturesDirty={wt.state.dirty.has(path)} tagSuggestions={allTags} />}
    </div>
  );
}

function FixtureRows({ f, expanded, onToggle, edit, tagSuggestions }: { f: any; expanded: boolean; onToggle: () => void; edit: (fn: (f: any) => void) => void; tagSuggestions: string[] }) {
  return (
    <>
      <tr className={`border-t border-line align-top ${f?.retired ? 'opacity-60' : ''}`}>
        <td className="py-1.5 pl-1">
          <button type="button" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={onToggle} className="rounded p-0.5 hover:bg-hover">
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </td>
        <td className="px-2 py-1.5">
          <LazyInput value={f?.title ?? ''} onCommit={(v) => edit((x) => void (x.title = v))} />
          <div className="mt-0.5 font-mono text-[10px] text-fg-subtle">{f?.fixture_id}</div>
        </td>
        <td className="w-56 px-2 py-1.5">
          <TagsInput value={Array.isArray(f?.tags) ? f.tags : []} onChange={(v) => edit((x) => setOrDelete(x, 'tags', v))} placeholder={tagSuggestions.length ? tagSuggestions.slice(0, 3).join(', ') : 'regression, smoke'} />
        </td>
        <td className="px-2 py-1.5 font-mono">{f?.source_session_id ? <AppLink href={`/s/${f.source_session_id}`} className="text-accent-text hover:underline">{String(f.source_session_id).slice(0, 12)}…</AppLink> : <span className="text-fg-subtle">manual</span>}</td>
        <td className="px-2 py-1.5">
          <LazyInput value={f?.notes ?? ''} placeholder="Why this fixture matters" onCommit={(v) => edit((x) => setOrDelete(x, 'notes', v))} />
        </td>
        <td className="px-2 py-1.5">
          <input type="checkbox" aria-label="Retired" checked={!!f?.retired} onChange={(e) => edit((x) => setOrDelete(x, 'retired', e.target.checked || undefined))} />
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-line bg-sunken">
          <td />
          <td colSpan={5} className="space-y-2 px-2 py-2">
            <div className="text-[11px] font-medium text-fg-muted">Pinned input</div>
            <Json value={f?.input ?? null} />
            {Array.isArray(f?.pinned_context) && f.pinned_context.length > 0 && (
              <div className="text-[11px] text-fg-muted">
                Pinned context:{' '}
                {f.pinned_context.map((r: any) => (
                  <AppLink key={r.uid} href={`/n/${r.uid}?rev=${r.revision_id}`} className="mr-2 font-mono text-accent-text hover:underline">
                    {r.uid}@{r.revision_id}
                  </AppLink>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PromoteDialog({ onClose, fixturesDirty, tagSuggestions }: { onClose: () => void; fixturesDirty: boolean; tagSuggestions: string[] }) {
  const wt = useWorkingTree();
  const [session, setSession] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>(['regression']);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await evalsApi.promoteFixture({ session_id: session.trim(), fixture_title: title.trim(), tags, notes: notes.trim() || undefined });
      notify(`Promoted to fixture ${r.fixture_id}`, 'ok');
      await wt.reload({ keepEdits: true });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Promote a Session to a fixture"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" loading={busy} disabled={!session.trim() || !title.trim() || fixturesDirty} onClick={submit}>
            Promote
          </Btn>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-fg-muted">The Session's circuit input (plus referenced content revisions) is pinned into this circuit's fixtures.yaml and committed to main.</p>
        {fixturesDirty && <div className="rounded-md bg-warn-soft p-2 text-xs text-warn-fg">fixtures.yaml has uncommitted edits. Commit or discard them first so the promotion isn't overwritten.</div>}
        <Field label="Session ID">
          <TextInput className="font-mono" value={session} onChange={(e) => setSession(e.target.value)} placeholder="ses_…" autoFocus />
        </Field>
        <Field label="Title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short description of the case" />
        </Field>
        <Field label="Tags">
          <TagsInput value={tags} onChange={setTags} placeholder={tagSuggestions.join(', ')} />
        </Field>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {err != null && <div className="text-xs text-danger-fg">{errorMessage(err)}</div>}
      </div>
    </Modal>
  );
}
