import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { fileMenu } from '../src/ui/ribbon-def.js';

let app;
let store;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const toasts = () => [...document.querySelectorAll('.toast-msg')].map((t) => t.textContent);
const pageTitles = () => store.section(app.state.sectionId).pages.map((p) => store.pages.get(p.id)?.title ?? p.title);

// A launch item or a picked file: an entry of the Puter drive that can read itself.
const launchItem = (path, text, extra = {}) => ({ path, name: path.split('/').pop(), uid: `uid-${path}`, read: async () => new Blob([text]), ...extra });

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  sessionStorage.clear();
  store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
});

afterEach(() => {
  closeAllMenus();
  app.destroy();
  delete globalThis.puter;
  document.querySelector('.toasts')?.replaceChildren();
});

describe('files the Puter desktop opens Notes with', () => {
  it('imports a Markdown file as a page of the current section and opens it', async () => {
    await app.openLaunchItems([launchItem('/sam/Documents/plan.md', '# Launch plan\n\n- ship it')]);
    expect(pageTitles()).toContain('Launch plan');
    expect(app.editor.page.title).toBe('Launch plan');
    expect(app.editor.page.outlines[0].html).toContain('ship it');
  });

  it('imports HTML and text files too', async () => {
    await app.openLaunchItems([
      launchItem('/sam/a.html', '<html><head><title>From HTML</title></head><body><p>hello</p></body></html>'),
      launchItem('/sam/notes.txt', 'plain words'),
    ]);
    expect(pageTitles()).toEqual(expect.arrayContaining(['From HTML', 'notes']));
  });

  it('restores a notebook backup as a notebook of its own', async () => {
    const backup = { format: 'notes-backup', notebook: { name: 'Trip', sections: [{ id: 's1', name: 'Days', pages: [{ id: 'p1', title: 'Day 1' }] }] }, pages: { p1: { id: 'p1', title: 'Day 1', outlines: [] } } };
    await app.openLaunchItems([launchItem('/sam/trip.json', JSON.stringify(backup))]);
    expect(store.notebooks.map((n) => n.name)).toContain('Trip');
  });

  it('does not read files Notes cannot import, and says so', async () => {
    let read = false;
    const before = pageTitles().length;
    await app.openLaunchItems([launchItem('/sam/photo.png', 'x', { read: async () => ((read = true), new Blob(['x'])) })]);
    expect(read).toBe(false);
    expect(pageTitles().length).toBe(before);
    expect(toasts().join()).toMatch(/photo\.png can't be opened in Notes/);
  });

  it('refuses a JSON file that is not a notebook backup', async () => {
    await app.openLaunchItems([launchItem('/sam/data.json', '{"a":1}')]);
    expect(toasts().join()).toMatch(/data\.json is not a notebook backup/);
  });

  it('explains that a folder cannot be opened', async () => {
    await app.openLaunchItems([{ path: '/sam/Documents', name: 'Documents', is_dir: true }]);
    expect(toasts().join()).toMatch(/Folders can't be opened/);
  });

  it('reports a file that cannot be read', async () => {
    await app.openLaunchItems([launchItem('/sam/gone.md', '', { read: async () => Promise.reject({ error: { message: 'Not found' } }) })]);
    expect(toasts().join()).toMatch(/Couldn't open gone\.md: Not found/);
  });

  it('does not import the same launch again when the window reloads', async () => {
    const item = launchItem('/sam/plan.md', '# Once');
    await app.openLaunchItems([item]);
    await app.openLaunchItems([item]);
    expect(pageTitles().filter((t) => t === 'Once')).toHaveLength(1);
  });
});

describe('Import from Puter', () => {
  it('offers both sources in the File menu, with Puter only where its Open dialog is', () => {
    const items = fileMenu(app).find((i) => i.label === 'Import').submenu();
    expect(items.map((i) => i.label)).toEqual(['From This Device...', 'From Puter...']);
    expect(items[1].disabled).toBe(true);
    globalThis.puter = { ui: { showOpenFilePicker: async () => [] } };
    expect(fileMenu(app).find((i) => i.label === 'Import').submenu()[1].disabled).toBe(false);
  });

  it('imports the files chosen in Puter’s Open dialog', async () => {
    let options;
    globalThis.puter = {
      ui: {
        showOpenFilePicker: async (opts) => {
          options = opts;
          return [launchItem('/sam/a.md', '# Picked A'), launchItem('/sam/b.md', '# Picked B')];
        },
      },
    };
    await app.importFromCloud();
    expect(options).toMatchObject({ multiple: true });
    expect(options.accept).toContain('.md');
    expect(pageTitles()).toEqual(expect.arrayContaining(['Picked A', 'Picked B']));
  });

  it('does nothing when the dialog is cancelled', async () => {
    const before = pageTitles().length;
    globalThis.puter = { ui: { showOpenFilePicker: async () => undefined } };
    await app.importFromCloud();
    expect(pageTitles().length).toBe(before);
  });
});

describe('files dragged in from a Puter folder', () => {
  // The SDK's drop: on the element under the pointer, with the drive entries (plain records) in its detail.
  const driveDrop = (target, items) => target.dispatchEvent(new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { clientX: 10, clientY: 10, items } }));
  const drive = (files) => {
    globalThis.puter = { fs: { read: async (path) => (path in files ? new Blob([files[path]]) : Promise.reject(new Error('missing'))) } };
  };

  it('are imported when dropped outside the page', async () => {
    drive({ '/sam/dropped.md': '# Dropped' });
    driveDrop(document.querySelector('.titlebar'), [{ path: '/sam/dropped.md', name: 'dropped.md' }]);
    await tick(10);
    expect(pageTitles()).toContain('Dropped');
  });

  it('go into the page when dropped on it, as a drop from this device does', async () => {
    if (!app.editor.page) app.newPage();
    await tick();
    const page = app.editor.page;
    drive({ '/sam/report.pdf': '%PDF' });
    driveDrop(app.editor.scroller, [{ path: '/sam/report.pdf', name: 'report.pdf' }]);
    await tick(20);
    expect(app.editor.page).toBe(page);
    expect(page.outlines.map((o) => o.html).join('')).toContain('data-name="report.pdf"');
  });

  it('are left alone while a dialog is open', async () => {
    drive({ '/sam/dropped.md': '# Behind a dialog' });
    const dialog = document.createElement('dialog');
    dialog.open = true;
    document.body.append(dialog);
    driveDrop(document.querySelector('.titlebar'), [{ path: '/sam/dropped.md', name: 'dropped.md' }]);
    await tick(10);
    dialog.remove();
    expect(pageTitles()).not.toContain('Behind a dialog');
  });
});
