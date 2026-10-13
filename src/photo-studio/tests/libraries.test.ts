import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyIndex,
  exportLibraryFile,
  findItem,
  groupByType,
  importLibraryFile,
  searchItems,
  uniqueName,
  validIndex,
  type Library,
  type LibraryItem,
} from '../src/features/libraries/model';
import { LibraryRepository, MemoryLocalStore, PuterLibraryCloud } from '../src/features/libraries/storage';
import { sha256Hex } from '../src/model/provenance';

const T0 = '2026-01-01T00:00:00.000Z';
const at = (n: number) => new Date(Date.parse(T0) + n * 1000).toISOString();
const lib = (id: string, name: string, items: LibraryItem[] = []): Library => ({ id, name, created: T0, modified: T0, items });
const color = (id: string, name: string, hex: string, t = 0): LibraryItem => ({ id, type: 'color', name, created: at(t), modified: at(t), data: { hex } });

/** A Puter file system stand-in: paths map to blobs; hooks let a test act between calls. */
class FakeFs {
  files = new Map<string, Blob>();
  writes: string[] = [];
  beforeWrite?: (path: string) => Promise<void> | void;
  async read(path: string): Promise<Blob> {
    const b = this.files.get(path);
    if (!b) throw Object.assign(new Error(`${path} does not exist`), { code: 'subject_does_not_exist' });
    return b;
  }
  async write(path: string, data: Blob | string) {
    await this.beforeWrite?.(path);
    this.writes.push(path);
    this.files.set(path, typeof data === 'string' ? new Blob([data]) : data);
    return { path };
  }
}
const device = (fs: FakeFs | undefined, signedIn = () => true) => {
  const cloud = fs ? new PuterLibraryCloud(fs, 'libraries', 200) : undefined;
  return new LibraryRepository(new MemoryLocalStore(), () => (signedIn() ? cloud : undefined));
};

