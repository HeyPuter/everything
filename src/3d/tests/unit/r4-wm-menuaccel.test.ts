import { describe, it, expect } from 'vitest';
import { menuAccelerators } from '../../src/ui/menuaccel';

describe('menu accelerators', () => {
  it('prefers word initials, keeps letters unique, skips entries without labels', () => {
    const labels = ['Transform', 'Set Origin', 'Mirror', 'Clear', 'Apply', null, 'Snap', 'Shade Smooth', 'Shade Flat', 'Copy Objects'];
    const a = menuAccelerators(labels);
    const letters = a.map((i, k) => (i === undefined || !labels[k] ? null : labels[k]![i]));
    expect(letters.slice(0, 5)).toEqual(['T', 'S', 'M', 'C', 'A']);
    expect(letters[5]).toBeNull();
    // Snap: S and its later letters taken by initials → next free letter
    expect(letters[6]).toBe('n');
    expect(letters[7]).toBe('h');
    expect(new Set(letters.filter(Boolean).map((c) => c!.toLowerCase())).size).toBe(letters.filter(Boolean).length);
  });
  it('gives none when every letter is taken', () => {
    expect(menuAccelerators(['A', 'A'])).toEqual([0, undefined]);
  });
});
