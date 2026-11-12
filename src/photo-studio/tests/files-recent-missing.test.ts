// An Open Recent entry whose stored copy is gone (browser data cleared) is
// taken off the list with a plain message, instead of failing every time.
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setLocalStore } from '../src/persistence/local-store';
import { clearRecent, noteRecent, recentEntries } from '../src/features/files/recent';
import { openRecentEntry } from '../src/features/files/save';
import type { Editor } from '../src/editor';

let store: MemoryStore;
const editor = () => ({ preferences: { recentCount: 10 } }) as unknown as Editor;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Open Recent with a missing stored copy', () => {
  beforeEach(() => {
    store = new MemoryStore();
    setLocalStore(store);
    clearRecent(editor());
  });
  it('removes the entry and says why', async () => {
    const e = editor();
    noteRecent(e, 'kept.png', { kind: 'local', blob: new File(['a'], 'kept.png') });
    noteRecent(e, 'gone.png', { kind: 'local', blob: new File(['b'], 'gone.png') });
    await settle();
    const gone = recentEntries()[0];
    expect(gone.source.kind).toBe('stored');
    await store.delete('blobs', `recent:${(gone.source as { key: string }).key}`);
    await expect(openRecentEntry(e, gone)).rejects.toThrow('gone.png is no longer stored in this browser and was removed from Open Recent. Open it again from its location.');
    expect(recentEntries().map((x) => x.name)).toEqual(['kept.png']);
  });
});
