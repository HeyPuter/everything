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
