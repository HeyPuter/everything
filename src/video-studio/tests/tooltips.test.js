// Tooltips (data-tip): shown on hover anywhere in the app, including inside modal dialogs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installTooltips, openDialog } from '../src/ui/dialog.js';
import { h } from '../src/lib/dom.js';

const hover = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  vi.useRealTimers();
});

describe('tooltips', () => {
  it('show for buttons inside a modal dialog, in the dialog so they sit above it', () => {
    const page = h('div');
    document.body.append(page);
    installTooltips(page);
    const btn = h('button', { type: 'button', 'data-tip': 'Match case' }, 'Aa');
    const d = openDialog({ title: 'Find and replace', body: btn });
    hover(btn);
    vi.advanceTimersByTime(500);
    const tips = document.querySelectorAll('.tooltip');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toBe('Match case');
    expect(d.el.contains(tips[0])).toBe(true);
    d.close();
  });

  it('install once however many screens ask for them', () => {
    const a = h('div');
    document.body.append(a);
    installTooltips(a);
    installTooltips(a);
    installTooltips(document.body);
    const btn = h('button', { type: 'button', 'data-tip': 'Play' });
    a.append(btn);
    hover(btn);
    vi.advanceTimersByTime(500);
    expect(document.querySelectorAll('.tooltip').length).toBe(1);
    expect(document.querySelector('.tooltip').parentNode).toBe(document.body);
  });
});

describe('tooltip shortcuts', () => {
  it('show the key bound to a command when the tooltip opens, not when the button was made', async () => {
    vi.useRealTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Library } = await import('../src/storage/library.js');
    const { memoryBackend } = await import('../src/storage/backends.js');
    const { Editor } = await import('../src/ui/editor.js');
    const { shortcutLabel } = await import('../src/lib/platform.js');
    const { fixture, clip, onMain } = await import('./helpers.js');
    const root = h('div');
    document.body.append(root);
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    const editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    const { commands } = editor.ctx;
    vi.useFakeTimers();
    const tipFor = (el) => {
      hover(el);
      vi.advanceTimersByTime(500);
      const text = document.querySelector('.tooltip .tooltip-key')?.textContent;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return text;
    };
    try {
      const exportBtn = root.querySelector('.export-btn');
      expect(tipFor(exportBtn)).toBe(shortcutLabel(commands.keyFor('export')));
      const split = root.querySelector('.tl-toolbar [aria-label="Split"]');
      commands.setLayout('track');
      expect(commands.keyFor('split')).not.toBe('Mod+B');
      expect(tipFor(split)).toBe(shortcutLabel(commands.keyFor('split')));
      commands.setKeys('assistant', ['Mod+Shift+J']);
      expect(tipFor(root.querySelector('.ai-btn'))).toBe(shortcutLabel('Mod+Shift+J'));
    } finally {
      commands.setLayout('default', { keepCustom: false });
      editor.dispose();
    }
  });
});

describe('top bar tooltips', () => {
  it('show the full project name and save status when they are cut off', async () => {
    vi.useRealTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Library } = await import('../src/storage/library.js');
    const { memoryBackend } = await import('../src/storage/backends.js');
    const { Editor } = await import('../src/ui/editor.js');
    const { fixture, clip, onMain } = await import('./helpers.js');
    const root = h('div');
    document.body.append(root);
    const p = fixture();
    p.name = 'Summer trip highlights, final cut';
    onMain(p, clip('video', 0, 4));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    const editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    vi.useFakeTimers();
    const tipFor = (el) => {
      hover(el);
      vi.advanceTimersByTime(500);
      const text = document.querySelector('.tooltip')?.firstChild?.textContent;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return text;
    };
    let cut = false;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => (cut ? 200 : 100));
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 100);
    try {
      const name = root.querySelector('.project-name');
      const status = root.querySelector('.save-status');
      expect(tipFor(name)).toBe('Rename project');
      expect(tipFor(status)).toBeUndefined();
      cut = true;
      expect(tipFor(name)).toBe('Summer trip highlights, final cut');
      expect(tipFor(status)).toMatch(/^Auto saved: \d/);
    } finally {
      vi.restoreAllMocks();
      editor.dispose();
    }
  });

  it('shorten the save status only when the full text does not fit, and keep the full text in its tooltip', async () => {
    vi.useRealTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Library } = await import('../src/storage/library.js');
    const { memoryBackend } = await import('../src/storage/backends.js');
    const { Editor } = await import('../src/ui/editor.js');
    const { fixture, clip, onMain } = await import('./helpers.js');
    const root = h('div');
    document.body.append(root);
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const lib = new Library(memoryBackend());
    await lib.saveProject(p);
    const editor = new Editor(root, { library: lib, project: p, account: { user: { username: 'sam' } }, onExit() {}, onNewProject() {} });
    vi.useFakeTimers();
    const status = root.querySelector('.save-status');
    // The full text needs 200px; the short form 110px.
    let room = 300;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function w() {
      return this === status ? room : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function w() {
      return this === status ? (status.classList.contains('compact') ? 110 : 200) : 0;
    });
    const saved = () => editor.saver.emit('status', { status: 'saved', at: Date.now() });
    const tip = () => {
      hover(status);
      vi.advanceTimersByTime(500);
      const text = document.querySelector('.tooltip')?.firstChild?.textContent;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return text;
    };
    try {
      saved();
      expect(status.classList.contains('compact')).toBe(false);
      expect(tip()).toBeUndefined();
      room = 150;
      saved();
      expect(status.classList.contains('compact')).toBe(true);
      expect(tip()).toMatch(/^Auto saved: \d/);
      room = 250;
      saved();
      expect(status.classList.contains('compact')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      editor.dispose();
    }
  });
});
