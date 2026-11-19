import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDialog } from '../src/ui/dialog.js';
import { raiseWindow, stackWindow, resetWindowStack } from '../src/ui/window-stack.js';

beforeEach(() => resetWindowStack());
afterEach(() => document.body.replaceChildren());

const z = (el) => Number(el.style.zIndex);
const press = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

it('opens each floating window in front and raises the one clicked', async () => {
  const a = {};
  const b = {};
  openDialog({ title: 'A', body: 'a', modeless: true, handle: a });
  openDialog({ title: 'B', body: 'b', modeless: true, handle: b });
  const backA = a.el.parentElement;
  const backB = b.el.parentElement;
  expect(z(backB)).toBeGreaterThan(z(backA));
  press(a.el.querySelector('.dialog-body'), 'pointerdown');
  expect(z(backA)).toBeGreaterThan(z(backB));
  // Every floating window stays under modal dialogs (900) and menus.
  expect(z(backA)).toBeLessThan(900);
});

it('lets a floating window behind another take its own Escape', async () => {
  const a = {};
  const b = {};
  const closed = openDialog({ title: 'A', body: 'a', modeless: true, handle: a });
  openDialog({ title: 'B', body: 'b', modeless: true, handle: b });
  a.el.focus();
  a.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await closed).toBe(null);
  expect(b.el.isConnected).toBe(true);
});

it('raises floating panel frames above floating windows when clicked', () => {
  const frame = stackWindow(Object.assign(document.createElement('div'), { className: 'dock-float' }));
  document.body.append(frame);
  raiseWindow(frame);
  const w = {};
  openDialog({ title: 'W', body: 'w', modeless: true, handle: w });
  expect(z(w.el.parentElement)).toBeGreaterThan(z(frame));
  press(frame, 'pointerdown');
  expect(z(frame)).toBeGreaterThan(z(w.el.parentElement));
});

it('renumbers from the bottom when the stack runs out of room, keeping the order', () => {
  const a = stackWindow(Object.assign(document.createElement('div'), { className: 'dock-float' }));
  const b = stackWindow(Object.assign(document.createElement('div'), { className: 'dock-float' }));
  document.body.append(a, b);
  for (let i = 0; i < 120; i++) raiseWindow(i % 2 ? a : b);
  expect(z(a)).toBeGreaterThan(z(b));
  expect(z(a)).toBeLessThan(900);
  expect(z(b)).toBeGreaterThan(800);
});

it('brings a floating window forward when focus moves into it (keyboard, or reopening its effect)', () => {
  const a = {};
  const b = {};
  openDialog({ title: 'A', body: () => Object.assign(document.createElement('input'), { className: 'in-a' }), modeless: true, handle: a });
  openDialog({ title: 'B', body: 'b', modeless: true, handle: b });
  a.el.querySelector('.in-a').focus();
  expect(z(a.el.parentElement)).toBeGreaterThan(z(b.el.parentElement));
});
