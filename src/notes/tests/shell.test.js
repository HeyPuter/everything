import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';

// App shell and navigation: panes, routing, search, menus and dialogs.

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let mounted = [];

async function mount() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  const app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
  mounted.push(app);
  return { app, store };
}

function keydown(target, key, opts = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
}

describe('App shell', () => {
  let app;
  let store;
  beforeEach(async () => {
    ({ app, store } = await mount());
  });
  afterEach(() => {
    closeAllMenus();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    for (const a of mounted) a.destroy();
    mounted = [];
  });

  it('puts the label back after renaming the open page from the page list', async () => {
    const row = app.nav.pagesList.querySelector('.row[aria-selected="true"]');
    row.focus();
    keydown(row, 'F2');
    const input = app.nav.pagesList.querySelector('input.row-rename');
    expect(input).toBeTruthy();
    input.value = 'Renamed';
    keydown(input, 'Enter');
    await tick();
    expect(app.nav.pagesList.querySelector('input.row-rename')).toBeNull();
    expect(app.nav.pagesList.querySelector('.row[aria-selected="true"]').textContent).toBe('Renamed');
    expect(store.findPage(app.state.pageId).meta.title).toBe('Renamed');
  });
});
