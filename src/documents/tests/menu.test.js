// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openMenu, closeMenu, isMenuOpen, ariaKeyshortcuts } from '../src/ui/menu.js';
import { openColorMenu, TEXT_COLORS } from '../src/ui/colors.js';

const anchorAt = (left, width = 60) => {
  const a = document.createElement('button');
  a.getBoundingClientRect = () => ({ left, right: left + width, width, top: 10, bottom: 40, height: 30 });
  document.body.append(a);
  return a;
};

afterEach(() => { closeMenu(); document.body.innerHTML = ''; });

describe('menu item roles', () => {
  it('names a toggle a checkbox item and one choice of an exclusive group a radio item', () => {
    openMenu({ anchor: anchorAt(100), items: [
      { label: 'Show ruler', checked: true, onSelect() {} },
      { label: 'Inches', radio: true, checked: true, onSelect() {} },
      { label: 'Centimeters', radio: true, checked: false, onSelect() {} },
      { label: 'Rename', onSelect() {} },
    ] });
    const items = [...document.querySelectorAll('.menu-item')];
    expect(items.map((item) => item.getAttribute('role'))).toEqual(['menuitemcheckbox', 'menuitemradio', 'menuitemradio', 'menuitem']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', null]);
  });
});

describe('menu notes, groups and shortcuts', () => {
  it('reads a note as prose, names the items under a header as a group, and spells shortcuts for assistive technology', () => {
    openMenu({ anchor: anchorAt(100), items: [
      { header: 'Measurement units' },
      { label: 'Inches', radio: true, checked: true, onSelect() {} },
      { label: 'Centimeters', radio: true, checked: false, onSelect() {} },
      { separator: true },
      { note: 'Used by the ruler, page setup, indentation, and tables' },
      { label: 'Save', shortcut: 'Cmd+S', onSelect() {} },
      { label: 'Move up', shortcut: 'Ctrl+Shift+Up', onSelect() {} },
    ] });
    const menu = document.querySelector('.menu');
    const header = menu.querySelector('.menu-header');
    const group = menu.querySelector('[role="group"]');
    expect(group.getAttribute('aria-labelledby')).toBe(header.id);
    expect([...group.querySelectorAll('[role="menuitemradio"]')].map((b) => b.textContent.trim())).toEqual(['Inches', 'Centimeters']);
    // Items after a separator stand outside the group. The note is prose about the menu: a menu may hold only
    // items, groups and separators, so it describes the menu rather than standing among its items.
    const note = menu.querySelector('.menu-note');
    expect(note.closest('[role="group"]')).toBeNull();
    expect(note.textContent).toBe('Used by the ruler, page setup, indentation, and tables');
    expect(note.matches('[disabled], .menu-item, [role="note"]')).toBe(false);
    expect(note.getAttribute('role')).toBe('none');
    expect(menu.getAttribute('aria-describedby')).toBe(note.id);
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.map((b) => b.getAttribute('aria-keyshortcuts'))).toEqual(['Meta+S', 'Control+Shift+ArrowUp']);
    // Arrow keys still walk every item, in the group and out of it.
    items[0].focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(document.activeElement.textContent.trim()).toBe('Centimeters');
  });

  it('spells the comma key and the Option key as aria-keyshortcuts names them', () => {
    expect(ariaKeyshortcuts('Cmd+,')).toBe('Meta+,');
    expect(ariaKeyshortcuts('Cmd+Option+M')).toBe('Meta+Alt+M');
    expect(ariaKeyshortcuts('Option+Cmd+Shift+V')).toBe('Alt+Meta+Shift+V');
    // Alternatives still split on a comma or "or" between chords.
    expect(ariaKeyshortcuts('F4, Cmd+Y')).toBe('F4 Meta+Y');
    expect(ariaKeyshortcuts('Ctrl+, or Ctrl+Shift+,')).toBe('Control+, Control+Shift+,');
    openMenu({ anchor: anchorAt(100), items: [{ label: 'Preferences…', shortcut: 'Cmd+,', onSelect() {} }] });
    expect(document.querySelector('.menu-item').getAttribute('aria-keyshortcuts')).toBe('Meta+,');
  });
});

