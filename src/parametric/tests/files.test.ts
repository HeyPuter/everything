import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listParts } from '../src/platform/files';
import { setPuterForTests } from '../src/platform/puter';

// Browser storage stand-in: the local part index lives in localStorage.
function fakeLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  };
}

beforeEach(fakeLocalStorage);
afterEach(() => {
  setPuterForTests(null);
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('listParts', () => {
  it('still lists the parts in this browser when the cloud cannot be listed', async () => {
    localStorage.setItem('parametric:local-parts', JSON.stringify([{ id: 'part-1', name: 'Offline bracket', modified: 1, size: 10 }]));
    setPuterForTests({
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: { readdir: async () => { throw new TypeError('Failed to fetch'); } },
    } as never);
    const errors: unknown[] = [];
    const parts = await listParts((e) => errors.push(e));
    expect(parts.map((p) => p.name)).toEqual(['Offline bracket']);
    expect(errors).toHaveLength(1);
  });

  it('treats a missing cloud folder as no cloud parts, not as an error', async () => {
    setPuterForTests({
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: { readdir: async () => { throw { code: 'subject_does_not_exist' }; } },
    } as never);
    const errors: unknown[] = [];
    expect(await listParts((e) => errors.push(e))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
