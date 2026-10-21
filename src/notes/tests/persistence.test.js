import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';

// How the app reports saving, sharing and restoring outcomes to the user.

let mounted = [];

async function mount() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
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
