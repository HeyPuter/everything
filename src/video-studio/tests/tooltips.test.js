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
