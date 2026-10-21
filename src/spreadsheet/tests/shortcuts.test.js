// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { openShortcuts, renderKeys } from '../src/ui/shortcuts.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const text = (nodes) => nodes.map((n) => n.textContent).join('|');

describe('keyboard shortcuts panel', () => {
  it('draws keys as caps with the joiners between them as text', () => {
    const tab = renderKeys('Tab / Shift + Tab');
    expect(tab.map((n) => n.className)).toEqual(['shortcut-chord', 'shortcut-join', 'shortcut-chord']);
    expect([...tab[2].children].map((n) => n.className)).toEqual(['kbd', 'shortcut-join', 'kbd']);
    expect(text(tab)).toBe('Tab|/|Shift+Tab');
    const or = renderKeys('F2 or double-click');
    expect(or.map((n) => n.className)).toEqual(['shortcut-chord', 'shortcut-join', 'shortcut-chord']);
    expect(text(or)).toBe('F2|or|double-click');
    // A gesture described in words is not a key cap.
    const drag = renderKeys('Drag the bar at the corner of the headers');
    expect(drag.map((n) => n.className)).toEqual(['shortcut-gesture']);
    expect(renderKeys('Arrow keys').map((n) => n.className)).toEqual(['shortcut-chord']);
    // …even when it contains a "+" or an "or" of its own.
    const mixed = renderKeys('Click, then Shift + click, while a formula wants a reference');
    expect(mixed.map((n) => n.className)).toEqual(['shortcut-gesture']);
    expect(mixed[0].textContent).toBe('Click, then Shift + click, while a formula wants a reference');
    expect(renderKeys('Arrow keys after = ( , or an operator').map((n) => n.className)).toEqual(['shortcut-gesture']);
  });

  it('lists every shortcut as a row: what it does on the left, the keys on the right', () => {
    openShortcuts();
    const panel = document.querySelector('.modal-panel.wide');
    expect(panel).toBeTruthy();
    expect(panel.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    const groups = [...panel.querySelectorAll('.shortcut-group h3')].map((h) => h.textContent);
    expect(groups).toEqual(['Navigate', 'Edit', 'Format', 'File']);
    const rows = [...panel.querySelectorAll('.shortcut-row')];
    expect(rows.length).toBeGreaterThan(60);
    for (const row of rows) {
      expect(row.children.length).toBe(2);
      expect(row.children[0].className).toBe('shortcut-what');
      expect(row.children[0].textContent.trim()).not.toBe('');
      expect(row.children[1].className).toBe('shortcut-keys');
      expect(row.children[1].children.length).toBeGreaterThan(0);
    }
    const a1 = rows.find((r) => r.querySelector('.shortcut-what').textContent === 'Go to A1');
    expect(a1.querySelectorAll('.kbd').length).toBe(2);
    expect(a1.querySelector('.shortcut-join').textContent).toBe('+');
    // The old two-column definition list is gone.
    expect(panel.querySelector('dl, dt, dd')).toBe(null);
  });

  it('lists the keyboard access to charts, images, and text boxes', () => {
    document.body.replaceChildren();
    openShortcuts();
    const rows = [...document.querySelectorAll('.modal-panel.wide .shortcut-row')];
    const row = (what) => rows.find((r) => r.querySelector('.shortcut-what').textContent.startsWith(what));
    const select = row('Select the next chart, image, or text box');
    expect(select.querySelector('.shortcut-keys').textContent).toBe('Ctrl+Alt+O');
    expect(select.querySelectorAll('.kbd')).toHaveLength(3);
    const nudge = row('Nudge the selected chart, image, or text box');
    expect(nudge.querySelector('.shortcut-keys').textContent).toBe('Arrow keys/Shift+Arrow');
    expect(nudge.querySelector('.shortcut-what').textContent).toContain('Escape deselects');
    expect(select.closest('.shortcut-group').querySelector('h3').textContent).toBe('Navigate');
  });

  it('advertises Find and replace on a chord that reaches the page: Ctrl+H, or ⌘+Shift+H on a Mac, where ⌘+H hides the app', async () => {
    const keysFor = (what) => [...document.querySelectorAll('.modal-panel.wide .shortcut-row')]
      .find((r) => r.querySelector('.shortcut-what').textContent === what).querySelector('.shortcut-keys').textContent;
    document.body.replaceChildren();
    openShortcuts();
    expect(keysFor('Find and replace')).toBe('Ctrl+H');
    document.body.replaceChildren();
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });
    try {
      const mac = await import('../src/ui/shortcuts.js');
      mac.openShortcuts();
      expect(keysFor('Find and replace')).toBe('⌘+Shift+H');
      expect(keysFor('Find')).toBe('⌘+F');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
