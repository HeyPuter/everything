import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { setTheme } from '../src/ui/prefs.js';

let app;

async function mount() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load();
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
  return app;
}

describe('view: printing', () => {
  afterEach(() => {
    closeAllMenus();
    app?.destroy();
    setTheme('system');
  });

  it('prints a dark page as a light page and switches back afterwards', async () => {
    setTheme('dark');
    await mount();
    const page = app.editor.pageEl;
    expect(page.classList.contains('surface-dark')).toBe(true);
    window.dispatchEvent(new Event('beforeprint'));
    expect(page.classList.contains('surface-light')).toBe(true);
    expect(page.classList.contains('surface-dark')).toBe(false);
    window.dispatchEvent(new Event('afterprint'));
    expect(page.classList.contains('surface-dark')).toBe(true);
    expect(app.editor.surface).toBe('auto');
  });

  it('keeps a page colour light when printing in dark mode', async () => {
    setTheme('dark');
    await mount();
    app.editor.page.color = 'blue';
    app.editor.applyBackground();
    expect(app.editor.pageEl.classList.contains('surface-dark')).toBe(true);
    window.dispatchEvent(new Event('beforeprint'));
    expect(app.editor.pageEl.classList.contains('surface-dark')).toBe(false);
    expect(app.editor.scroller.style.getPropertyValue('--page-bg')).toBe('#dce9f8');
    window.dispatchEvent(new Event('afterprint'));
    expect(app.editor.pageEl.classList.contains('surface-dark')).toBe(true);
  });
});
