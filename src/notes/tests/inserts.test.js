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
