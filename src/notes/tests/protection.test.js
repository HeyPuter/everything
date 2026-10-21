import { describe, it, expect } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';

function allText(backend) {
  return [...backend.files.values()].map((v) => (typeof v === 'string' ? v : '')).join('\n');
}

async function setup() {
  const backend = memoryBackend();
  const store = new Store(backend, { saveDelay: 0 });
  await store.load();
  const nb = store.notebooks[0];
  const section = store.createSection(nb.id, { name: 'Diary' });
  const meta = store.createPage(section.id, { title: 'Secret plans', outlines: [{ id: 'o', x: 0, y: 0, html: '<p>The treasure is buried under the oak</p>' }] });
  await store.flush();
  return { backend, store, section, meta };
}

describe('password-protected sections', () => {
  it('stores titles and text only encrypted', async () => {
    const { backend, store, section } = await setup();
    expect(allText(backend)).toContain('treasure');
    await store.protectSection(section.id, 'correct horse');
    await store.flush();
    const text = allText(backend);
    expect(text).not.toContain('treasure');
    expect(text).not.toContain('Secret plans');
    expect(text).toContain('Diary'); // section names stay visible so the locked section can be found
  });

  it('hides pages after locking and opens them with the right password only', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'correct horse');
    await store.lockSection(section.id);
    expect(store.section(section.id).pages).toEqual([]);
    expect(store.findPage(meta.id)).toBeNull();

    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(fresh.section(section.id).pages).toEqual([]);
    expect(await fresh.search('treasure')).toEqual([]);
    expect(await fresh.unlockSection(section.id, 'wrong')).toBe(false);
    expect(await fresh.unlockSection(section.id, 'correct horse')).toBe(true);
    expect(fresh.section(section.id).pages.map((p) => p.title)).toEqual(['Secret plans']);
    const page = await fresh.loadPage(meta.id);
    expect(page.outlines[0].html).toContain('treasure');
    expect((await fresh.search('treasure')).length).toBe(1);
  });

  it('keeps edits made while unlocked encrypted', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const page = await store.loadPage(meta.id);
    page.outlines[0].html = '<p>moved to the cave</p>';
    store.pageChanged(page);
    store.createPage(section.id, { title: 'Second secret' });
    await store.flush();
    const text = allText(backend);
    expect(text).not.toContain('cave');
    expect(text).not.toContain('Second secret');
  });

  it('encrypts pictures and keeps them readable while unlocked', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const id = await store.saveAsset(new Blob(['PNGDATA-visible'], { type: 'image/png' }), 'cat.png', { sectionId: section.id });
    expect(id.endsWith('.sealed')).toBe(true);
    const stored = backend.files.get(`assets/${id}`);
    expect(await stored.text()).not.toContain('PNGDATA');
    expect(await (await store.assetBlob(id)).text()).toBe('PNGDATA-visible');
    const page = await store.loadPage(meta.id);
    page.outlines[0].html += `<p><img data-asset="${id}" alt=""></p>`;
    store.pageChanged(page);
    await store.flush();
    // Removing the password turns the picture back into a plain file.
    await store.unprotectSection(section.id);
    const plain = page.outlines[0].html.match(/data-asset="([^"]+)"/)[1];
    expect(plain.endsWith('.sealed')).toBe(false);
    expect(await (await store.assetBlob(plain)).text()).toBe('PNGDATA-visible');
    expect(allText(backend)).toContain('treasure');
  });

  it('changes the password', async () => {
    const { backend, store, section } = await setup();
    await store.protectSection(section.id, 'old');
    await store.protectSection(section.id, 'new');
    await store.lockSection(section.id);
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.unlockSection(section.id, 'old')).toBe(false);
    expect(await fresh.unlockSection(section.id, 'new')).toBe(true);
  });

  it('seals deleted pages of a protected section in Deleted Notes', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const entry = store.deletePage(meta.id);
    await store.flush();
    expect(allText(backend)).not.toContain('Secret plans');
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.openTrash(entry.id)).toBe(false);
    await fresh.unlockSection(section.id, 'pw');
    expect(await fresh.openTrash(entry.id)).toBe(true);
    fresh.restore(entry.id);
    expect(fresh.section(section.id).pages.map((p) => p.title)).toEqual(['Secret plans']);
  });
});

