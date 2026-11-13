import { afterEach, expect, it, vi } from 'vitest';
import { Shell } from '../src/ui/shell.js';
import { Prefs } from '../src/lib/prefs.js';

afterEach(() => {
  window.dispatchEvent(new Event('blur'));
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup() {
  const saved = new Map();
  const prefs = new Prefs({ getItem: (k) => saved.get(k) || null, setItem: (k, v) => saved.set(k, v) });
  prefs.merge('layout', { browserOpen: true, dockPanels: ['rack', 'mixer'], dockSizes: { rack: 1, mixer: 1 } });
  const root = document.createElement('div');
  document.body.append(root);
  const shell = new Shell({ prefs, emit() {}, setActivePanel() {} }, root);
  for (const [id, region] of [['browser', 'side'], ['playlist', 'main'], ['rack', 'dock'], ['mixer', 'dock']]) {
    shell.registerPanel({ id, region, title: id, icon: 'win-mixer', create: () => ({}) });
  }
  Object.defineProperty(shell.center, 'clientHeight', { value: 800 });
  shell.layout();
  return { shell, prefs };
}

function pointer(el, type, position = 300, id = 1) {
  const e = new MouseEvent(type, { button: 0, clientX: position, clientY: position, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: id });
  el.dispatchEvent(e);
}

function outer(which) {
  const env = setup();
  const el = which === 'browser' ? env.shell.sideSplit : env.shell.dockSplit;
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return { ...env, el, value: () => env.prefs.get('layout')[which] };
}

it.each(['browser', 'dock'].flatMap((which) => ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'hide'].map((end) => [which, end])))('ends %s resizing on %s without stale movement', (which, end) => {
  const { shell, el, value } = outer(which);
  const before = value();
  pointer(el, 'pointerdown');
  pointer(el, 'pointermove', 310);
  expect(value()).toBe(before + (which === 'browser' ? 10 : -10));
  const final = value();
  if (end === 'blur') window.dispatchEvent(new Event('blur'));
  else if (end === 'hide') shell.hide(which === 'browser' ? 'browser' : 'playlist');
  else pointer(el, end, 310);
  pointer(el, 'pointermove', 350);
  pointer(el, 'pointerup', 350);
  expect(value()).toBe(final);
  expect(el.classList.contains('dragging')).toBe(false);
  if (end === 'hide') shell.show(which === 'browser' ? 'browser' : 'playlist', { focus: false });
  pointer(el, 'pointerdown');
  pointer(el, 'pointermove', 310);
  pointer(el, 'pointerup', 310);
  expect(value()).toBe(final + (which === 'browser' ? 10 : -10));
});

it.each(['browser', 'dock'])('keeps %s resizing attached to the initiating pointer', (which) => {
  const { el, value } = outer(which);
  pointer(el, 'pointerdown');
  pointer(el, 'pointermove', 310);
  const moved = value();
  pointer(el, 'pointerdown', 400, 2);
  pointer(el, 'pointermove', 450, 2);
  pointer(el, 'pointerup', 450, 2);
  expect(value()).toBe(moved);
  expect(el.classList.contains('dragging')).toBe(true);
  pointer(el, 'pointermove', 320);
  pointer(el, 'pointerup', 320);
  pointer(el, 'lostpointercapture', 320);
  expect(value()).toBe(moved + (which === 'browser' ? 10 : -10));
  expect(el.classList.contains('dragging')).toBe(false);
});

it.each(['browser', 'dock'])('preserves %s arrow-key resizing and clamps large pointer moves', (which) => {
  const { el, value } = outer(which);
  const before = value();
  const key = (key, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  key(which === 'browser' ? 'ArrowRight' : 'ArrowUp');
  expect(value()).toBe(before + 10);
  key(which === 'browser' ? 'ArrowLeft' : 'ArrowDown', true);
  expect(value()).toBe(before - 30);
  pointer(el, 'pointerdown');
  pointer(el, 'pointermove', which === 'browser' ? 2000 : -2000);
  pointer(el, 'pointerup');
  expect(value()).toBe(which === 'browser' ? 520 : 720);
});
