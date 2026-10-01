import { describe, expect, it } from 'vitest';
import type { NodeDto } from '@breadboard/shared';
import { buildNodePatch, editableProperties } from './NodeEditDrawer';

const node = (over: Partial<NodeDto> = {}): NodeDto => ({
  uid: '01J8FQ2ZK7XW9MBT4PVN',
  team_id: 't',
  type: 'artifact',
  title: 'Draft',
  properties: { summary: 'x', 'need-input': [], 'need-input-history': [], status: 'keep' },
  body: null,
  body_text: null,
  crdt: false,
  tags: ['deliverable', 'need-input', 'need-input:role=legal'],
  scope: 'team',
  created_at: '',
  created_by: { kind: 'user', id: 'u' } as NodeDto['created_by'],
  updated_at: '',
  deleted_at: null,
  head_revision: 1,
  ...over,
});

describe('editableProperties', () => {
  it('hides reserved need-input properties', () => {
    expect(editableProperties(node())).toEqual({ summary: 'x', status: 'keep' });
  });
  it('hides task status', () => {
    expect(editableProperties(node({ type: 'task' }))).toEqual({ summary: 'x' });
  });
});

describe('buildNodePatch', () => {
  it('is empty when nothing changed (need-input tags are not user tags)', () => {
    expect(buildNodePatch(node(), { title: 'Draft', tags: ['deliverable'], properties: { summary: 'x', status: 'keep' } })).toEqual({});
  });

  it('emits title, tag delta and changed/removed properties', () => {
    expect(buildNodePatch(node(), { title: 'Final', tags: ['reviewed'], properties: { summary: 'y', extra: 1 } })).toEqual({
      title: 'Final',
      tags_add: ['reviewed'],
      tags_remove: ['deliverable'],
      properties: { summary: 'y', extra: 1, status: null },
    });
  });
});
