import { describe, expect, it } from 'vitest';
import { SESSION_STATES } from '@breadboard/shared';
import { isSuspended, sessionStateMeta, stepStatusMeta, taskStatusMeta } from './states';

describe('sessionStateMeta', () => {
  it('covers every session state', () => {
    for (const s of SESSION_STATES) expect(sessionStateMeta(s).icon).not.toBe('circle');
  });

  it('flags gated and errored sessions as prominent', () => {
    expect(sessionStateMeta('suspended-gate')).toMatchObject({ tone: 'warn', icon: 'gate', prominent: true, label: 'Awaiting review' });
    expect(sessionStateMeta('suspended-error')).toMatchObject({ tone: 'danger', prominent: true });
    expect(sessionStateMeta('completed')).toMatchObject({ tone: 'ok', prominent: false });
    expect(sessionStateMeta('running').live).toBe(true);
  });

  it('labels budget suspensions distinctly', () => {
    expect(sessionStateMeta('suspended-error', { reason: 'budget-exceeded' }).label).toBe('Suspended · budget');
    expect(sessionStateMeta('suspended-error', { reason: 'step-failed' }).label).toBe('Suspended · error');
  });

  it('falls back for unknown states', () => {
    expect(sessionStateMeta('weird')).toMatchObject({ label: 'weird', tone: 'neutral', icon: 'circle' });
    expect(sessionStateMeta(null).label).toBe('Unknown');
  });
});

describe('isSuspended', () => {
  it('is true only for the two suspended states', () => {
    expect(isSuspended('suspended-gate')).toBe(true);
    expect(isSuspended('suspended-error')).toBe(true);
    expect(isSuspended('running')).toBe(false);
    expect(isSuspended(undefined)).toBe(false);
  });
});

describe('stepStatusMeta / taskStatusMeta', () => {
  it('maps step statuses', () => {
    expect(stepStatusMeta('exited').tone).toBe('ok');
    expect(stepStatusMeta('failed').tone).toBe('danger');
    expect(stepStatusMeta('gated').prominent).toBe(true);
    expect(stepStatusMeta('mystery')).toMatchObject({ label: 'mystery', tone: 'neutral' });
  });

  it('maps task statuses', () => {
    expect(taskStatusMeta('gated')).toMatchObject({ tone: 'warn', prominent: true });
    expect(taskStatusMeta('done').tone).toBe('ok');
    expect(taskStatusMeta(undefined).label).toBe('Unknown');
  });
});
