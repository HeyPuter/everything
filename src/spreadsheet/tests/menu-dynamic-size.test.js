// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeMenu, isMenuOpen, openMenu } from '../src/ui/menu.js';

let observers;
beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
    observe(node) { this.node = node; }
    deliver() { this.callback([{ target: this.node }]); }
  });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
  vi.stubGlobal('innerHeight', 600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return this.matches('.menu') ? Number(this.dataset.width || 200) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.matches('.menu') ? Math.min(Number(this.dataset.height || 100), parseFloat(this.style.maxHeight) || Infinity) : 0;
  });
});
afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps controls visible as anchored custom content grows and shrinks without changing focus', () => {
  const input = document.createElement('input');
  const anchor = { getBoundingClientRect: () => ({ left: 80, right: 160, top: 300, bottom: 330 }) };
  const { menu } = openMenu({ anchor, items: [{ custom: input }] });
  input.focus();
  expect(menu.style.top).toBe('334px');
  menu.dataset.height = '400';
  observers[0].deliver();
  // Too tall for either side of its anchor, it opens on the roomier side (above: 288px against 258px
  // below) and scrolls there, rather than being pushed up over the anchor itself.
  expect(menu.style.top).toBe('8px');
  expect(menu.style.maxHeight).toBe('288px');
  expect(menu.style.overflowY).toBe('auto');
  expect(document.activeElement).toBe(input);
  expect(isMenuOpen()).toBe(true);
  menu.dataset.height = '160';
  observers[0].deliver();
  expect(menu.style.top).toBe('334px');
});

it('caps oversized content and releases the cap when it shrinks', () => {
  const { menu } = openMenu({ x: 420, y: 450, items: [{ label: 'Choice' }] });
  menu.dataset.height = '900';
  observers[0].deliver();
  expect(menu.style.top).toBe('8px');
  expect(menu.style.maxHeight).toBe('584px');
  expect(menu.style.overflowY).toBe('auto');
  // A repeated notification must reach the same layout, without moving focus.
  observers[0].deliver();
  expect(menu.style.top).toBe('8px');
  expect(menu.style.maxHeight).toBe('584px');
  menu.dispatchEvent(new Event('scroll'));
  expect(isMenuOpen()).toBe(true);
  menu.dataset.height = '70';
  observers[0].deliver();
  expect(menu.style.top).toBe('450px');
  expect(menu.style.maxHeight).toBe('');
  expect(menu.style.overflowY).toBe('');
});

it('repositions growing width at the viewport edge', () => {
  const { menu } = openMenu({ x: 550, y: 40, items: [{ label: 'Choice' }] });
  expect(menu.style.left).toBe('550px');
  menu.dataset.width = '400';
  observers[0].deliver();
  expect(menu.style.left).toBe('392px');
});

it('observes submenu growth and disconnects every observer on dismissal', () => {
  const { menu } = openMenu({ x: 30, y: 40, items: [{ label: 'More', submenu: [{ label: 'Child' }] }] });
  menu.querySelector('button').click();
  const child = document.querySelector('.submenu');
  child.dataset.height = '800';
  observers[1].deliver();
  expect(child.style.top).toBe('8px');
  expect(child.style.maxHeight).toBe('584px');
  expect(isMenuOpen()).toBe(true);
  closeMenu();
  expect(observers).toHaveLength(2);
  for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledOnce();
  const top = child.style.top;
  observers[1].deliver();
  expect(child.style.top).toBe(top);
  expect(document.querySelector('.menu')).toBeNull();
});

it('closes a stale submenu only when its parent moves', () => {
  const { menu } = openMenu({ x: 30, y: 400, items: [{ label: 'More', submenu: [{ label: 'Child' }] }] });
  const more = menu.querySelector('button');
  more.click();
  observers[0].deliver();
  expect(document.querySelector('.submenu')).not.toBeNull();
  menu.dataset.height = '300';
  observers[0].deliver();
  expect(menu.style.top).toBe('292px');
  expect(document.querySelector('.submenu')).toBeNull();
  expect(more.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(more);
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  expect(isMenuOpen()).toBe(true);
});
