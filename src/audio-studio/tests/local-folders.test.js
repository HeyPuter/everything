import { describe, it, expect } from 'vitest';
import { parseLocalPath, rootPath, localDirname, isLocalPath, readLocalDir, localFile, loadRoots, removeRoot } from '../src/storage/local-folders.js';
import { abortingIndexedDB, settleWithin } from './helpers/aborting-idb.js';
import { crumbs, resolveMediaItems } from '../src/panels/media-browser.js';

// A minimal stand-in for FileSystemDirectoryHandle / FileSystemFileHandle.
function dirHandle(name, entries) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [k, v] of Object.entries(entries)) yield [k, typeof v === 'string' ? fileHandle(k, v) : dirHandle(k, v)];
    },
    async getDirectoryHandle(n) {
      if (typeof entries[n] !== 'object') throw new Error('NotFound');
      return dirHandle(n, entries[n]);
    },
    async getFileHandle(n) {
      if (typeof entries[n] !== 'string') throw new Error('NotFound');
      return fileHandle(n, entries[n]);
    },
  };
}
function fileHandle(name, text) {
  return { kind: 'file', name, getFile: async () => new File([text], name, { lastModified: 1000 }) };
}

const roots = [{ id: 'r1', name: 'Music', handle: dirHandle('Music', { 'a.wav': 'RIFF', Takes: { 'b.flac': 'fLaC!' }, '.hidden': 'x' }) }];

describe('device folders', () => {
  it('settles when an IndexedDB transaction aborts instead of hanging', async () => {
    const saved = [globalThis.indexedDB, window.showDirectoryPicker];
    globalThis.indexedDB = abortingIndexedDB();
    window.showDirectoryPicker = async () => roots[0].handle;
    try {
      expect(await settleWithin(loadRoots())).toEqual({ value: [] });
      const removed = await settleWithin(removeRoot('r1'));
      expect(removed.error?.name).toBe('QuotaExceededError');
    } finally {
      [globalThis.indexedDB, window.showDirectoryPicker] = saved;
      if (!saved[1]) delete window.showDirectoryPicker;
    }
  });

  it('parses and builds paths', () => {
    expect(isLocalPath('local:r1/Takes')).toBe(true);
    expect(isLocalPath('/home/a')).toBe(false);
    expect(parseLocalPath('local:r1/Takes/b.flac')).toEqual({ rootId: 'r1', parts: ['Takes', 'b.flac'] });
    expect(rootPath('r1')).toBe('local:r1');
    expect(localDirname('local:r1/Takes/b.flac')).toBe('local:r1/Takes');
    expect(localDirname('local:r1')).toBe('local:r1');
  });

  it('lists folders with sizes, skipping hidden entries', async () => {
    const list = await readLocalDir(roots, 'local:r1');
    expect(list.map((x) => [x.name, x.is_dir, x.size])).toEqual([
      ['a.wav', false, 4],
      ['Takes', true, 0],
    ]);
    expect(list[0]).toMatchObject({ path: 'local:r1/a.wav', local: true, modified: 1000 });
    const sub = await readLocalDir(roots, 'local:r1/Takes');
    expect(sub[0].path).toBe('local:r1/Takes/b.flac');
  });

  it('reads files and labels breadcrumbs with the folder name', async () => {
    const f = await localFile(roots, 'local:r1/Takes/b.flac');
    expect(f.name).toBe('b.flac');
    expect(await f.text()).toBe('fLaC!');
    expect(crumbs('local:r1/Takes', 'Music')).toEqual([
      { name: 'Music', path: 'local:r1' },
      { name: 'Takes', path: 'local:r1/Takes' },
    ]);
    await expect(readLocalDir(roots, 'local:zz')).rejects.toThrow();
  });

  it('passes Puter drag items through unchanged', async () => {
    const puterItem = { name: 'x.wav', path: '/u/x.wav' };
    expect(await resolveMediaItems([puterItem])).toEqual([puterItem]);
  });
});
