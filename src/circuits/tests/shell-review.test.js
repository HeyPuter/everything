// Shell review regressions: menus, dialogs, panels, storage and saving.
import { describe, it, expect, afterEach } from 'vitest';
import { openMenu, closeMenus, createMenubar } from '../src/ui/menu.js';

afterEach(() => {
  closeMenus();
  document.body.innerHTML = '';
});

const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('menu focus', () => {
  it('returns focus to where it was when a chord menu is closed with Escape', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&Place', items: [{ label: '&Wire', run: () => {} }] }]);
    canvas.focus();
    expect(bar.openByAccel('p')).toBe(true);
    expect(document.activeElement.classList.contains('menu-item')).toBe(true);
    key(document.activeElement, 'Escape');
    expect(document.querySelector('.menu')).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('restores focus before running the chosen item', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    let focusedDuringRun = null;
    openMenu(
      [
        {
          label: '&Go',
          run: () => {
            focusedDuringRun = document.activeElement;
          },
        },
      ],
      { x: 0, y: 0 },
    );
    key(document.activeElement, 'Enter');
    expect(focusedDuringRun).toBe(canvas);
    expect(document.activeElement).toBe(canvas);
  });

  it('keeps the menubar button focused when the menu was opened from it', () => {
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&File', items: [{ label: '&New', run: () => {} }] }]);
    const btn = bar.el.querySelector('button');
    btn.focus();
    key(btn, 'Enter');
    key(document.activeElement, 'Escape');
    expect(document.activeElement).toBe(btn);
  });
});
