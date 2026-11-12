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

describe('menus on touch screens', () => {
  const enter = (el, pointerType) => {
    const e = new Event('pointerenter');
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    el.dispatchEvent(e);
  };
  const open = () =>
    [...document.querySelectorAll('[role=menu]')].map((m) => m.getAttribute('aria-label'));

  it('opens a submenu when it is tapped, not on the enter that comes before the tap', async () => {
    const { openMenu, resolveItems } = await import('../src/ui/menubar.js');
    document.body.replaceChildren();
    const menu = openMenu(app, resolveItems(app, [{ label: 'File', submenu: ['file.open'] }]), {
      x: 0,
      y: 0,
      label: 'Application menu',
    });
    const row = menu.el.querySelector('.menu-item');
    // A finger enters the row just before pressing: a submenu opened then would sit under the tap.
    enter(row, 'touch');
    expect(open()).toEqual(['Application menu']);
    row.click();
    expect(open()).toEqual(['Application menu', 'File']);
    menu.close();
    // A mouse still opens it on hover.
    const again = openMenu(app, resolveItems(app, [{ label: 'File', submenu: ['file.open'] }]), {
      x: 0,
      y: 0,
      label: 'Application menu',
    });
    enter(again.el.querySelector('.menu-item'), 'mouse');
    expect(open()).toEqual(['Application menu', 'File']);
    again.close();
  });

  it('switches menus in the menu bar on tap', () => {
    const bar = createMenubar(
      app,
      ['File', 'Edit'].map((label) => ({ label, submenu: [`${label}.one`] })),
    );
    document.body.replaceChildren(bar);
    const [file, edit] = bar.querySelectorAll('.menubar-item');
    file.click();
    expect(open()).toEqual(['File']);
    // Tapping Edit: the enter must not open Edit, or the click that follows closes it again.
    enter(edit, 'touch');
    edit.click();
    expect(open()).toEqual(['Edit']);
    edit.click();
    expect(open()).toEqual([]);
  });
});
