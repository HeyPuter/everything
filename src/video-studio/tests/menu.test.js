// Popup menus: submenu placement, focus return from submenus and point-anchored context menus.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showMenu, closeMenus, menuButton } from '../src/ui/menu.js';

const frame = () => new Promise((r) => setTimeout(r, 5));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

let restoreRect;
beforeEach(() => {
  const orig = Element.prototype.getBoundingClientRect;
  // Menu items sit in a column at x 130-374; menus measure 240x200.
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList?.contains('menu')) return { left: 0, right: 240, top: 0, bottom: 200, width: 240, height: 200, x: 0, y: 0 };
    if (this.classList?.contains('menu-item')) return { left: 130, right: 374, top: 100, bottom: 130, width: 244, height: 30, x: 130, y: 100 };
    return orig.call(this);
  };
  restoreRect = () => (Element.prototype.getBoundingClientRect = orig);
});
afterEach(() => {
  closeMenus();
  restoreRect();
  document.body.innerHTML = '';
});

function rootMenu() {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const handle = showMenu(opener, [
    { label: 'Layout', submenu: [{ label: 'Default', onSelect() {} }, { label: 'Large details panel', onSelect() {} }] },
    { label: 'Zoom in timeline', onSelect() {} },
  ]);
  const layout = [...handle.el.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Layout'));
  return { opener, handle, layout };
}

describe('submenus', () => {
  it('open beside the parent item, not on top of it', () => {
    const { layout } = rootMenu();
    layout.dispatchEvent(new Event('pointerenter'));
    const menus = document.querySelectorAll('.menu');
    expect(menus.length).toBe(2);
    expect(parseFloat(menus[1].style.left)).toBe(376);
    expect(parseFloat(menus[1].style.top)).toBe(96);
  });

  it('flip to the left of the parent item when there is no room on the right', () => {
    const { layout } = rootMenu();
    window.innerWidth = 500;
    try {
      layout.dispatchEvent(new Event('pointerenter'));
      const sub = document.querySelectorAll('.menu')[1];
      expect(sub.style.left).toBe('8px');
    } finally {
      window.innerWidth = 1024;
    }
  });

  it('ArrowLeft closes the submenu and returns focus to the item that opened it', () => {
    const { layout } = rootMenu();
    layout.focus();
    key(layout, 'ArrowRight');
    const sub = document.querySelectorAll('.menu')[1];
    expect(sub.contains(document.activeElement)).toBe(true);
    key(document.activeElement, 'ArrowLeft');
    expect(document.querySelectorAll('.menu').length).toBe(1);
    expect(document.activeElement).toBe(layout);
    expect(layout.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape in a submenu returns focus to its opener item, not the first item', () => {
    // The submenu item is second, so "first item" and "opener" differ.
    const opener = document.createElement('button');
    document.body.append(opener);
    const h2 = showMenu(opener, [{ label: 'Zoom in timeline', onSelect() {} }, { label: 'Theme', submenu: [{ label: 'Dark', onSelect() {} }] }]);
    const theme = [...h2.el.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Theme'));
    theme.focus();
    key(theme, 'ArrowRight');
    key(document.activeElement, 'Escape');
    expect(document.querySelectorAll('.menu').length).toBe(1);
    expect(document.activeElement).toBe(theme);
  });
});

describe('context menus at a point', () => {
  it('return focus to the element that was focused when they opened', async () => {
    const clip = document.createElement('div');
    clip.tabIndex = 0;
    document.body.append(clip);
    clip.focus();
    const handle = showMenu({ x: 40, y: 50 }, [{ label: 'Copy', onSelect() {} }]);
    await frame();
    expect(handle.el.contains(document.activeElement)).toBe(true);
    key(document.activeElement, 'Escape');
    expect(document.activeElement).toBe(clip);
  });

  it('do not pull focus back when it already moved elsewhere', () => {
    const clip = document.createElement('div');
    clip.tabIndex = 0;
    const other = document.createElement('input');
    document.body.append(clip, other);
    clip.focus();
    const handle = showMenu({ x: 40, y: 50 }, [{ label: 'Copy', onSelect() {} }], { focus: false });
    other.focus();
    handle.close();
    expect(document.activeElement).toBe(other);
  });

  it('still place themselves at the point', () => {
    const handle = showMenu({ x: 40, y: 50 }, [{ label: 'Copy', onSelect() {} }]);
    expect(handle.el.style.left).toBe('40px');
    expect(handle.el.style.top).toBe('54px');
  });
});

// Menus focus their first item on the next animation frame.
const settle = () => new Promise((r) => setTimeout(r, 40));

describe('menu bar menus', () => {
  it('move to the menu beside them with left and right arrows', async () => {
    const bar = document.createElement('nav');
    document.body.append(bar);
    const names = ['File', 'Edit', 'View'];
    const btns = names.map((name) => {
      const b = document.createElement('button');
      b.textContent = name;
      bar.append(b);
      const onSibling = (dir) => {
        const next = btns[(btns.indexOf(b) + dir + btns.length) % btns.length];
        next.focus();
        next.click();
      };
      menuButton(b, () => [{ label: `${name} one`, onSelect() {} }, { label: 'More', submenu: [{ label: `${name} sub`, onSelect() {} }] }], { label: name, onSibling });
      return b;
    });
    const openMenus = () => [...document.querySelectorAll('.menu')].map((m) => m.getAttribute('aria-label'));
    btns[0].focus();
    btns[0].click();
    await settle();
    expect(openMenus()).toEqual(['File']);
    key(document.activeElement, 'ArrowRight');
    await settle();
    expect(openMenus()).toEqual(['Edit']);
    expect(document.activeElement.textContent).toContain('Edit one');
    expect(btns[0].getAttribute('aria-expanded')).toBe('false');
    expect(btns[1].getAttribute('aria-expanded')).toBe('true');
    key(document.activeElement, 'ArrowLeft');
    await settle();
    expect(openMenus()).toEqual(['File']);
    key(document.activeElement, 'ArrowLeft');
    await settle();
    expect(openMenus()).toEqual(['View']);
    // On a submenu item, right opens the submenu; left inside the submenu goes back to it.
    key(document.activeElement, 'ArrowDown');
    key(document.activeElement, 'ArrowRight');
    await settle();
    expect(openMenus()).toEqual(['View', 'More']);
    // Right on a plain item inside the submenu moves on to the next menu bar menu.
    key(document.activeElement, 'ArrowRight');
    await settle();
    expect(openMenus()).toEqual(['File']);
    key(document.activeElement, 'Escape');
    expect(openMenus()).toEqual([]);
    expect(document.activeElement).toBe(btns[0]);
  });

  it('leave left and right alone in menus outside a menu bar', async () => {
    const { handle } = rootMenu();
    await settle();
    const item = handle.el.querySelectorAll('.menu-item')[1];
    item.focus();
    key(item, 'ArrowRight');
    key(item, 'ArrowLeft');
    expect(document.contains(handle.el)).toBe(true);
    expect(document.activeElement).toBe(item);
  });
});

describe('menu item shortcuts', () => {
  it('mark keyboard shortcuts apart from other hints, so touch screens can hide them', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const handle = showMenu(opener, [
      { label: 'Undo', shortcut: 'Mod+Z', onSelect() {} },
      { label: 'Timeline 2', hint: '00:12', onSelect() {} },
    ]);
    const [undo, tl] = handle.el.querySelectorAll('.menu-item');
    expect(undo.querySelector('.menu-shortcut').classList.contains('menu-key')).toBe(true);
    expect(tl.querySelector('.menu-shortcut').classList.contains('menu-key')).toBe(false);
  });
});