describe('password-protected sections: edge cases', () => {
  it('never writes plaintext for a page edited and then deleted', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const page = await store.loadPage(meta.id);
    page.outlines[0].html = '<p>last minute secret</p>';
    store.schedule(`pages/${meta.id}.json`, () => store.pages.get(meta.id), 50);
    store.deletePage(meta.id);
    await store.flush();
    expect(allText(backend)).not.toContain('last minute secret');
  });

  it('refuses new pages and moves into a locked section', async () => {
    const { store, section } = await setup();
    await store.protectSection(section.id, 'pw');
    await store.lockSection(section.id);
    expect(() => store.createPage(section.id, { title: 'x' })).toThrow();
    const other = [...store.sectionsOf(store.notebooks[0])][0];
    const m = store.createPage(other.id, { title: 'outside' });
    expect(store.movePage(m.id, { sectionId: section.id })).toBe(false);
    expect(store.findPage(m.id).section.id).toBe(other.id);
  });

  it('opens a page moved out of a protected section before it was loaded', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    await store.lockSection(section.id);
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    await fresh.unlockSection(section.id, 'pw');
    const plain = [...fresh.sectionsOf(fresh.notebooks[0])][0];
    expect(fresh.movePage(meta.id, { sectionId: plain.id })).toBe(true);
    const page = await fresh.loadPage(meta.id);
    expect(page.outlines[0].html).toContain('treasure');
  });

  it('keeps deleted pages restorable after a password change and after locking', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'old');
    const entry = store.deletePage(meta.id);
    await store.flush();
    await store.protectSection(section.id, 'new');
    await store.lockSection(section.id);
    // Another trash write while locked must not empty the entry.
    store.scheduleTrash();
    await store.flush();
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.unlockSection(section.id, 'new')).toBe(true);
    expect(await fresh.openTrash(entry.id)).toBe(true);
    fresh.restore(entry.id);
    expect((await fresh.loadPage(meta.id)).outlines[0].html).toContain('treasure');
  });
});

describe('password-protected sections: saving while offline', () => {
  it('keeps an edit whose save failed when the section locks', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const page = await store.loadPage(meta.id);
    page.outlines[0].html = '<p>written offline</p>';
    store.pageChanged(page);
    backend.failNext = 1000;
    await store.lockSection(section.id);
    expect(store.status).toBe('error');
    backend.failNext = 0;
    // Unlocking before the retry ran opens the edit, not the stale file.
    expect(await store.unlockSection(section.id, 'pw')).toBe(true);
    expect((await store.loadPage(meta.id)).outlines[0].html).toContain('written offline');
    await store.lockSection(section.id);
    await store.flush();
    expect(store.status).toBe('saved');
    expect(allText(backend)).not.toContain('written offline');
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    await fresh.unlockSection(section.id, 'pw');
    expect((await fresh.loadPage(meta.id)).outlines[0].html).toContain('written offline');
  });
});

describe('password-protected sections: page versions', () => {
  it('leaves no plaintext version behind when a page is protected right after an edit', async () => {
    const { backend, section, meta } = await setup();
    // A new session, so the first edit keeps the loaded page as a version.
    const store = new Store(backend, { saveDelay: 0 });
    await store.load();
    const page = await store.loadPage(meta.id);
    backend.delay = 300;
    page.outlines[0].html = '<p>moved to the cave</p>';
    store.pageChanged(page);
    await store.protectSection(section.id, 'pw');
    backend.delay = 0;
    await new Promise((r) => setTimeout(r, 400));
    await store.flush();
    expect(allText(backend)).not.toContain('treasure');
    expect(allText(backend)).not.toContain('cave');
  });
});

