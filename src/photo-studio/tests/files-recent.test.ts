// Files opened from this device are kept in browser storage for Open Recent;
// an entry that leaves the list must take its stored copy and thumbnail along.
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setLocalStore } from '../src/persistence/local-store';
import { clearRecent, noteRecent, recentEntries, syncRecentCommands } from '../src/features/files/recent';
import type { Editor } from '../src/editor';
import { commands } from '../src/app/registry';

let store: MemoryStore;
const editor = (recentCount = 10) => ({ preferences: { recentCount } }) as unknown as Editor;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const stored = async () => ((await store.keys('blobs')) as string[]).sort();
const file = (name: string, text = name) => new File([text], name);

describe('recent files kept in browser storage', () => {
  beforeEach(() => {
    store = new MemoryStore();
    setLocalStore(store);
    clearRecent(editor());
  });

  it('keeps one stored copy when the same file is opened again', async () => {
    const e = editor();
    for (let i = 0; i < 3; i++) {
      noteRecent(e, 'photo.png', { kind: 'local', blob: file('photo.png') });
      await settle();
    }
    expect(recentEntries()).toHaveLength(1);
    const key = (recentEntries()[0].source as { key: string }).key;
    expect(await stored()).toEqual([`recent:${key}`]);
  });

  it('deletes the stored copy and thumbnail of an entry replaced by a file of the same name', async () => {
    const e = editor();
    noteRecent(e, 'scan.tif', { kind: 'local', blob: file('scan.tif', 'first') });
    await settle();
    const first = (recentEntries()[0].source as { key: string }).key;
    await store.put('thumbs', `stored:${first}`, new Blob(['thumb']));
    noteRecent(e, 'scan.tif', { kind: 'local', blob: file('scan.tif', 'second') });
    await settle();
    expect(await store.get('thumbs', `stored:${first}`)).toBeUndefined();
    expect(await stored()).toEqual([`recent:${(recentEntries()[0].source as { key: string }).key}`]);
  });

  it('keeps the stored copy when a stored entry is reopened', async () => {
    const e = editor();
    noteRecent(e, 'a.png', { kind: 'local', blob: file('a.png') });
    await settle();
    const source = recentEntries()[0].source;
    noteRecent(e, 'a.png', source);
    await settle();
    expect(recentEntries()[0].source).toEqual(source);
    expect(await stored()).toHaveLength(1);
  });

  it('deletes stored copies and thumbnails that fall off a shorter list', async () => {
    const e = editor();
    for (const n of ['a.png', 'b.png', 'c.png']) {
      noteRecent(e, n, { kind: 'local', blob: file(n) });
      await settle();
    }
    const oldest = (recentEntries()[2].source as { key: string }).key;
    await store.put('thumbs', `stored:${oldest}`, new Blob(['thumb']));
    syncRecentCommands(editor(2));
    await settle();
    expect(recentEntries().map((x) => x.name)).toEqual(['c.png', 'b.png']);
    expect(await stored()).toHaveLength(2);
    expect(await store.get('thumbs', `stored:${oldest}`)).toBeUndefined();
  });

  it('removes commands for local files pruned by the stored-file limit', async () => {
    const e = editor();
    for (let i = 0; i < 9; i++) {
      noteRecent(e, `file-${i}.png`, { kind: 'local', blob: file(`file-${i}.png`) });
      await settle();
    }
    expect(recentEntries()).toHaveLength(8);
    expect(await stored()).toHaveLength(8);
    const menu = [...commands.values()].filter((c) => /^file\.recent\.\d+$/.test(c.id));
    expect(menu.map((c) => c.label)).toEqual(recentEntries().map((entry) => `${entry.name}  (this device)`));
  });
});
