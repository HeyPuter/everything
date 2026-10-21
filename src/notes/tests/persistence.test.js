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
    backend.failNext = 1;
    await app.editor.insertFiles([new File(['x'], 'photo.png', { type: 'image/png' })]);
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