describe('password-protected sections: Deleted Notes', () => {
  it('locks a section that was deleted while unlocked', async () => {
    const { store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const entry = store.deleteNode(section.id);
    await store.lockAll();
    expect(store.keys.size).toBe(0);
    expect(store.pages.has(meta.id)).toBe(false);
    store.restore(entry.id);
    expect(store.isLocked(section.id)).toBe(true);
    expect(store.section(section.id).pages).toEqual([]);
    expect(await store.unlockSection(section.id, 'pw')).toBe(true);
    expect(store.section(section.id).pages.map((p) => p.title)).toEqual(['Secret plans']);
  });
});

describe('password-protected sections: other devices', () => {
  it('locks a section whose password was changed on another device', async () => {
    const { backend, store, section } = await setup();
    await store.protectSection(section.id, 'old');
    const other = new Store(backend, { saveDelay: 0 });
    await other.load();
    expect(await other.unlockSection(section.id, 'old')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await store.protectSection(section.id, 'new');
    await new Promise((r) => setTimeout(r, 5));
    expect(await other.refresh()).toBe(true);
    expect(other.isLocked(section.id)).toBe(true);
    // A later save of that notebook must keep the section's pages.
    other.renameNotebook(other.notebooks[0].id, 'Renamed');
    await other.flush();
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.unlockSection(section.id, 'new')).toBe(true);
    expect(fresh.section(section.id).pages.map((p) => p.title)).toEqual(['Secret plans']);
  });
});

describe('password-protected sections: removing the password', () => {
  it('keeps deleted pages restorable', async () => {
    const { backend, store, section, meta } = await setup();
    await store.protectSection(section.id, 'pw');
    const page = await store.loadPage(meta.id);
    const asset = await store.saveAsset(new Blob(['png bytes'], { type: 'image/png' }), 'a.png', { sectionId: section.id });
    page.outlines[0].html += `<p><img data-asset="${asset}"></p>`;
    store.pageChanged(page);
    const entry = store.deletePage(meta.id);
    await store.lockSection(section.id);
    expect(await store.unlockSection(section.id, 'pw')).toBe(true);
    expect(await store.unprotectSection(section.id)).toBe(true);
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.openTrash(entry.id)).toBe(true);
    expect(fresh.trash[0].pages[0].title).toBe('Secret plans');
    expect(fresh.restore(entry.id).pageId).toBe(meta.id);
    const back = await fresh.loadPage(meta.id);
    expect(back.outlines[0].html).toContain('treasure');
    const img = back.outlines[0].html.match(/data-asset="([^"]+)"/)[1];
    expect(img.endsWith('.sealed')).toBe(false);
    expect(await (await fresh.assetBlob(img)).text()).toBe('png bytes');
  });
});

describe('password-protected sections: restoring deleted pages', () => {
  it('encrypts a page restored into a section protected since it was deleted', async () => {
    const { backend, store, section, meta } = await setup();
    const entry = store.deletePage(meta.id);
    await store.protectSection(section.id, 'pw');
    store.restore(entry.id);
    await new Promise((r) => setTimeout(r, 10));
    await store.flush();
    expect(allText(backend)).not.toContain('treasure');
    await store.lockSection(section.id);
    expect(await store.unlockSection(section.id, 'pw')).toBe(true);
    expect((await store.loadPage(meta.id)).outlines[0].html).toContain('treasure');
  });

  it('keeps a page readable when its protected section was deleted and it lands elsewhere', async () => {
    const { backend, store, section, meta } = await setup();
    const other = store.createSection(store.notebooks[0].id, { name: 'Journal' });
    await store.protectSection(section.id, 'one');
    await store.protectSection(other.id, 'two');
    const entry = store.deletePage(meta.id);
    store.deleteNode(section.id);
    for (const s of [...store.sectionsOf(store.notebooks[0])]) if (s.id !== other.id) store.deleteNode(s.id);
    expect(await store.openTrash(entry.id)).toBe(true);
    expect(store.restore(entry.id).sectionId).toBe(other.id);
    await new Promise((r) => setTimeout(r, 10));
    await store.flush();
    await store.lockAll();
    expect(allText(backend)).not.toContain('treasure');
    const fresh = new Store(backend, { saveDelay: 0 });
    await fresh.load();
    expect(await fresh.unlockSection(other.id, 'two')).toBe(true);
    expect((await fresh.loadPage(meta.id)).outlines[0].html).toContain('treasure');
  });
});

describe('asset ids', () => {
  it('only accepts generated names', async () => {
    const { isAssetId } = await import('../src/data/store.js');
    const { sanitizeHtml } = await import('../src/lib/sanitize.js');
    expect(isAssetId('akx81mz2p0qq.png')).toBe(true);
    expect(isAssetId('s1ab.a2cd.png.sealed')).toBe(true);
    expect(isAssetId('../notebooks/x.json')).toBe(false);
    expect(sanitizeHtml('<img data-asset="../notebooks/x.json">')).not.toContain('../');
  });
});
