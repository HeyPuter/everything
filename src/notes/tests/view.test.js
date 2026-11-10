import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { setTheme } from '../src/ui/prefs.js';
import { mailtoForPage } from '../src/ui/features.js';

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

  it('shows the answer to the newest request when an older one arrives late', async () => {
    await mount();
    const waiting = [];
    app.ai = { available: () => true, ask: () => new Promise((resolve) => waiting.push(resolve)) };
    const body = app.editor.createOutlineAt(100, 200).querySelector('.outline-body');
    body.innerHTML = '<p>Some text to work on.</p>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    app.runCommand('assist');
    await new Promise((r) => setTimeout(r, 20));
    const pane = document.querySelector('.task-pane');
    const button = (label) => [...pane.querySelectorAll('button')].find((b) => b.textContent.includes(label));
    button('Summarize').click();
    button('action items').click();
    waiting[1]('ACTION ITEMS');
    await new Promise((r) => setTimeout(r, 0));
    waiting[0]('SUMMARY');
    await new Promise((r) => setTimeout(r, 0));
    expect(pane.textContent).toContain('ACTION ITEMS');
    expect(pane.textContent).not.toContain('SUMMARY');
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

describe('export', () => {
  afterEach(() => {
    closeAllMenus();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    app?.destroy();
  });

  it('asks for the password before exporting a locked section instead of saving an empty file', async () => {
    await mount();
    const sid = app.state.sectionId;
    await app.store.protectSection(sid, 'correct horse');
    await app.store.lockSection(sid);
    const saved = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      saved.push(blob);
      return 'blob:test';
    };
    try {
      const done = app.exportSection();
      await new Promise((r) => setTimeout(r, 0));
      const dialog = document.querySelector('dialog[open]');
      expect(dialog?.textContent).toContain('password protected');
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
      await done;
      expect(saved).toEqual([]);
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('names exported files without doubled spaces where unsafe characters were', async () => {
    await mount();
    app.editor.page.title = 'Plan <draft> & "final"  v2';
    const names = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function captureDownload() {
      names.push(this.download);
    };
    try {
      await app.exportPage('txt');
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    expect(names).toEqual(['Plan draft & final v2.txt']);
  });

  it('exports Markdown with one blank line between the title and each container', async () => {
    await mount();
    const page = app.editor.page;
    page.title = 'Trip';
    page.outlines = [
      { id: 'a', x: 40, y: 100, w: 300, html: '<p>Pack</p>' },
      { id: 'b', x: 40, y: 300, w: 300, html: '<p></p>' },
      { id: 'c', x: 40, y: 500, w: 300, html: '<p>Go</p>' },
    ];
    let blob = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => {
      blob = b;
      return 'blob:test';
    };
    try {
      await app.exportPage('md');
    } finally {
      URL.createObjectURL = orig;
    }
    expect(await blob.text()).toBe('# Trip\n\nPack\n\nGo\n');
  });
});

describe('theme', () => {
  afterEach(() => setTheme('system'));

  it('tints the browser toolbar with the app theme, not only the system one', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1c1c1c" media="(prefers-color-scheme: dark)">';
    setTheme('dark');
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content)).toEqual(['#1c1c1c', '#1c1c1c']);
    setTheme('light');
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content)).toEqual(['#f5f5f5', '#f5f5f5']);
  });
});

describe('email page', () => {
  const page = (text) => ({ title: 'Trip', outlines: [{ id: 'a', x: 0, y: 0, w: 300, html: `<p>${text}</p>` }] });

  it('keeps a short page whole', () => {
    const { url, truncated } = mailtoForPage(page('Pack the tent'));
    expect(truncated).toBe(false);
    expect(decodeURIComponent(url.split('&body=')[1])).toBe('Pack the tent');
  });

  it('cuts a long page to a safe link length and says so', () => {
    const { url, truncated } = mailtoForPage(page('Zelt einpacken und Wasser kaufen. 🏕️ '.repeat(200)));
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(2000);
    const body = decodeURIComponent(url.split('&body=')[1]);
    expect(body.endsWith('\u2026')).toBe(true);
    expect(body.startsWith('Zelt einpacken')).toBe(true);
  });
});

describe('link addresses', () => {
  it('completes what was typed into a usable link', async () => {
    const { completeAddress } = await import('../src/ui/features.js');
    expect(completeAddress('example.com/a')).toBe('https://example.com/a');
    expect(completeAddress('sam@example.com')).toBe('mailto:sam@example.com');
    expect(completeAddress('localhost:3000')).toBe('https://localhost:3000');
    expect(completeAddress('example.com:8080/docs')).toBe('https://example.com:8080/docs');
    for (const as of ['#page=p1', 'http://a.b', 'mailto:a@b.c', 'tel:5551234', 'javascript:alert(1)']) expect(completeAddress(as)).toBe(as);
  });
});

describe('page width', () => {
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', width);
    app?.destroy();
  });

  it('does not make an empty page wider than a phone screen', async () => {
    await mount();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    app.editor.layout();
    expect(parseFloat(app.editor.pageEl.style.width)).toBeLessThan(390);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    app.editor.layout();
    expect(app.editor.pageEl.style.width).toBe('960px');
  });

  it('wraps an automatic-width note at the edge of a phone screen', async () => {
    await mount();
    const editor = app.editor;
    const el = editor.createOutlineAt(150, 300);
    Object.defineProperty(editor.scroller, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(el, 'offsetLeft', { configurable: true, value: 150 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    editor.layout();
    expect(el.style.maxWidth).toBe('224px');
    // The note itself keeps its automatic width.
    expect(editor.outlineModel(el).w).toBe(null);
    // Too far right to leave a readable column: left at its full measure.
    Object.defineProperty(el, 'offsetLeft', { configurable: true, value: 300 });
    editor.layout();
    expect(el.style.maxWidth).toBe('');
    // Wider screens show it at full measure again.
    Object.defineProperty(el, 'offsetLeft', { configurable: true, value: 150 });
    editor.layout();
    expect(el.style.maxWidth).toBe('224px');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    editor.layout();
    expect(el.style.maxWidth).toBe('');
  });
});