describe('openMenu alignment', () => {
  it('lines the menu up with the anchor edge nearest the middle of the window when asked to choose', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    const items = [{ label: 'One', onSelect() {} }];
    let { menu } = openMenu({ anchor: anchorAt(100), items, align: 'auto' });
    expect(menu.style.left).toBe('100px');
    closeMenu();
    ({ menu } = openMenu({ anchor: anchorAt(900), items, align: 'auto' }));
    expect(menu.style.left).toBe('960px');
    closeMenu();
    ({ menu } = openMenu({ anchor: anchorAt(900), items }));
    expect(menu.style.left).toBe('900px');
  });

  it('keeps a tall menu below its anchor and lets it scroll rather than covering the anchor', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true, writable: true });
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('menu')) return { left: 0, right: 200, width: 200, top: 0, bottom: 500, height: 500 };
      return proto.call(this);
    };
    try {
      const items = Array.from({ length: 15 }, (_, i) => ({ label: `Item ${i}`, onSelect() {} }));
      const a = anchorAt(100); // sits from 10 to 40
      const { menu } = openMenu({ anchor: a, items });
      expect(menu.style.top).toBe('44px');
      expect(menu.style.maxHeight).toBe(`${300 - 8 - 44}px`);
      expect(menu.style.overflowY).toBe('auto');
      closeMenu();
      // With more room above than below, it opens upward, capped the same way.
      const low = anchorAt(100);
      low.getBoundingClientRect = () => ({ left: 100, right: 160, width: 60, top: 250, bottom: 280, height: 30 });
      const up = openMenu({ anchor: low, items }).menu;
      expect(up.style.maxHeight).toBe(`${250 - 4 - 8}px`);
      expect(up.style.top).toBe('8px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
  });

  it('flips a menu opened at the pointer above or to the left of the point instead of covering it', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true, writable: true });
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('menu')) return { left: 0, right: 200, width: 200, top: 0, bottom: 150, height: 150 };
      return proto.call(this);
    };
    try {
      const items = [{ label: 'One', onSelect() {} }];
      // Near the bottom right corner: the menu opens up and to the left of the point.
      let { menu } = openMenu({ anchor: null, x: 900, y: 250, items });
      expect(menu.style.top).toBe('100px');
      expect(menu.style.left).toBe('700px');
      closeMenu();
      // With room below and to the right, it opens from the point.
      ({ menu } = openMenu({ anchor: null, x: 100, y: 50, items }));
      expect(menu.style.top).toBe('50px');
      expect(menu.style.left).toBe('100px');
      closeMenu();
      // No room on either side: it is capped and kept inside the window.
      Object.defineProperty(window, 'innerHeight', { value: 160, configurable: true, writable: true });
      ({ menu } = openMenu({ anchor: null, x: 100, y: 100, items }));
      expect(menu.style.top).toBe('8px');
      expect(menu.style.maxHeight).toBe('144px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true, writable: true });
    }
  });

  it('opens at most one menu and reports it', () => {
    const items = [{ label: 'One', onSelect() {} }];
    openMenu({ anchor: anchorAt(10), items, label: 'A' });
    openMenu({ anchor: anchorAt(20), items, label: 'B' });
    expect(document.querySelectorAll('.menu').length).toBe(1);
    expect(document.querySelector('.menu').getAttribute('aria-label')).toBe('B');
    expect(isMenuOpen()).toBe(true);
  });
});

describe('openMenu and the window', () => {
  const resize = (width, height) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
  };
  it('stays open while a field in it has focus and only the height changes, as when a phone keyboard rises', () => {
    resize(400, 800);
    const input = document.createElement('input');
    openMenu({ anchor: anchorAt(100), items: [{ label: 'One', onSelect() {} }, { custom: input }] });
    input.focus();
    expect(document.activeElement).toBe(input);
    resize(400, 420);
    expect(isMenuOpen()).toBe(true);
    // A change of width is a real resize: the menu no longer fits where it was placed.
    resize(700, 420);
    expect(isMenuOpen()).toBe(false);
  });
  it('closes on a resize when nothing in it is being typed into', () => {
    resize(400, 800);
    openMenu({ anchor: anchorAt(100), items: [{ label: 'One', onSelect() {} }] });
    expect(isMenuOpen()).toBe(true);
    resize(400, 420);
    expect(isMenuOpen()).toBe(false);
  });
});

