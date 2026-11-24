import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePart, listParts, recentParts, rememberRecent, safeName } from '../src/platform/files';
import { setPuterForTests, storageError } from '../src/platform/puter';

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
  vi.unstubAllGlobals();
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

  it('lists cloud parts whose extension is in capitals', async () => {
    setPuterForTests({
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: { readdir: async () => [
        { name: 'Gear.PARAMETRIC', path: '/u/AppData/x/Parts/Gear.PARAMETRIC', modified: 2 },
        { name: 'notes.txt', path: '/u/AppData/x/Parts/notes.txt', modified: 1 },
      ] },
    } as never);
    expect((await listParts()).map((p) => p.name)).toEqual(['Gear']);
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

describe('storageError', () => {
  it('explains network failures and a full browser storage in plain words', () => {
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) expect(storageError(new TypeError(m))).toMatch(/could not be reached/);
    expect(storageError(new DOMException('The operation failed because it would cause the application to exceed its storage quota.', 'QuotaExceededError'))).toMatch(/run out of storage space/);
    expect(storageError({ code: 'storage_limit_reached' })).toMatch(/Puter storage is full/);
    expect(storageError(new Error('Permission denied'))).toBe('Permission denied');
    for (const e of [{ status: 403, message: 'Forbidden' }, { code: 'forbidden' }, { code: 'access_denied', message: 'Access denied' }]) expect(storageError(e)).toMatch(/do not have permission.*Save As/);
  });
});


describe('local deletion', () => {
  const location = { type: 'local' as const, id: 'part-1' };
  const setup = (removeEntry: () => Promise<void>) => {
    localStorage.setItem('parametric:local-parts', JSON.stringify([{ id: location.id, name: 'Bracket', modified: 1, size: 10 }]));
    rememberRecent({ location, name: 'Bracket' });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({ removeEntry }) }) } });
  };

  it('keeps the file listed and reports a deletion failure', async () => {
    const failure = new DOMException('The file is in use', 'NoModificationAllowedError');
    setup(async () => { throw failure; });
    await expect(deletePart(location)).rejects.toBe(failure);
    expect(await listParts()).toHaveLength(1);
    expect(recentParts()).toHaveLength(1);
  });

  it('does not report success when browser storage is unavailable', async () => {
    setup(async () => {});
    vi.stubGlobal('navigator', {});
    await expect(deletePart(location)).rejects.toThrow(/storage.*available/i);
    expect(await listParts()).toHaveLength(1);
    expect(recentParts()).toHaveLength(1);
  });

  it.each([false, true])('removes the index and recent entry after deletion or an already missing file (%s)', async (missing) => {
    setup(async () => { if (missing) throw new DOMException('Gone', 'NotFoundError'); });
    await deletePart(location);
    expect(await listParts()).toEqual([]);
    expect(recentParts()).toEqual([]);
  });
});

describe('damaged browser file lists', () => {
  it('keeps valid local entries when other index rows are malformed', async () => {
    localStorage.setItem('parametric:local-parts', JSON.stringify([
      null, 5, {}, { id: 'bad', name: 5 }, { id: '', name: 'Empty id' },
      { id: 'p1', name: 'Bracket', modified: 10, size: 20 },
      { id: 'p2', name: 'Plate', modified: 'invalid', size: null },
    ]));
    expect(await listParts()).toEqual([
      { name: 'Bracket', location: { type: 'local', id: 'p1' }, modified: 10, size: 20 },
      { name: 'Plate', location: { type: 'local', id: 'p2' }, modified: 0, size: 0 },
    ]);
  });

  it('drops malformed recent locations and still remembers new parts', () => {
    localStorage.setItem('parametric:recent', JSON.stringify([
      null, {}, { name: 'Broken', location: { type: 'cloud' } },
      { name: 'Broken', location: { type: 'local', id: 5 } },
      { name: 'Broken', location: { type: 'other', id: 'x' } },
      { name: 'Kept', location: { type: 'cloud', path: 'Parts/kept.parametric' }, opened: 1 },
      { name: 'Also kept', location: { type: 'local', id: 'p1' }, opened: null },
    ]));
    expect(recentParts()).toEqual([
      { name: 'Kept', location: { type: 'cloud', path: 'Parts/kept.parametric' }, opened: 1 },
      { name: 'Also kept', location: { type: 'local', id: 'p1' }, opened: 0 },
    ]);
    expect(() => rememberRecent({ location: { type: 'local', id: 'new' }, name: 'New' })).not.toThrow();
    expect(recentParts().map((p) => p.name)).toEqual(['New', 'Kept', 'Also kept']);
  });
});

describe('safeName', () => {
  it('shortens long names without splitting a character in two', () => {
    const name = safeName(`${'a'.repeat(119)}\u{1F600}tail`);
    expect(name).toBe(`${'a'.repeat(119)}\u{1F600}`);
    expect(safeName(`${'a'.repeat(119)} b`)).toBe('a'.repeat(119));
    expect(safeName(' a/b:c ')).toBe('a-b-c');
    // Control characters cannot be in a file name; line breaks and tabs become spaces.
    expect(safeName('Gear\u0000\u0007 v2\u007f\nplate\tB')).toBe('Gear v2 plate B');
    expect(safeName('\u0001\u0002')).toBe('Untitled');
  });
});

describe('recovery copies of closing tabs', () => {
  /** A localStorage whose values together may hold `quota` characters. */
  function quotaStorage(quota: number) {
    const m = new Map<string, string>();
    const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        const before = m.get(k);
        m.set(k, v);
        if (used() > quota) {
          if (before === undefined) m.delete(k); else m.set(k, before);
          throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
        }
      },
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
    return m;
  }
  const copy = (savedAt: number, size: number) => JSON.stringify({ savedAt, doc: { name: 'x' }, pad: 'p'.repeat(size) });

  it('keep all copies together within their limit, dropping the oldest of other tabs', async () => {
    const m = quotaStorage(10_000_000);
    const { writeRecoveryOnUnload } = await import('../src/platform/files');
    m.set('parametric:recovery-unload:old', copy(1, 450_000));
    m.set('parametric:recovery-unload:newer', copy(2, 450_000));
    expect(writeRecoveryOnUnload(copy(3, 300_000))).toBe(true);
    expect([...m.keys()].filter((k) => k.startsWith('parametric:recovery-unload:')).length).toBe(2);
    expect(m.has('parametric:recovery-unload:old')).toBe(false);
    // One copy larger than the limit is not written at all.
    expect(writeRecoveryOnUnload(copy(4, 1_100_000))).toBe(false);
  });

  it('give way when the list of parts would not fit beside them', async () => {
    const m = quotaStorage(1_000_000);
    const { rememberRecent, recentParts: recent } = await import('../src/platform/files');
    m.set('parametric:recovery-unload:other', copy(1, 999_900));
    rememberRecent({ location: { type: 'local', id: 'part-1' }, name: 'Kept' });
    expect(recent().map((r) => r.name)).toEqual(['Kept']);
    expect(m.has('parametric:recovery-unload:other')).toBe(false);
  });

  it('are removed with the recovery copy they belong to', async () => {
    const m = quotaStorage(10_000_000);
    const { removeRecovery } = await import('../src/platform/files');
    m.set('parametric:recovery-unload:abc', copy(1, 10));
    await removeRecovery('recovery-abc.json');
    expect(m.has('parametric:recovery-unload:abc')).toBe(false);
  });
});
