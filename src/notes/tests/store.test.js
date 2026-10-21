import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store, normalizeLevels, snippet } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';

async function freshStore(seed) {
  const backend = memoryBackend(seed);
  const store = new Store(backend, { saveDelay: 0 });
  await store.load();
  return { store, backend };
}

describe('Store: first run', () => {
  it('creates a starter notebook with two sections and one page', async () => {
    const { store, backend } = await freshStore();
    expect(store.notebooks).toHaveLength(1);
    const sections = [...store.sectionsOf(store.notebooks[0])];
    expect(sections.map((s) => s.name)).toEqual(['Quick Notes', 'New Section 1']);
    expect(sections[0].pages).toHaveLength(1);
    await store.flush();
    expect(backend.files.has('library.json')).toBe(true);
    expect(backend.files.has(`notebooks/${store.notebooks[0].id}.json`)).toBe(true);
    expect(backend.files.has(`pages/${sections[0].pages[0].id}.json`)).toBe(true);
  });

  it('reloads what it saved', async () => {
    const { store, backend } = await freshStore();
    const nb = store.notebooks[0];
    const s = [...store.sectionsOf(nb)][0];
    const meta = store.createPage(s.id, { title: 'Groceries' });
    const page = await store.loadPage(meta.id);
    page.outlines.push({ id: 'o1', x: 40, y: 100, w: null, html: '<p>Milk</p>' });
    store.pageChanged(page, { title: 'Groceries' });
    await store.flush();

    const again = new Store(backend, { saveDelay: 0 });
    await again.load();
    const found = again.findPage(meta.id);
    expect(found.meta.title).toBe('Groceries');
    const loaded = await again.loadPage(meta.id);
    expect(loaded.outlines[0].html).toBe('<p>Milk</p>');
  });

  it('still opens when library.json or trash.json is damaged', async () => {
    for (const file of ['library.json', 'trash.json']) {
      const { store, backend } = await freshStore();
      const nb = store.notebooks[0];
      const keep = store.createPage([...store.sectionsOf(nb)][0].id, { title: 'Keep me' });
      store.deletePage(store.createPage([...store.sectionsOf(nb)][0].id, { title: 'Bin' }).id);
      await store.flush();
      backend.files.set(file, backend.files.get(file).slice(0, 12));
      const again = new Store(backend, { saveDelay: 0 });
      await again.load();
      expect(again.notebooks.map((n) => n.id)).toEqual([nb.id]);
      expect(again.findPage(keep.id).meta.title).toBe('Keep me');
      // The damaged file is replaced by the next save.
      again.deletePage(keep.id);
      await again.flush();
      expect(again.status).toBe('saved');
      expect(() => JSON.parse(backend.files.get(file))).not.toThrow();
    }
  });

  it('picks up notebooks missing from library.json', async () => {
    const { store, backend } = await freshStore();
    const other = { id: 'nother', v: 1, name: 'Other device', color: 'blue', created: 'x', modified: 'x', sections: [] };
    backend.files.set('notebooks/nother.json', JSON.stringify(other));
    const again = new Store(backend, { saveDelay: 0 });
    await again.load();
    expect(again.notebooks.map((n) => n.name)).toContain('Other device');
    expect(store.notebooks).toHaveLength(1);
  });
});

describe('Store: sections and groups', () => {
  let store;
  let nb;
  beforeEach(async () => {
    ({ store } = await freshStore());
    nb = store.notebooks[0];
  });

  it('names new sections uniquely', () => {
    const a = store.createSection(nb.id);
    const b = store.createSection(nb.id);
    expect(a.name).toBe('New Section 2');
    expect(b.name).toBe('New Section 3');
  });

  it('moves a section into a group and reorders', () => {
    const g = store.createGroup(nb.id, { name: 'Work' });
    const s = store.createSection(nb.id, { name: 'Meetings' });
    expect(store.moveNode(s.id, { parentId: g.id, index: 0 })).toBe(true);
    expect(g.children.map((c) => c.name)).toEqual(['Meetings']);
    expect(store.findNode(s.id).parent.id).toBe(g.id);
  });

  it('refuses to move a group into itself', () => {
    const g = store.createGroup(nb.id, { name: 'Outer' });
    const inner = store.createGroup(nb.id, { name: 'Inner', parentId: g.id });
    expect(store.moveNode(g.id, { parentId: inner.id })).toBe(false);
  });

  it('deletes to the trash and restores in place', () => {
    const [first, second] = [...store.sectionsOf(nb)];
    store.deleteNode(first.id);
    expect([...store.sectionsOf(nb)].map((s) => s.id)).toEqual([second.id]);
    expect(store.trash[0].kind).toBe('section');
    store.restore(store.trash[0].id);
    expect([...store.sectionsOf(nb)].map((s) => s.id)).toEqual([first.id, second.id]);
    expect(store.trash).toHaveLength(0);
  });

  it('copies a section with its pages under new ids', async () => {
    const [first] = [...store.sectionsOf(nb)];
    const copy = await store.copySection(first.id, { notebookId: nb.id });
    expect(copy.name).toBe('Quick Notes (copy)');
    expect(copy.pages).toHaveLength(first.pages.length);
    expect(copy.pages[0].id).not.toBe(first.pages[0].id);
  });
});

