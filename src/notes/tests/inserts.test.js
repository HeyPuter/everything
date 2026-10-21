import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';

let app;
let store;
const RealImage = globalThis.Image;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
});

afterEach(() => {
  closeAllMenus();
  app.destroy();
  globalThis.Image = RealImage;
});

describe('inserting pictures', () => {
  it('attaches a picture the browser cannot decode instead of showing a broken image', async () => {
    // jsdom loads no images: stand in for a browser that can't decode the file.
    globalThis.Image = class {
      set src(v) {
        setTimeout(() => this.onerror?.());
      }
    };
    await app.editor.insertImage(new File(['not a picture'], 'photo.heic', { type: 'image/heic' }));
    const html = app.editor.page.outlines.map((o) => o.html).join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('class="nt-file"');
    expect(html).toContain('data-name="photo.heic"');
  });
});

describe('picture selection', () => {
  it('removes the resize handle when the selected picture is deleted', () => {
    const el = app.editor.createOutlineAt(100, 200, '<p>x<img data-asset="a1.png" alt="p"></p>');
    const img = el.querySelector('img');
    app.editor.selectImage(img);
    expect(el.querySelector('.img-handle')).toBeTruthy();
    img.remove();
    el.querySelector('.outline-body').dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.querySelector('.img-handle')).toBeNull();
    expect(app.editor.selectedImage).toBeNull();
  });
});

describe('inserting from a dialog', () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  it('inserts an equation where the page was clicked after the empty container closed', async () => {
    const ed = app.editor;
    ed.createOutlineAt(300, 400);
    app.equationDialog();
    await tick(10);
    // Focus moved into the dialog, so the empty container closed.
    expect(ed.page.outlines.length).toBe(0);
    document.getElementById('eq-input').value = 'x^2';
    document.querySelector('dialog .btn.primary').click();
    await tick(50);
    expect(ed.page.outlines.length).toBe(1);
    const o = ed.page.outlines[0];
    expect(o.html).toContain('data-tex="x^2"');
    expect([o.x, o.y]).toEqual([300, 388]);
  });

  it('inserts a link on a page with no containers', async () => {
    const ed = app.editor;
    app.linkDialog();
    await tick(10);
    document.getElementById('link-address').value = 'example.com';
    document.querySelector('dialog .btn.primary').click();
    await tick(10);
    // jsdom has no insertHTML: the link insertion itself is checked in the browser.
    expect(ed.page.outlines.length).toBe(1);
  });
});

describe('attachments', () => {
  it('opens an attachment from the keyboard', async () => {
    const el = app.editor.createOutlineAt(100, 200, '<p><span class="nt-file" data-asset="a1.txt" data-name="notes.txt" data-kind="file" contenteditable="false"></span></p>');
    const { hydrate } = await import('../src/editor/embeds.js');
    await hydrate(el.querySelector('.outline-body'), store);
    const file = el.querySelector('.nt-file');
    expect(file.getAttribute('role')).toBe('button');
    const opened = [];
    app.editor.on('open-file', (d) => opened.push(d.name));
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      file.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(opened).toEqual(['notes.txt', 'notes.txt']);
  });
});
