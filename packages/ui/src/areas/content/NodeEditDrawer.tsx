/** Inline editor for non-CRDT nodes: title, tags, and properties via `PATCH /nodes/:uid`. */
import { useMemo, useState } from 'react';
import { isNeedInputTag, type NodeDto } from '@breadboard/shared';
import { usePatchNode } from '../../lib/queries';
import { errorMessage } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Callout, Drawer, Input, TagChip, TextArea } from '../../components';

/** Properties managed elsewhere (need-input endpoints, orchestrator-driven task status). */
const RESERVED = new Set(['need-input', 'need-input-history']);

export function editableProperties(node: NodeDto): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    if (RESERVED.has(k)) continue;
    if (node.type === 'task' && k === 'status') continue;
    out[k] = v;
  }
  return out;
}

/** Build the PATCH body: changed title, tag delta, changed property keys (removed keys → null). */
export function buildNodePatch(node: NodeDto, next: { title: string; tags: string[]; properties: Record<string, unknown> }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (next.title !== node.title) body.title = next.title;
  const cur = node.tags.filter((t) => !isNeedInputTag(t));
  const add = next.tags.filter((t) => !cur.includes(t));
  const remove = cur.filter((t) => !next.tags.includes(t));
  if (add.length) body.tags_add = add;
  if (remove.length) body.tags_remove = remove;
  const before = editableProperties(node);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next.properties)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) props[k] = v;
  for (const k of Object.keys(before)) if (!(k in next.properties)) props[k] = null;
  if (Object.keys(props).length) body.properties = props;
  return body;
}

export function NodeEditDrawer({ node, open, onClose }: { node: NodeDto; open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} width="md" title="Edit node" description="Title, tags and properties. Body edits for CRDT nodes happen in the shared editor.">
      {open && <EditForm node={node} onDone={onClose} />}
    </Drawer>
  );
}

function EditForm({ node, onDone }: { node: NodeDto; onDone: () => void }) {
  const initialProps = useMemo(() => editableProperties(node), [node]);
  const [title, setTitle] = useState(node.title);
  const [tags, setTags] = useState(() => node.tags.filter((t) => !isNeedInputTag(t)));
  const [tagDraft, setTagDraft] = useState('');
  const [props, setProps] = useState(() => JSON.stringify(initialProps, null, 2));
  const patch = usePatchNode(node.uid);

  let parsed: Record<string, unknown> | null = null;
  let propsError: string | null = null;
  try {
    const v = JSON.parse(props || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) propsError = 'Properties must be a JSON object.';
    else parsed = v as Record<string, unknown>;
  } catch (e) {
    propsError = errorMessage(e);
  }
  const body = parsed ? buildNodePatch(node, { title: title.trim(), tags, properties: parsed }) : {};
  const dirty = Object.keys(body).length > 0;
  const readOnly = node.tags.includes('read-only');

  const addTag = () => {
    const t = tagDraft.trim();
    if (t && !tags.includes(t) && !isNeedInputTag(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  const save = async () => {
    try {
      await patch.mutateAsync(body as never);
      toast.success('Saved');
      onDone();
    } catch (e) {
      toast.error('Save failed', e);
    }
  };

  return (
    <form
      className="flex flex-col gap-4 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !propsError) void save();
      }}
    >
      {readOnly && <Callout tone="warn">This node is read-only (connector-sourced); the server will reject edits.</Callout>}
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-fg">Tags</span>
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <TagChip key={t} tag={t} onRemove={() => setTags(tags.filter((x) => x !== t))} />
          ))}
          {!tags.length && <span className="text-[12.5px] text-fg-subtle">No tags</span>}
        </div>
        <Input
          aria-label="Add tag"
          size="sm"
          value={tagDraft}
          placeholder="Add a tag and press Enter"
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
        />
        <span className="text-[11.5px] text-fg-subtle">need-input tags are managed through requests and are not editable here.</span>
      </div>
      <TextArea label="Properties (JSON)" mono rows={12} value={props} onChange={(e) => setProps(e.target.value)} error={propsError ?? undefined} hint="Removed keys are deleted. need-input and task status are managed by their own endpoints." />
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={patch.isPending} disabled={!dirty || !!propsError || !title.trim()}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
