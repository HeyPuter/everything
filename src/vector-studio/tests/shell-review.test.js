// Regression tests from the shell review (menus, dialogs, dock, home screen).
import { describe, it, expect, afterEach } from 'vitest';

describe('menu placement', () => {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  });
  const tallMenus = (h) =>
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('menu') ? h : 0;
      },
    });
  const anchorAt = (top, bottom) => {
    const a = document.createElement('button');
    document.body.append(a);
    a.getBoundingClientRect = () => ({ left: 100, right: 160, top, bottom, width: 60, height: bottom - top });
    return a;
  };
  const items = [{ type: 'cmd', label: 'One', enabled: true, run: () => {} }];

  it('a menu taller than the window stays below its menu bar button and scrolls', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(2000);
    const anchor = anchorAt(6, 34);
    const m = openMenu({}, items, { x: 100, y: 36, anchor });
    // Moved up to the top edge, it covered the menu bar: the row under the pointer opened its submenu.
    expect(m.el.style.top).toBe('36px');
    expect(m.el.style.maxHeight).toBe(`${window.innerHeight - 36 - 4}px`);
    m.close();
  });

  it('a menu from a button near the bottom opens above the button', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(200);
    const vh = window.innerHeight;
    const anchor = anchorAt(vh - 40, vh - 10);
    const m = openMenu({}, items, { x: 100, y: vh - 6, anchor });
    expect(parseFloat(m.el.style.top)).toBe(vh - 40 - 4 - 200);
    expect(m.el.style.maxHeight).toBe('');
    m.close();
  });

  it('a context menu at a point still moves up to fit', async () => {
    const { openMenu } = await import('../src/ui/menubar.js');
    tallMenus(300);
    const vh = window.innerHeight;
    const m = openMenu({}, items, { x: 100, y: vh - 50 });
    expect(parseFloat(m.el.style.top)).toBe(vh - 300 - 4);
    m.close();
  });
});
