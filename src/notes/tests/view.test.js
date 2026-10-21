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

describe('assist pane', () => {
  afterEach(() => {
    closeAllMenus();
    app?.destroy();
  });

  it('labels the insert button by what it will do', async () => {
    await mount();
    const asked = [];
    app.ai = { available: () => true, ask: async (q) => { asked.push(q); return 'Better text.'; } };
    const body = app.editor.createOutlineAt(100, 200).querySelector('.outline-body');
    body.innerHTML = '<p>Some bad text.</p>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    const range = document.createRange();
    range.selectNodeContents(body.querySelector('p'));
    app.editor.lastRange = range;
    app.runCommand('assist');
    await new Promise((r) => setTimeout(r, 20));
    const pane = document.querySelector('.task-pane');
    const button = (label) => [...pane.querySelectorAll('button')].find((b) => b.textContent.includes(label));
    // Opening the pane moves focus; the editor keeps the last note selection.
    app.editor.lastRange = range;
    button('Fix spelling').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(button('Replace Selection')).toBeTruthy();
    button('Summarize').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(button('Insert on Page')).toBeTruthy();
    expect(button('Replace Selection')).toBeFalsy();
  });

  it('replaces a triple-clicked paragraph without taking the next paragraph with it', async () => {
    await mount();
    app.ai = { available: () => true, ask: async () => 'Better text.' };
    const body = app.editor.createOutlineAt(100, 200).querySelector('.outline-body');
    body.innerHTML = '<p>Some bad text.</p><p>Next paragraph.</p>';
    const [first, second] = body.querySelectorAll('p');
    app.runCommand('assist');
    await new Promise((r) => setTimeout(r, 20));
    // What a triple click selects: up to the start of the next paragraph.
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(second, 0);
    app.editor.lastRange = range;
    const pane = document.querySelector('.task-pane');
    const button = (label) => [...pane.querySelectorAll('button')].find((b) => b.textContent.includes(label));
    button('Fix spelling').click();
    await new Promise((r) => setTimeout(r, 0));
    button('Replace Selection').click();
    const replaced = app.editor.lastRange;
    expect(replaced.toString()).toBe('Some bad text.');
    expect(second.contains(replaced.endContainer)).toBe(false);
  });
});
