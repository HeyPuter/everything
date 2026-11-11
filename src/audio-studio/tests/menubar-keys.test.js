// Menu bar keyboard navigation (WAI-ARIA menubar pattern).
import { describe, it, expect } from 'vitest';
import { createMenubar } from '../src/ui/menubar.js';

const app = {
  commands: {
    get: () => ({}),
    label: (id) => id,
    shortcutLabel: () => '',
    isEnabled: () => true,
    isChecked: () => false,
    run: () => {},
  },
};

describe('menu bar', () => {
  it('keeps the roving tabindex on the menu that arrow keys opened', () => {
    const menus = ['File', 'Edit', 'View'].map((label) => ({
      label,
      submenu: [`${label}.one`, `${label}.two`],
    }));
    const bar = createMenubar(app, menus);
    document.body.replaceChildren(bar);
    const buttons = [...bar.querySelectorAll('.menubar-item')];
    const key = (k) =>
      document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
    buttons[0].focus();
    key('ArrowDown');
    expect(document.activeElement.closest('[role=menu]').getAttribute('aria-label')).toBe('File');
    // Right from an item opens the next menu; Escape returns to its button.
    key('ArrowRight');
    key('ArrowRight');
    expect(document.activeElement.closest('[role=menu]').getAttribute('aria-label')).toBe('View');
    key('Escape');
    expect(document.activeElement).toBe(buttons[2]);
    // Only that button is in the tab order, so Tab leaves the menu bar from here.
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
  });
});
