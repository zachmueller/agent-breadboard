import { describe, expect, it } from 'vitest';
import { conversationEnded, placeProposals, proposalIdOf, proposeOutcomes, toolNamesById } from './turns';

const use = (id: string, name: string, input: unknown = {}) => ({ content: [{ type: 'tool_use', id, name, input }] });
const result = (id: string, content: unknown, is_error = false) => ({ content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) }] });
const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

const turns = [
  text('make it retry'),
  use('t1', 'read_config'),
  result('t1', '{"uid":"X"}'),
  use('t2', 'propose_config_change', { message: 'retry' }),
  result('t2', 'Error (validation-failed): proposal rejected: tools/X/tool.yaml: entrypoint missing', true),
  use('t3', 'propose_config_change', { message: 'retry' }),
  result('t3', '{"proposal_id":"prp_01J8AAAAAAAAAAAAAAAA","branch":"proposals/prp_01J8AAAAAAAAAAAAAAAA","status":"open"}'),
  text('Proposed.'),
  text('also log it'),
  use('t4', 'propose_config_change', { message: 'log', proposal_id: 'prp_01J8AAAAAAAAAAAAAAAA' }),
  result('t4', '{"proposal_id":"prp_01J8AAAAAAAAAAAAAAAA","status":"open","message":"log"'), // capped mid-JSON
  text('Amended.'),
];

describe('designer transcript proposals', () => {
  it('maps tool_use ids to names', () => {
    expect(toolNamesById(turns).get('t3')).toBe('propose_config_change');
  });

  it('reads the proposal id even from a truncated result', () => {
    expect(proposalIdOf('{"proposal_id":"prp_01J8AAAAAAAAAAAAAAAA","status":"open","mess')).toBe('prp_01J8AAAAAAAAAAAAAAAA');
    expect(proposalIdOf([{ type: 'text', text: '{"proposal_id": "prp_01J8AAAAAAAAAAAAAAAA"}' }])).toBe('prp_01J8AAAAAAAAAAAAAAAA');
    expect(proposalIdOf('nothing here')).toBeNull();
  });

  it('reports failed, opened and amended proposals in order', () => {
    expect(proposeOutcomes(turns)).toEqual([
      { turn: 4, tool_use_id: 't2', proposal_id: null, amended: false, error: 'proposal rejected: tools/X/tool.yaml: entrypoint missing' },
      { turn: 6, tool_use_id: 't3', proposal_id: 'prp_01J8AAAAAAAAAAAAAAAA', amended: false, error: null },
      { turn: 10, tool_use_id: 't4', proposal_id: 'prp_01J8AAAAAAAAAAAAAAAA', amended: true, error: null },
    ]);
  });

  it('places each card after its latest result, unknown ids at the end', () => {
    const at = placeProposals(turns, ['prp_01J8AAAAAAAAAAAAAAAA', 'prp_01J8BBBBBBBBBBBBBBBB']);
    expect(at.get('prp_01J8AAAAAAAAAAAAAAAA')).toBe(11);
    expect(at.get('prp_01J8BBBBBBBBBBBBBBBB')).toBe(turns.length);
  });

  it('words why a conversation ended', () => {
    expect(conversationEnded('running', null)).toBeNull();
    expect(conversationEnded('suspended-error', 'budget-exceeded')).toBe('stopped at its budget');
    expect(conversationEnded('cancelled', 'cancelled')).toBe('been cancelled');
    expect(conversationEnded('completed', null)).toBe('ended (completed)');
  });
});