const press = (key) => { const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return e; };

describe('a menu and scrolling', () => {
  const items = [{ label: 'One', onSelect() {} }, { label: 'Two', onSelect() {} }];
  it('closes when the page under it scrolls, and stays while its own list or a field in it does', () => {
    vi.useFakeTimers();
    try {
      const list = document.createElement('div'); document.body.append(list);
      const anchor = document.createElement('button'); list.append(anchor);
      const { menu } = openMenu({ anchor, items });
      // A scroll that is part of the menu opening (a focused item pulled into view) is not a scroll away.
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(isMenuOpen()).toBe(true);
      vi.advanceTimersByTime(200);
      menu.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(isMenuOpen()).toBe(true);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(isMenuOpen()).toBe(false);
      // With a field of the menu focused (a phone's keyboard scrolling it into view), the menu stays.
      const input = document.createElement('input');
      openMenu({ anchor, items: [{ custom: input }, ...items] });
      vi.advanceTimersByTime(200);
      input.focus();
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(isMenuOpen()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('a palette opened from a menu item', () => {
  function openPalette({ byKeyboard = true } = {}) {
    const anchor = document.createElement('button'); document.body.append(anchor); anchor.focus();
    openMenu({ anchor, label: 'Underline style', items: [
      { label: 'Single', onSelect() {} },
      { label: 'Underline color', submenu: (item, options) => openColorMenu({ anchor: item, colors: TEXT_COLORS, label: 'Underline color', onPick() {}, ...options }) },
    ] });
    const item = [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Underline color'));
    item.focus();
    if (byKeyboard) press('ArrowRight');
    return { item };
  }

  it('stays open, with the menu it came from, while the native color picker holds the window focus', () => {
    openPalette();
    expect(document.querySelectorAll('.menu')).toHaveLength(2);
    document.querySelector('input[type="color"]').focus();
    window.dispatchEvent(new Event('blur'));
    expect(document.querySelectorAll('.menu')).toHaveLength(2);
  });

  it('moves within the swatch grid on Left instead of closing the palette', () => {
    openPalette();
    const swatches = document.querySelectorAll('button.swatch');
    swatches[1].focus();
    press('ArrowLeft');
    expect(document.activeElement).toBe(swatches[0]);
    expect(document.querySelectorAll('.menu')).toHaveLength(2);
    press('ArrowLeft');
    expect(document.activeElement).toBe(swatches[swatches.length - 1]);
  });

  it('walks back up from the custom color fields with the arrow keys', () => {
    openPalette();
    const color = document.querySelector('input[type="color"]');
    const hex = document.querySelector('input.color-hex');
    color.focus();
    press('ArrowUp');
    expect(document.activeElement.textContent).toContain('Automatic');
    press('ArrowDown');
    expect(document.activeElement).toBe(color);
    press('ArrowDown');
    expect(document.activeElement).toBe(hex);
    press('ArrowUp');
    expect(document.activeElement).toBe(color);
    // Typing and the caret keys stay with the field.
    hex.focus();
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(hex);
  });

  it('shows the palette under the mouse without taking the keyboard focus from its item', () => {
    vi.useFakeTimers();
    try {
      const { item } = openPalette({ byKeyboard: false });
      item.dispatchEvent(new Event('pointerenter'));
      vi.advanceTimersByTime(100);
      expect(document.querySelectorAll('.menu')).toHaveLength(2);
      expect(document.activeElement).toBe(item);
      // Opened with the keyboard, the palette takes the focus as any submenu does.
      press('ArrowRight');
      expect(document.activeElement).toBe(document.querySelector('button.swatch'));
    } finally { vi.useRealTimers(); }
  });
});

describe('submenus and the keyboard', () => {
  it('closes a submenu the mouse opened when the keyboard moves on to another item', () => {
    vi.useFakeTimers();
    try {
      const items = [{ label: 'Alpha', items: [{ label: 'Alpha child', onSelect() {} }] }, { label: 'Beta', onSelect() {} }];
      const { menu } = openMenu({ anchor: anchorAt(100), items, label: 'Format' });
      const [alpha] = menu.querySelectorAll('.menu-item');
      alpha.dispatchEvent(new Event('pointerenter'));
      vi.advanceTimersByTime(500);
      expect(document.querySelectorAll('.menu')).toHaveLength(2);
      expect(document.activeElement).toBe(alpha);
      // Down leaves Alpha for Beta: Alpha's submenu has nothing to hang beside any more.
      press('ArrowDown');
      expect(document.activeElement.textContent).toContain('Beta');
      expect(document.querySelectorAll('.menu')).toHaveLength(1);
      expect(alpha.getAttribute('aria-expanded')).not.toBe('true');
    } finally { vi.useRealTimers(); }
  });
});

describe('late openers', () => {
  it('opens nothing for an anchor that is no longer in the page', () => {
    const anchor = anchorAt(100);
    anchor.remove();
    const { menu } = openMenu({ anchor, items: [{ label: 'Late', onSelect() {} }] });
    expect(menu).toBeNull();
    expect(isMenuOpen()).toBe(false);
  });

  it('does not replace a sibling item\'s submenu when a slower opener resolves after the pointer moved on', () => {
    const items = [
      { label: 'Slow', items: [{ label: 'Slow child', onSelect() {} }] },
      { label: 'Quick', items: [{ label: 'Quick child', onSelect() {} }] },
    ];
    const { menu } = openMenu({ anchor: anchorAt(100), items, label: 'Format' });
    const [slow, quick] = menu.querySelectorAll('.menu-item');
    // The pointer settled on Quick, whose submenu is showing.
    quick.focus();
    openMenu({ anchor: quick, items: items[1].items, label: 'Quick' });
    expect([...document.querySelectorAll('.menu')].map((m) => m.getAttribute('aria-label'))).toEqual(['Format', 'Quick']);
    // Slow's document read finishes now.
    const late = openMenu({ anchor: slow, items: items[0].items, label: 'Slow' });
    expect(late.menu).toBeNull();
    expect([...document.querySelectorAll('.menu')].map((m) => m.getAttribute('aria-label'))).toEqual(['Format', 'Quick']);
    expect(document.activeElement.closest('.menu').getAttribute('aria-label')).toBe('Quick');
  });
});

describe('menus in a home-screen app', () => {
  it('keeps a menu pushed to an edge clear of the status bar and the notch', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true, writable: true });
    const root = document.documentElement.style;
    root.setProperty('--safe-t', '50px'); root.setProperty('--safe-l', '40px'); root.setProperty('--safe-b', '20px');
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('menu')) return { left: 0, right: 200, width: 200, top: 0, bottom: 500, height: 500 };
      return proto.call(this);
    };
    try {
      const items = Array.from({ length: 15 }, (_, i) => ({ label: `Item ${i}`, onSelect() {} }));
      // Opening upward from a low anchor: the menu starts below the status bar and is capped to the room under it.
      const low = anchorAt(0);
      low.getBoundingClientRect = () => ({ left: 0, right: 60, width: 60, top: 250, bottom: 280, height: 30 });
      const { menu } = openMenu({ anchor: low, items });
      expect(menu.style.top).toBe('58px');
      expect(menu.style.maxHeight).toBe(`${250 - 4 - 58}px`);
      // Pushed against the left edge: clear of the notch.
      expect(menu.style.left).toBe('48px');
      closeMenu();
      // Below an anchor just under the status bar, the cap leaves the home indicator's strip free.
      const high = anchorAt(100);
      high.getBoundingClientRect = () => ({ left: 100, right: 160, width: 60, top: 60, bottom: 90, height: 30 });
      const down = openMenu({ anchor: high, items }).menu;
      expect(down.style.top).toBe('94px');
      expect(down.style.maxHeight).toBe(`${300 - 28 - 94}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
      root.removeProperty('--safe-t'); root.removeProperty('--safe-l'); root.removeProperty('--safe-b');
    }
  });
});
