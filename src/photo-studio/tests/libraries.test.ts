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
import { compactOps, LibraryRepository, MemoryLocalStore, PuterLibraryCloud } from '../src/features/libraries/storage';
import type { QueuedOp, LibraryOp, LibraryIndex } from '../src/features/libraries/model';
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

  it('never duplicates an item when a put is replayed after it moved', () => {
    let idx = applyOps(emptyIndex(), [{ op: 'create-library', library: lib('A', 'A') }, { op: 'create-library', library: lib('B', 'B') }]);
    const put: LibraryOp = { op: 'put-item', library: 'A', item: color('x', 'Red', '#ff0000', 1) };
    const move: LibraryOp = { op: 'move-item', from: 'A', to: 'B', id: 'x', at: at(2) };
    idx = applyOps(idx, [put, move]);
    // Replaying both (a sync replays recent edits) changes nothing.
    const again = applyOps(idx, [put, move]);
    expect(again.libraries.map((l) => [l.id, l.items.map((i) => i.id)])).toEqual([['A', []], ['B', ['x']]]);
    // A newer put (redefine) updates the item where it is now.
    const redefined = applyOps(again, [{ op: 'put-item', library: 'A', item: color('x', 'Dark Red', '#880000', 3) }]);
    expect(redefined.libraries.map((l) => [l.id, l.items.map((i) => i.name)])).toEqual([['A', []], ['B', ['Dark Red']]]);
    // Deleting finds it wherever it is.
    expect(findItem(applyOps(redefined, [{ op: 'delete-item', library: 'A', id: 'x', at: at(4) }]), 'x')).toBeUndefined();
  });

  it('never lets an older move undo a newer one', () => {
    let idx = applyOps(emptyIndex(), [
      { op: 'create-library', library: lib('A', 'A', [color('x', 'Red', '#ff0000'), color('y', 'Blue', '#0000ff')]) },
      { op: 'create-library', library: lib('B', 'B') },
      { op: 'create-library', library: lib('C', 'C') },
    ]);
    idx = applyOps(idx, [{ op: 'move-item', from: 'A', to: 'C', id: 'x', at: at(5) }]);
    idx = applyOps(idx, [{ op: 'move-item', from: 'A', to: 'B', id: 'x', at: at(2) }]);
    expect(findItem(idx, 'x')!.library.id).toBe('C');
    // Reorders too: replaying one already applied keeps later changes.
    idx = applyOps(idx, [{ op: 'move-item', from: 'A', to: 'C', id: 'y', at: at(6) }]);
    const reorder: LibraryOp = { op: 'move-item', from: 'C', to: 'C', id: 'y', before: 'x', at: at(7) };
    idx = applyOps(idx, [reorder, { op: 'move-item', from: 'C', to: 'C', id: 'x', before: 'y', at: at(8) }]);
    expect(idx.libraries[2].items.map((i) => i.id)).toEqual(['x', 'y']);
    expect(applyOps(idx, [reorder]).libraries[2].items.map((i) => i.id)).toEqual(['x', 'y']);
    // Libraries as well.
    idx = applyOps(idx, [{ op: 'move-library', id: 'C', before: 'A', at: at(9) }]);
    expect(applyOps(idx, [{ op: 'move-library', id: 'C', at: at(3) }]).libraries.map((l) => l.id)).toEqual(['C', 'A', 'B']);
  });

  it('heals an index that stores an item twice', () => {
    const idx = validIndex({ version: 1, revision: 1, libraries: [lib('A', 'A', [color('x', 'Red', '#ff0000')]), lib('B', 'B', [color('x', 'Red', '#ff0000'), color('x', 'Red', '#ff0000')])], deleted: {} });
    expect(idx!.libraries.map((l) => l.items.length)).toEqual([1, 0]);
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
    // The edit stays queued until a cloud write takes it.
    expect((await repo.local.read()).pending.length).toBe(1);
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

  it('keeps edits made while signed out to libraries the cloud copy has', async () => {
    const fs = new FakeFs();
    let signedIn = true;
    const a = device(fs, () => signedIn);
    await a.apply([{ op: 'create-library', library: lib('L', 'Brand') }]);
    await a.sync();
    signedIn = false;
    await a.apply([{ op: 'put-item', library: 'L', item: color('y', 'Blue', '#0000ff', 5) }, { op: 'rename-library', id: 'L', name: 'Brand Kit', at: new Date().toISOString() }]);
    await a.sync();
    expect((await a.index()).libraries[0].items.map((i) => i.id)).toEqual(['y']);
    signedIn = true;
    const after = await a.sync();
    expect(a.status.state).toBe('synced');
    expect(after.libraries.map((l) => [l.name, l.items.map((i) => i.id)])).toEqual([['Brand Kit', ['y']]]);
    const stored = JSON.parse(await fs.files.get('libraries/index.json')!.text());
    expect(stored.libraries.map((l: Library) => [l.name, l.items.map((i) => i.id)])).toEqual([['Brand Kit', ['y']]]);
    expect((await a.local.read()).pending).toEqual([]);
  });

  it('puts back items whose queued edit was lost (older versions cleared the queue)', async () => {
    const fs = new FakeFs();
    const a = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Brand', [color('x', 'Red', '#ff0000')]) }]);
    await a.sync();
    // The working copy has an item and a newer copy of another, with no queued edit.
    await a.local.update((s) => {
      s.index.libraries[0].items.push(color('y', 'Blue', '#0000ff', 5));
      s.index.libraries[0].items[0] = color('x', 'Crimson', '#dd0000', 6);
    });
    // Elsewhere an item was deleted: it is not brought back.
    const b = device(fs);
    await b.sync();
    await b.apply([{ op: 'put-item', library: 'L', item: color('z', 'Gone', '#00ff00', 7) }]);
    await b.sync();
    await b.apply([{ op: 'delete-item', library: 'L', id: 'z', at: at(8) }]);
    await b.sync();
    await a.local.update((s) => void s.index.libraries[0].items.push(color('z', 'Gone', '#00ff00', 7)));
    const after = await a.sync();
    expect(after.libraries[0].items.map((i) => i.name)).toEqual(['Crimson', 'Blue']);
  });

  it('never drops queued edits: a long queue is compacted', async () => {
    const fs = new FakeFs();
    const a = device(fs);
    await a.apply([{ op: 'create-library', library: lib('L', 'Many') }]);
    await a.sync();
    // Puter stops answering: edits queue up.
    const read = fs.read.bind(fs);
    fs.read = () => new Promise(() => {});
    for (let n = 0; n < 400; n++) await a.apply([{ op: 'put-item', library: 'L', item: color(`c${n}`, `C${n}`, '#123456', n) }]);
    // Renaming one item many times collapses into its first put.
    for (let n = 0; n < 200; n++) await a.apply([{ op: 'put-item', library: 'L', item: color('c0', `Renamed ${n}`, '#123456', 1000 + n) }]);
    expect((await a.local.read()).pending.length).toBeLessThanOrEqual(400);
    await a.sync();
    expect(a.status.state).toBe('offline');
    fs.read = read;
    const after = await a.sync();
    expect(a.status.state).toBe('synced');
    expect(after.libraries[0].items.length).toBe(400);
    expect(after.libraries[0].items[0].name).toBe('Renamed 199');
    const stored = JSON.parse(await fs.files.get('libraries/index.json')!.text());
    expect(stored.libraries[0].items.length).toBe(400);
  });

  it('compacts a queue to one with the same result', () => {
    const q = (o: LibraryOp, n: number) => ({ ...o, opId: `o${n}` }) as QueuedOp;
    const ops: QueuedOp[] = [
      q({ op: 'create-library', library: lib('A', 'A') }, 0),
      q({ op: 'create-library', library: lib('B', 'B') }, 1),
      q({ op: 'put-item', library: 'A', item: color('x', 'X1', '#000001', 1) }, 2),
      q({ op: 'put-item', library: 'A', item: color('y', 'Y1', '#000002', 2) }, 3),
      q({ op: 'rename-library', id: 'A', name: 'A1', at: at(3) }, 4),
      q({ op: 'move-item', from: 'A', to: 'B', id: 'x', at: at(4) }, 5),
      q({ op: 'put-item', library: 'B', item: color('x', 'X2', '#000003', 5) }, 6),
      q({ op: 'rename-library', id: 'A', name: 'A2', at: at(6) }, 7),
      q({ op: 'put-item', library: 'A', item: color('z', 'Z', '#000004', 7), before: 'y' }, 8),
      q({ op: 'move-item', from: 'A', to: 'A', id: 'y', before: 'z', at: at(8) }, 9),
      q({ op: 'delete-item', library: 'A', id: 'y', at: at(9) }, 10),
      q({ op: 'put-item', library: 'A', item: color('z', 'Z2', '#000005', 10) }, 11),
    ];
    const short = compactOps(ops);
    expect(short.length).toBeLessThan(ops.length);
    const bases: LibraryIndex[] = [emptyIndex(), applyOps(emptyIndex(), ops.slice(0, 6)), applyOps(emptyIndex(), [ops[0], ops[1], q({ op: 'put-item', library: 'A', item: color('x', 'Newer', '#000009', 50) }, 99)])];
    for (const base of bases) expect(applyOps(base, short)).toEqual(applyOps(base, ops));
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

  it('does not duplicate items or revert moves when replaying recent edits', async () => {
    const fs = new FakeFs();
    const a = device(fs);
    await a.apply([{ op: 'create-library', library: lib('A', 'A') }, { op: 'create-library', library: lib('B', 'B') }]);
    await a.sync();
    await a.apply([{ op: 'put-item', library: 'A', item: color('x', 'Red', '#ff0000', 1) }]);
    await a.sync();
    await a.apply([{ op: 'move-item', from: 'A', to: 'B', id: 'x', at: at(2) }]);
    await a.sync();
    await a.apply([{ op: 'rename-library', id: 'A', name: 'A2', at: new Date().toISOString() }]);
    await a.sync();
    const stored = JSON.parse(await fs.files.get('libraries/index.json')!.text()) as LibraryIndex;
    expect(stored.libraries.map((l) => [l.name, l.items.map((i) => i.id)])).toEqual([['A2', []], ['B', ['x']]]);
    // Another device moves it on; this one's recent (older) move is not replayed over it.
    const b = device(fs);
    await b.sync();
    await b.apply([{ op: 'create-library', library: lib('C', 'C') }, { op: 'move-item', from: 'B', to: 'C', id: 'x', at: new Date(Date.now() + 1000).toISOString() }]);
    await b.sync();
    const final = await a.sync();
    expect(final.libraries.map((l) => [l.id, l.items.map((i) => i.id)])).toEqual([['A', []], ['B', []], ['C', ['x']]]);
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
