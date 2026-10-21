import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';

// How the app reports saving, sharing and restoring outcomes to the user.

let mounted = [];

async function mount() {
  // Keep the toast host: toast.js creates it once and reuses it.
  for (const el of [...document.body.children]) if (!el.matches('.toasts')) el.remove();
  document.body.insertAdjacentHTML('afterbegin', '<div id="app"></div><div id="live-region"></div>');
  localStorage.clear();
  const backend = memoryBackend();
  const store = new Store(backend, { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  const app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
  mounted.push(app);
  return { app, store, backend };
}

const toasts = () => [...document.querySelectorAll('.toast-msg')].map((t) => t.textContent);

afterEach(() => {
  closeAllMenus();
  for (const a of mounted) a.destroy();
  mounted = [];
  document.querySelectorAll('.toast').forEach((t) => t.remove());
});

describe('Deleted Notes', () => {
  it('says so when a page cannot go back into its locked section', async () => {
    const { app, store } = await mount();
    const pageId = app.state.pageId;
    const sectionId = app.state.sectionId;
    const entry = store.deletePage(pageId);
    await store.protectSection(sectionId, 'pw');
    await store.lockSection(sectionId);
    expect(await app.restoreTrash(entry.id)).toBe(false);
    expect(store.trash.some((t) => t.id === entry.id)).toBe(true);
    expect(toasts()).toContain('Unlock the protected section first to restore this page.');
  });
});

describe('Share', () => {
  it('keeps the link marked as shared when Stop Sharing fails', async () => {
    const { app, backend } = await mount();
    const page = app.editor.page;
    await backend.writeJSON(`published/${page.id}.json`, { format: 'notes-shared-page' });
    page.published = { at: new Date().toISOString(), expires: '30d' };
    app.shareDialog();
    const stop = [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Stop Sharing');
    expect(stop.hidden).toBe(false);
    backend.failNext = 1;
    stop.click();
    await new Promise((r) => setTimeout(r, 0));
    const status = document.querySelector('dialog p.field-hint[role="status"]');
    expect(status.textContent).toMatch(/Couldn't stop sharing/);
    expect(stop.hidden).toBe(false);
    expect(page.published).toBeTruthy();
    expect(backend.files.has(`published/${page.id}.json`)).toBe(true);
    stop.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(status.textContent).toMatch(/Sharing stopped/);
    expect(backend.files.has(`published/${page.id}.json`)).toBe(false);
    expect(page.published).toBeUndefined();
  });
});

describe('Pictures and files', () => {
  it('reports a pasted or dropped picture that could not be saved', async () => {
    const { app, backend } = await mount();
    // jsdom never decodes pictures: make the decode check pass.
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      naturalWidth = 10;
      set src(_) {
        setTimeout(() => this.onload?.());
      }
    };
    backend.failNext = 1;
    try {
      await app.editor.insertFiles([new File(['x'], 'photo.png', { type: 'image/png' })]);
    } finally {
      globalThis.Image = RealImage;
    }
    expect(toasts().some((t) => t.startsWith("Couldn't insert photo.png"))).toBe(true);
    expect(app.editor.page.outlines.some((o) => o.html.includes('data-asset'))).toBe(false);
  });
});

describe('Changes from another device', () => {
  it('picks them up when the window regains focus', async () => {
    const { store } = await mount();
    const refresh = vi.spyOn(store, 'refresh');
    vi.useFakeTimers();
    try {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Copying while offline', () => {
  it('says so when Duplicate Page cannot read the page', async () => {
    const { app, store, backend } = await mount();
    const meta = store.createPage(app.state.sectionId, { title: 'Recipes' });
    await store.flush();
    store.pages.delete(meta.id); // not loaded yet in this session
    backend.failNext = 1;
    app.pageMenu(meta, { x: 10, y: 10 });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Duplicate Page'));
    item.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts()).toContain('Couldn\'t duplicate "Recipes". Check your connection and try again.');
  });
});

describe('Renaming while offline', () => {
  it('says so when a page that is not open cannot be read', async () => {
    const { app, store, backend } = await mount();
    const meta = store.createPage(app.state.sectionId, { title: 'Recipes' });
    await store.flush();
    store.pages.delete(meta.id);
    backend.failNext = 1;
    app.renamePage(meta.id, 'Dinners');
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts()).toContain("Couldn't rename the page. Check your connection and try again.");
    expect(store.findPage(meta.id).meta.title).toBe('Recipes');
  });
});

describe('Removing a password while offline', () => {
  it('says why it failed and keeps the section protected', async () => {
    const { app, store, backend } = await mount();
    const section = store.section(app.state.sectionId);
    await store.protectSection(section.id, 'pw');
    app.showEmpty();
    for (const m of section.pages) store.pages.delete(m.id);
    const { passwordDialog } = await import('../src/ui/features.js');
    passwordDialog(app, section);
    const remove = [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Remove Password');
    remove.click();
    await new Promise((r) => setTimeout(r, 0));
    backend.failNext = 1;
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Remove').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('dialog[open] .field-error').textContent).toMatch(/^Couldn't remove the password/);
    expect(section.locked).toBeTruthy();
  });
});

describe('Tags Summary', () => {
  it('checks off the to-do it lists even after the page changed', async () => {
    const { app, store } = await mount();
    const todo = (text) => `<p><span class="nt-tag" data-tag="todo" data-done="false"></span>${text}</p>`;
    const meta = store.createPage(app.state.sectionId, { title: 'Chores', outlines: [{ id: 'o1', x: 40, y: 120, w: null, html: todo('Buy milk') + todo('Call mom') }] });
    const listed = (await store.collectTags(`page:${meta.id}`)).find((t) => t.text === 'Call mom');
    // A new to-do goes in above it after the summary was made.
    const page = await store.loadPage(meta.id);
    page.outlines[0].html = todo('Water plants') + page.outlines[0].html;
    store.pageChanged(page);
    await app.taskPanes.setDone(listed, true);
    const done = (await store.collectTags(`page:${meta.id}`)).filter((t) => t.done).map((t) => t.text);
    expect(done).toEqual(['Call mom']);
  });
});

describe('Importing a notebook backup', () => {
  const backup = (pictures) => ({
    format: 'notes-backup',
    v: 1,
    notebook: { id: 'nOld', name: 'Trip', color: 'blue', sections: [{ type: 'section', id: 'sOld', name: 'Photos', color: 'green', pages: [{ id: 'pOld', title: 'Day 1', level: 0 }] }] },
    pages: { pOld: { id: 'pOld', title: 'Day 1', outlines: [{ id: 'o', x: 40, y: 120, w: null, html: pictures.map((a) => `<p><img data-asset="${a}" alt=""></p>`).join('') }], ink: [] } },
    assets: Object.fromEntries(pictures.map((a) => [a, 'data:image/png;base64,iVBORw0KGgo='])),
  });

  it('imports the pages and pictures', async () => {
    const { app, store } = await mount();
    const { importBackup } = await import('../src/ui/features.js');
    const nb = await importBackup(app, backup(['aold1.png']));
    await store.flush();
    const section = [...store.sectionsOf(nb)][0];
    const page = await store.loadPage(section.pages[0].id);
    const id = page.outlines[0].html.match(/data-asset="([^"]+)"/)[1];
    expect(id).not.toBe('aold1.png');
    expect(await store.assetBlob(id)).toBeTruthy();
  });

  it('says how many pictures could not be saved', async () => {
    const { app, backend } = await mount();
    const { importBackup } = await import('../src/ui/features.js');
    backend.failNext = 1;
    await importBackup(app, backup(['aold1.png', 'aold2.png']));
    expect(toasts()).toContain("1 picture or file couldn't be imported. Check your connection and import the backup again.");
  });
});

describe('Page Versions', () => {
  it('says so when restoring a version fails', async () => {
    const { app, store, backend } = await mount();
    const page = app.editor.page;
    await store.addVersion(page.id, { ...structuredClone(page), outlines: [{ id: 'old', x: 40, y: 120, w: null, html: '<p>Earlier</p>' }] });
    app.taskPanes.toggle('versions');
    await new Promise((r) => setTimeout(r, 10));
    const restore = [...document.querySelectorAll('.task-pane button, aside button')].find((b) => b.textContent === 'Restore');
    restore.click();
    await new Promise((r) => setTimeout(r, 0));
    backend.failNext = 1;
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Restore').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(toasts()).toContain("Couldn't restore this version. Check your connection and try again.");
    expect(toasts()).not.toContain('Version restored');
    expect(app.editor.page.outlines.some((o) => o.html.includes('Earlier'))).toBe(false);
  });
});

describe('Opening a page', () => {
  it('says a damaged page file is damaged, and a failed read is a connection problem', async () => {
    const { app, store, backend } = await mount();
    const a = store.createPage(app.state.sectionId, { title: 'Broken' });
    const b = store.createPage(app.state.sectionId, { title: 'Far away' });
    await store.flush();
    store.pages.delete(a.id);
    store.pages.delete(b.id);
    backend.files.set(`pages/${a.id}.json`, '{"id":"' + a.id + '","outl');
    await app.openPage(a.id);
    expect(toasts()).toContain("Couldn't open this page: its file is damaged.");
    backend.failNext = 1;
    await app.openPage(b.id);
    expect(toasts()).toContain("Couldn't open this page. Check your connection and try again.");
  });
});