describe('library model', () => {
  it('applies operations idempotently and keeps the order of items', () => {
    let idx = applyOps(emptyIndex(), [{ op: 'create-library', library: lib('L', 'Brand') }]);
    idx = applyOps(idx, [
      { op: 'put-item', library: 'L', item: color('a', 'Red', '#ff0000') },
      { op: 'put-item', library: 'L', item: color('b', 'Blue', '#0000ff') },
      { op: 'put-item', library: 'L', item: color('c', 'Green', '#00ff00'), before: 'b' },
    ]);
    expect(idx.libraries[0].items.map((i) => i.id)).toEqual(['a', 'c', 'b']);
    // Replaying the same operations changes nothing.
    const again = applyOps(idx, [{ op: 'create-library', library: lib('L', 'Other') }, { op: 'put-item', library: 'L', item: color('a', 'Red', '#ff0000') }]);
    expect(again.libraries).toEqual(idx.libraries);
    idx = applyOps(idx, [{ op: 'move-item', from: 'L', to: 'L', id: 'b', before: 'a', at: at(5) }]);
    expect(idx.libraries[0].items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('never lets an older copy replace a newer item or bring back a deleted one', () => {
    let idx = applyOps(emptyIndex(), [{ op: 'create-library', library: lib('L', 'Brand') }, { op: 'put-item', library: 'L', item: color('a', 'Red', '#ff0000', 10) }]);
    idx = applyOps(idx, [{ op: 'put-item', library: 'L', item: color('a', 'Old', '#110000', 5) }]);
    expect(findItem(idx, 'a')!.item.name).toBe('Red');
    idx = applyOps(idx, [{ op: 'delete-item', library: 'L', id: 'a', at: at(20) }, { op: 'put-item', library: 'L', item: color('a', 'Red', '#ff0000', 30) }]);
    expect(findItem(idx, 'a')).toBeUndefined();
    idx = applyOps(idx, [{ op: 'delete-library', id: 'L', at: at(40) }, { op: 'create-library', library: lib('L', 'Again') }]);
    expect(idx.libraries).toEqual([]);
  });

  it('renames by the later edit', () => {
    let idx = applyOps(emptyIndex(), [{ op: 'create-library', library: lib('L', 'Brand') }]);
    idx = applyOps(idx, [{ op: 'rename-library', id: 'L', name: 'B', at: at(10) }, { op: 'rename-library', id: 'L', name: 'A', at: at(5) }]);
    expect(idx.libraries[0].name).toBe('B');
  });

  it('searches, groups and names', () => {
    const items = [color('a', 'Ocean Blue', '#0044aa'), { ...color('b', 'Sunset', '#ff8800'), type: 'gradient' as const, data: {} }, color('c', 'Sand', '#ddcc99')];
    expect(searchItems(items, 'blue').map((i) => i.id)).toEqual(['a']);
    expect(searchItems(items, '#ddcc').map((i) => i.id)).toEqual(['c']);
    expect(searchItems(items, 'gradient').map((i) => i.id)).toEqual(['b']);
    expect(searchItems(items, '  ').length).toBe(3);
    expect(groupByType(items).map(([t, l]) => [t, l.length])).toEqual([['color', 2], ['gradient', 1]]);
    expect(uniqueName('Blue', ['blue', 'Blue 2'])).toBe('Blue 3');
    expect(uniqueName('Red', ['Blue'])).toBe('Red');
  });

  it('validates stored indexes', () => {
    expect(validIndex({ version: 2 })).toBeUndefined();
    expect(validIndex({ version: 1, revision: 1, libraries: [{ id: 'x' }] })).toBeUndefined();
    const ok = validIndex({ version: 1, revision: 3, libraries: [lib('L', 'A', [color('a', 'Red', '#ff0000')])], deleted: { z: T0, bad: 5 } });
    expect(ok?.deleted).toEqual({ z: T0 });
    expect(validIndex({ version: 1, revision: 0, libraries: [lib('L', 'A', [color('a', 'Red', 'red')])] })).toBeUndefined();
  });

  it('exports a library as one file and imports it as a copy with checked assets', async () => {
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    const h = await sha256Hex(png);
    const pattern: LibraryItem = { id: 'p', type: 'pattern', name: 'Dots', created: T0, modified: T0, data: { width: 2, height: 2 }, assets: { content: h } };
    const source = lib('L', 'Kit', [color('a', 'Red', '#ff0000'), pattern]);
    const text = await exportLibraryFile(source, async (hash) => (hash === h ? new Blob([png], { type: 'image/png' }) : undefined), new Date(T0));
    const back = await importLibraryFile(text, sha256Hex, new Date(at(60)));
    expect(back.library.name).toBe('Kit');
    expect(back.library.id).not.toBe('L');
    expect(back.library.items.map((i) => [i.type, i.name])).toEqual([['color', 'Red'], ['pattern', 'Dots']]);
    expect(new Uint8Array(await back.assets.get(h)!.arrayBuffer())).toEqual(png);
    expect(back.skipped).toBe(0);
    // A damaged asset leaves its item out.
    const broken = JSON.parse(text);
    broken.assets[h].data = btoa('xyz');
    const partial = await importLibraryFile(JSON.stringify(broken), sha256Hex);
    expect(partial.library.items.map((i) => i.name)).toEqual(['Red']);
    expect(partial.skipped).toBe(1);
    await expect(importLibraryFile('{"format":"other"}', sha256Hex)).rejects.toThrow(/not a library file/);
    await expect(importLibraryFile('nope', sha256Hex)).rejects.toThrow(/not a library file/);
  });
});

describe('library storage and sync', () => {
  it('keeps libraries in the browser when signed out', async () => {
    const repo = device(undefined);
    await repo.apply([{ op: 'create-library', library: lib('L', 'Mine') }]);
    const idx = await repo.sync();
    expect(idx.libraries.map((l) => l.name)).toEqual(['Mine']);
    expect(repo.status.state).toBe('local');
    expect((await repo.local.read()).pending).toEqual([]);
  });

  it('shares libraries between devices through the cloud copy, with assets', async () => {
    const fs = new FakeFs();
    const a = device(fs),
      b = device(fs);
    const bytes = new Uint8Array([9, 8, 7]);
    const h = await sha256Hex(bytes);
    await a.putAsset(h, new Blob([bytes], { type: 'image/png' }));
    await a.apply([{ op: 'create-library', library: lib('L', 'Team') }, { op: 'put-item', library: 'L', item: { ...color('g', 'Logo', '#000000'), type: 'graphic', data: { width: 1, height: 1 }, assets: { content: h } } }]);
    await a.sync();
    expect(a.status.state).toBe('synced');
    expect(fs.files.has(`libraries/assets/${h}`)).toBe(true);
    const seen = await b.sync();
    expect(seen.libraries[0].items[0].name).toBe('Logo');
    expect(new Uint8Array(await (await b.readAsset(h))!.arrayBuffer())).toEqual(bytes);
    // Asset uploads happen once.
    const before = fs.writes.filter((p) => p.includes('/assets/')).length;
    await a.apply([{ op: 'rename-library', id: 'L', name: 'Team Kit', at: new Date().toISOString() }]);
    await a.sync();
    expect(fs.writes.filter((p) => p.includes('/assets/')).length).toBe(before);
  });

  it('merges concurrent edits from two devices instead of overwriting', async () => {
    const fs = new FakeFs();
    const a = device(fs),
      b = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Team') }, { op: 'put-item', library: 'L', item: color('x', 'Base', '#808080') }]);
    await a.sync();
    await b.sync();
    // Both edit while out of touch.
    await a.apply([{ op: 'put-item', library: 'L', item: color('ya', 'From A', '#ff0000') }, { op: 'rename-library', id: 'L', name: 'Renamed by A', at: new Date(Date.now() + 1000).toISOString() }]);
    await b.apply([{ op: 'put-item', library: 'L', item: color('yb', 'From B', '#0000ff') }, { op: 'delete-item', library: 'L', id: 'x', at: new Date().toISOString() }]);
    await a.sync();
    await b.sync();
    const final = await a.sync();
    const names = final.libraries[0].items.map((i) => i.name).sort();
    expect(names).toEqual(['From A', 'From B']);
    expect(final.libraries[0].name).toBe('Renamed by A');
    expect((await b.index()).libraries[0].items.map((i) => i.name).sort()).toEqual(['From A', 'From B']);
  });

  it('replays its edits when another writer gets in between its read and write', async () => {
    const fs = new FakeFs();
    const a = device(fs),
      b = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Team') }]);
    await a.sync();
    await b.sync();
    await a.apply([{ op: 'put-item', library: 'L', item: color('ya', 'From A', '#ff0000') }]);
    await b.apply([{ op: 'put-item', library: 'L', item: color('yb', 'From B', '#0000ff') }]);
    // While A writes its index, B finishes a whole sync first.
    let raced = false;
    fs.beforeWrite = async (path) => {
      if (raced || !path.endsWith('index.json')) return;
      raced = true;
      fs.beforeWrite = undefined;
      await b.sync();
      fs.beforeWrite = async (p) => {
        // B's write lands after A's: A's read-back sees B's writer and retries.
        if (p.endsWith('index.json')) fs.beforeWrite = undefined;
      };
    };
    await a.sync();
    expect(a.status.state).toBe('synced');
    // A overwrote B's write without seeing it; B's next sync replays its
    // recent edits, so nothing is lost for good.
    await b.sync();
    const stored = JSON.parse(await fs.files.get('libraries/index.json')!.text());
    expect(stored.libraries[0].items.map((i: LibraryItem) => i.name).sort()).toEqual(['From A', 'From B']);
    expect((await (await a.sync()).libraries[0].items).map((i) => i.name).sort()).toEqual(['From A', 'From B']);
  });

  it('uploads libraries made while signed out on the first sync after signing in', async () => {
    const fs = new FakeFs();
    let signedIn = false;
    const a = device(fs, () => signedIn);
    await a.apply([{ op: 'create-library', library: lib('L', 'Offline Work') }]);
    await a.sync();
    expect(fs.files.size).toBe(0);
    signedIn = true;
    await a.sync();
    const stored = JSON.parse(await fs.files.get('libraries/index.json')!.text());
    expect(stored.libraries.map((l: Library) => l.name)).toEqual(['Offline Work']);
  });

  it('keeps working in the browser when Puter does not answer', async () => {
    const fs = new FakeFs();
    fs.read = () => new Promise(() => {});
    const a = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Kept') }]);
    const idx = await a.sync();
    expect(idx.libraries.map((l) => l.name)).toEqual(['Kept']);
    expect(a.status.state).toBe('offline');
    // The edit stays queued for the next sync.
    expect((await a.local.read()).pending.length).toBe(1);
  });

  it('reports a damaged cloud index without losing local work', async () => {
    const fs = new FakeFs();
    fs.files.set('libraries/index.json', new Blob(['{not json']));
    const a = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Kept') }]);
    await a.sync();
    expect(a.status.state).toBe('error');
    expect(a.status.message).toMatch(/damaged/);
    expect((await a.index()).libraries.length).toBe(1);
  });
});