describe('Store: pages', () => {
  let store;
  let section;
  beforeEach(async () => {
    ({ store } = await freshStore());
    section = [...store.sectionsOf(store.notebooks[0])][1];
  });

  it('makes and promotes subpages, never deeper than the page above allows', () => {
    const a = store.createPage(section.id, { title: 'A' });
    const b = store.createPage(section.id, { title: 'B' });
    const c = store.createPage(section.id, { title: 'C' });
    expect(store.setPageLevel(a.id, 1)).toBe(false); // first page stays top level
    expect(store.setPageLevel(b.id, 1)).toBe(true);
    expect(store.setPageLevel(c.id, 2)).toBe(true);
    expect(section.pages.map((p) => p.level)).toEqual([0, 1, 2]);
    // Promoting B carries C along.
    store.setPageLevel(b.id, -1);
    expect(section.pages.map((p) => p.level)).toEqual([0, 0, 1]);
  });

  it('moves a page with its subpages to another section', () => {
    const a = store.createPage(section.id, { title: 'A' });
    const b = store.createPage(section.id, { title: 'B', level: 1 });
    const target = [...store.sectionsOf(store.notebooks[0])][0];
    store.movePage(a.id, { sectionId: target.id, index: 0 });
    expect(target.pages.slice(0, 2).map((p) => p.title)).toEqual(['A', 'B']);
    expect(section.pages.find((p) => p.id === b.id)).toBeUndefined();
  });

  it('reorders within a section', () => {
    const a = store.createPage(section.id, { title: 'A' });
    store.createPage(section.id, { title: 'B' });
    store.createPage(section.id, { title: 'C' });
    store.movePage(a.id, { sectionId: section.id, index: 3 });
    expect(section.pages.map((p) => p.title)).toEqual(['B', 'C', 'A']);
  });

  it('deleting a collapsed parent takes its subpages', () => {
    const a = store.createPage(section.id, { title: 'A' });
    store.createPage(section.id, { title: 'A1', level: 1 });
    store.createPage(section.id, { title: 'B' });
    store.togglePageCollapsed(a.id);
    store.deletePage(a.id);
    expect(section.pages.map((p) => p.title)).toEqual(['B']);
    expect(store.trash[0].pages.map((p) => p.title)).toEqual(['A', 'A1']);
    store.restore(store.trash[0].id);
    expect(section.pages.map((p) => p.title)).toEqual(['A', 'A1', 'B']);
  });

  it('purges page files permanently', async () => {
    const a = store.createPage(section.id, { title: 'Gone' });
    await store.flush();
    expect(store.backend.files.has(`pages/${a.id}.json`)).toBe(true);
    const entry = store.deletePage(a.id);
    await store.purge(entry.id);
    expect(store.backend.files.has(`pages/${a.id}.json`)).toBe(false);
  });

  it('keeps an entry in Deleted Notes when deleting its files fails', async () => {
    const a = store.createPage(section.id, { title: 'Stuck' });
    await store.flush();
    const entry = store.deletePage(a.id);
    store.backend.failNext = 1;
    await expect(store.purge(entry.id)).rejects.toThrow();
    expect(store.trash.some((t) => t.id === entry.id)).toBe(true);
    await store.purge(entry.id);
    expect(store.trash.some((t) => t.id === entry.id)).toBe(false);
    expect(store.backend.files.has(`pages/${a.id}.json`)).toBe(false);
  });

  it('takes down the shared link of a page deleted for good', async () => {
    const a = store.createPage(section.id, { title: 'Shared' });
    await store.flush();
    await store.backend.writeJSON(`published/${a.id}.json`, { format: 'notes-shared-page' });
    const entry = store.deletePage(a.id);
    // Only moving it to Deleted Notes keeps the link, so restoring keeps it too.
    expect(store.backend.files.has(`published/${a.id}.json`)).toBe(true);
    await store.purge(entry.id);
    expect(store.backend.files.has(`published/${a.id}.json`)).toBe(false);
  });

  it('leaves nothing behind when copying a section fails part way', async () => {
    const a = store.createPage(section.id, { title: 'First' });
    const b = store.createPage(section.id, { title: 'Second' });
    await store.flush();
    store.pages.delete(a.id);
    store.pages.delete(b.id);
    const backend = store.backend;
    const files = backend.files.size;
    const read = backend.readJSON;
    backend.readJSON = async (path) => {
      await new Promise((r) => setTimeout(r, 5));
      if (path === `pages/${b.id}.json`) throw new Error('Simulated network failure');
      return read(path);
    };
    const sections = [...store.sectionsOf(store.notebooks[0])].length;
    await expect(store.copySection(section.id)).rejects.toThrow();
    backend.readJSON = read;
    await store.flush();
    expect([...store.sectionsOf(store.notebooks[0])].length).toBe(sections);
    expect(backend.files.size).toBe(files);
  });

  it('copies a page next to the original', async () => {
    const a = store.createPage(section.id, { title: 'Plan' });
    store.createPage(section.id, { title: 'Other' });
    const copy = await store.copyPage(a.id);
    expect(section.pages.map((p) => p.title)).toEqual(['Plan', 'Plan (copy)', 'Other']);
    expect(copy.id).not.toBe(a.id);
  });
});

