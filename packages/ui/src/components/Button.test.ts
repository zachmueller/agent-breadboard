import { describe, expect, it } from 'vitest';
import { buttonClasses } from './Button';

const classes = (s: string) => s.split(/\s+/);

describe('buttonClasses', () => {
  it('pads text buttons per size', () => {
    expect(classes(buttonClasses('ghost', 'sm'))).toContain('px-2.5');
    expect(classes(buttonClasses('ghost', 'xs'))).toContain('px-2');
  });

  it('makes icon-only buttons square with no competing padding', () => {
    for (const [size, w] of [['xs', 'w-6'], ['sm', 'w-7'], ['md', 'w-8']] as const) {
      const c = classes(buttonClasses('ghost', size, undefined, true));
      expect(c).toContain(w);
      expect(c).toContain('px-0');
      // `cn` doesn't dedupe utilities, so any size padding left in would win over px-0 in the stylesheet.
      expect(c.filter((x) => /^px-/.test(x))).toEqual(['px-0']);
    }
  });
});
