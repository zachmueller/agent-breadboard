import { describe, it, expect } from 'vitest';
import { formatLogs } from './StepDrawer';

describe('formatLogs', () => {
  it('renders journaled ctx.log entries one per line and passes legacy text through', () => {
    expect(formatLogs([{ at: '2026-10-01T18:54:40.893Z', level: 'info', message: 'checked 0 citation(s): 0 missing', data: { strict: false } }, { level: 'warn', message: 'no data' }])).toBe(
      '18:54:40.893  INFO  checked 0 citation(s): 0 missing  {"strict":false}\nWARN  no data',
    );
    expect(formatLogs('plain text')).toBe('plain text');
    expect(formatLogs([])).toBeNull();
    expect(formatLogs(null)).toBeNull();
  });
});