describe('Store: search and tags', () => {
  it('finds pages by every term, ranking title hits first', async () => {
    const { store } = await freshStore();
    const section = [...store.sectionsOf(store.notebooks[0])][0];
    const a = store.createPage(section.id, { title: 'Trip to Zürich', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>Pack the camera</p>' }] });
    const b = store.createPage(section.id, { title: 'Misc', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>Zurich camera shop</p>' }] });
    store.createPage(section.id, { title: 'Nothing', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>unrelated</p>' }] });
    const results = await store.search('zurich camera');
    expect(results.map((r) => r.meta.id)).toEqual([a.id, b.id]);
    expect(results[1].snippet).toContain('Zurich camera shop');
  });

  it('collects tagged paragraphs with their state', async () => {
    const { store } = await freshStore();
    const section = [...store.sectionsOf(store.notebooks[0])][0];
    store.createPage(section.id, {
      title: 'Tasks',
      outlines: [{ id: 'o', x: 0, y: 0, html: '<p><span class="nt-tag" data-tag="todo" data-done="true" contenteditable="false"></span>Call Sam</p><p><span class="nt-tag" data-tag="important" contenteditable="false"></span>Rent due</p>' }],
    });
    const tags = await store.collectTags();
    expect(tags.map((t) => [t.tag, t.done, t.text])).toEqual([
      ['todo', true, 'Call Sam'],
      ['important', false, 'Rent due'],
    ]);
  });
});

describe('Store: saving', () => {
  it('retries a failed write and reports the error state meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const backend = memoryBackend();
      const store = new Store(backend, { saveDelay: 0 });
      const loading = store.load();
      await vi.runAllTimersAsync();
      await loading;
      const statuses = [];
      store.on('status', (s) => statuses.push(s));
      backend.failNext = 1;
      store.renameNotebook(store.notebooks[0].id, 'Renamed');
      await vi.advanceTimersByTimeAsync(10);
      expect(store.status).toBe('error');
      expect(statuses).toContain('error');
      await vi.advanceTimersByTimeAsync(6000);
      expect(store.status).toBe('saved');
      expect(JSON.parse(backend.files.get(`notebooks/${store.notebooks[0].id}.json`)).name).toBe('Renamed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Store: page versions on a flaky connection', () => {
  it('never replaces the version list when reading it fails', async () => {
    const backend = memoryBackend();
    const store = new Store(backend, { saveDelay: 0 });
    await store.load();
    const meta = [...store.sectionsOf(store.notebooks[0])][0].pages[0];
    const old = Array.from({ length: 3 }, (_, i) => ({ at: new Date(Date.now() - (i + 1) * 3600000).toISOString(), page: { id: meta.id, title: `v${i}`, modified: `m${i}`, outlines: [], ink: [] } }));
    backend.files.set(`versions/${meta.id}.json`, JSON.stringify(old));
    await store.flush();
    const again = new Store(backend, { saveDelay: 0 });
    await again.load();
    const page = await again.loadPage(meta.id);
    page.title = 'Edited';
    backend.failNext = 1; // the version list read
    again.pageChanged(page, { title: 'Edited' });
    await new Promise((r) => setTimeout(r, 20));
    await again.flush();
    expect((await again.versions(meta.id)).length).toBeGreaterThanOrEqual(3);
    backend.failNext = 1;
    await expect(again.addVersion(meta.id, structuredClone(page))).rejects.toThrow();
    expect((await again.versions(meta.id)).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Store: uploads', () => {
  it('counts a picture being uploaded as unsaved until it is stored', async () => {
    const backend = memoryBackend();
    const store = new Store(backend, { saveDelay: 0 });
    await store.load();
    await store.flush();
    backend.delay = 30;
    const upload = store.saveAsset(new Blob(['a recording']), 'memo.webm');
    backend.delay = 0;
    const other = store.saveAsset(new Blob(['a picture']), 'a.png');
    await new Promise((r) => setTimeout(r, 5));
    expect(store.hasUnsaved()).toBe(true);
    expect(store.status).toBe('saving');
    await other;
    expect(store.status).toBe('saving');
    await upload;
    expect(store.hasUnsaved()).toBe(false);
    expect(store.status).toBe('saved');
  });
});

describe('Store: saving after a failure', () => {
  it('stops reporting a failed save once what it was saving is deleted', async () => {
    const backend = memoryBackend();
    const store = new Store(backend, { saveDelay: 0 });
    await store.load();
    const nb = store.createNotebook('Scratch');
    const page = store.createPage(store.createSection(nb.id).id, { title: 'Draft' });
    backend.failNext = 100;
    await store.flush();
    expect(store.status).toBe('error');
    backend.failNext = 0;
    const entry = store.deleteNotebook(nb.id);
    await store.purge(entry.id);
    await store.flush();
    expect(store.findPage(page.id)).toBeNull();
    expect(store.status).toBe('saved');
  });
});

describe('Store: Deleted Notes on two devices', () => {
  const later = () => new Promise((r) => setTimeout(r, 5));
  async function twoDevices() {
    const backend = memoryBackend();
    const a = new Store(backend, { saveDelay: 0 });
    await a.load();
    const section = [...a.sectionsOf(a.notebooks[0])][0];
    const one = a.createPage(section.id, { title: 'One' });
    const two = a.createPage(section.id, { title: 'Two' });
    await a.flush();
    const b = new Store(backend, { saveDelay: 0 });
    await b.load();
    await later();
    return { backend, a, b, one, two };
  }

  it('keeps pages deleted on each device in Deleted Notes', async () => {
    const { backend, a, b, one, two } = await twoDevices();
    a.deletePage(one.id);
    await a.flush();
    await later();
    await b.refresh();
    b.deletePage(two.id);
    await b.flush();
    const c = new Store(backend, { saveDelay: 0 });
    await c.load();
    expect(c.trash.map((t) => t.pages[0].title).sort()).toEqual(['One', 'Two']);
    // A session that never refreshed still merges before it writes.
    await a.purge(a.trash[0].id);
    await a.flush();
    const d = new Store(backend, { saveDelay: 0 });
    await d.load();
    expect(d.trash.map((t) => t.pages[0].title)).toEqual(['Two']);
  });

  it('does not bring back what another device restored or emptied', async () => {
    const { backend, a, b, one, two } = await twoDevices();
    const e1 = a.deletePage(one.id);
    a.deletePage(two.id);
    await a.flush();
    await later();
    await b.refresh();
    expect(b.trash).toHaveLength(2);
    b.restore(e1.id);
    await b.flush();
    // a still lists both; its next Deleted Notes save must not undo b's restore.
    const n = a.createNotebook('Other');
    a.deleteNotebook(n.id);
    await a.flush();
    expect(a.trash.map((t) => t.kind).sort()).toEqual(['notebook', 'page']);
    const c = new Store(backend, { saveDelay: 0 });
    await c.load();
    expect(c.findPage(one.id)).toBeTruthy();
    expect(c.trash.some((t) => t.id === e1.id)).toBe(false);
  });

  it('drops a notebook deleted on another device', async () => {
    const { backend, a, b } = await twoDevices();
    const nb = a.createNotebook('Trip');
    await a.flush();
    await later();
    await b.refresh();
    expect(b.notebook(nb.id)).toBeTruthy();
    a.deleteNotebook(nb.id);
    await a.flush();
    await later();
    expect(await b.refresh()).toBe(true);
    expect(b.notebook(nb.id)).toBeNull();
    b.moveNotebook(b.notebooks[0].id, 0);
    await b.flush();
    const c = new Store(backend, { saveDelay: 0 });
    await c.load();
    expect(c.notebook(nb.id)).toBeNull();
    expect(c.trash.some((t) => t.kind === 'notebook' && t.notebook.id === nb.id)).toBe(true);
  });

  it('never purges or duplicates a page that is live again', async () => {
    const { a, one } = await twoDevices();
    const entry = a.deletePage(one.id);
    await a.flush();
    // The same page back in its section while its entry is still listed.
    const section = [...a.sectionsOf(a.notebooks[0])][0];
    section.pages.push(...structuredClone(entry.pages));
    a.trash.unshift(structuredClone(entry));
    a.restore(entry.id);
    expect(section.pages.filter((p) => p.id === one.id)).toHaveLength(1);
    await a.flush();
    const saved = JSON.parse(a.backend.files.get(`notebooks/${a.notebooks[0].id}.json`));
    expect(saved.sections[0].pages.filter((p) => p.id === one.id)).toHaveLength(1);
    a.trash.unshift(structuredClone(entry));
    await a.purge(entry.id);
    expect(a.backend.files.has(`pages/${one.id}.json`)).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizeLevels clamps orphaned subpages', () => {
    expect(normalizeLevels([{ level: 2 }, { level: 2 }, { level: 0 }, { level: 2 }]).map((p) => p.level)).toEqual([0, 1, 0, 1]);
  });
  it('snippet shows context around the first match', () => {
    const s = snippet('a '.repeat(100) + 'needle in the haystack', ['needle'], 10);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('needle');
  });
});

describe('Store: page versions', () => {
  it('keeps the state from before an editing session, once per interval', async () => {
    const backend = memoryBackend();
    const first = new Store(backend, { saveDelay: 0 });
    await first.load();
    const section = [...first.sectionsOf(first.notebooks[0])][0];
    const meta = first.createPage(section.id, { title: 'Draft', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>v1</p>' }] });
    await first.flush();

    const second = new Store(backend, { saveDelay: 0 });
    await second.load();
    const page = await second.loadPage(meta.id);
    page.outlines[0].html = '<p>v2</p>';
    second.pageChanged(page);
    await second.flush();
    await new Promise((r) => setTimeout(r, 10));
    page.outlines[0].html = '<p>v3</p>';
    second.pageChanged(page);
    await second.flush();
    await new Promise((r) => setTimeout(r, 10));

    const versions = await second.versions(meta.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].page.outlines[0].html).toBe('<p>v1</p>');

    // Reloading and editing again inside the interval adds nothing.
    const third = new Store(backend, { saveDelay: 0 });
    await third.load();
    const again = await third.loadPage(meta.id);
    again.outlines[0].html = '<p>v4</p>';
    third.pageChanged(again);
    await third.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(await third.versions(meta.id)).toHaveLength(1);

    await third.restoreVersion(meta.id, versions[0].at);
    expect((await third.loadPage(meta.id)).outlines[0].html).toBe('<p>v1</p>');
  });
});

describe('Store: changes from another device', () => {
  it('reloads an open page saved elsewhere, but never over unsaved edits', async () => {
    const backend = memoryBackend();
    const a = new Store(backend, { saveDelay: 0 });
    await a.load();
    const section = [...a.sectionsOf(a.notebooks[0])][0];
    const meta = a.createPage(section.id, { title: 'Shared', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>one</p>' }] });
    await a.flush();
    const page = await a.loadPage(meta.id);

    const b = new Store(backend, { saveDelay: 0, now: () => new Date(Date.now() + 60000).toISOString() });
    await b.load();
    const other = await b.loadPage(meta.id);
    other.outlines[0].html = '<p>two</p>';
    b.pageChanged(other);
    await b.flush();

    expect(await a.refreshPage(meta.id)).toBe(true);
    expect(page.outlines[0].html).toBe('<p>two</p>');

    page.outlines[0].html = '<p>local edit</p>';
    a.schedule(`pages/${meta.id}.json`, () => page, 10000);
    expect(await a.refreshPage(meta.id)).toBe(false);
    a.cancel(`pages/${meta.id}.json`);
  });
});
