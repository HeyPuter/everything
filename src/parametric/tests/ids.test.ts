import { expect, it, vi } from 'vitest';
import { uniqueId } from '../src/model/ids';

it('retries a generated collision and reserves the new identifier', () => {
  const used = new Set(['v1-2-3-4']);
  const random = vi.spyOn(crypto, 'getRandomValues')
    .mockImplementationOnce((array) => { if (array instanceof Uint32Array) array.set([1, 2, 3, 4]); return array; })
    .mockImplementationOnce((array) => { if (array instanceof Uint32Array) array.set([5, 6, 7, 8]); return array; });
  try {
    expect(uniqueId('v', used)).toBe('v5-6-7-8');
    expect(used).toEqual(new Set(['v1-2-3-4', 'v5-6-7-8']));
    expect(random).toHaveBeenCalledTimes(2);
  } finally {
    random.mockRestore();
  }
});
