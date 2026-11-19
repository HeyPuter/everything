import { describe, it, expect } from 'vitest';
import { beginBusy, whileBusy, isBusy } from '../src/ui/busy.js';

describe('busy state', () => {
  it('marks the app busy while any long operation runs', async () => {
    const a = beginBusy();
    const b = beginBusy();
    expect(document.documentElement.hasAttribute('data-busy')).toBe(true);
    a();
    a();
    expect(isBusy()).toBe(true);
    b();
    expect(isBusy()).toBe(false);
    expect(document.documentElement.hasAttribute('data-busy')).toBe(false);
    await expect(whileBusy(async () => { expect(isBusy()).toBe(true); throw new Error('x'); })).rejects.toThrow('x');
    expect(isBusy()).toBe(false);
  });
});
