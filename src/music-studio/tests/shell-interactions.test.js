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

function dockPair() {
  const env = setup();
  const a = env.shell.panels.get('rack').host;
  const b = env.shell.panels.get('mixer').host;
  for (const el of [a, b]) Object.defineProperty(el, 'offsetWidth', {
    get: () => 800 * Number(el.style.flexGrow) / (Number(a.style.flexGrow) + Number(b.style.flexGrow)),
  });
  const separator = () => env.shell.dock.querySelector('.splitter-dock');
  return { ...env, a, b, separator };
}

it.each(['ArrowLeft', 'ArrowRight'])('keeps the dock separator focused for repeated %s resizing', (key) => {
  const { prefs, a, b, separator } = dockPair();
  separator().focus();
  const delta = key === 'ArrowRight' ? 20 : -20;
  for (const shiftKey of [false, false, true]) {
    const before = a.offsetWidth;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    expect(a.offsetWidth).toBeCloseTo(before + delta * (shiftKey ? 3 : 1));
    expect(document.activeElement === separator()).toBe(true);
    expect(prefs.get('layout').dockSizes).toEqual({ rack: Number(a.style.flexGrow), mixer: Number(b.style.flexGrow) });
  }
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight', bubbles: true }));
  expect(a.offsetWidth).toBeCloseTo(400 + delta * 4);
});

it('retains dock separator focus across unrelated layout updates without stealing other focus', () => {
  const { prefs, separator } = dockPair();
  separator().focus();
  prefs.merge('layout', { browser: 300 });
  expect(document.activeElement === separator()).toBe(true);
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  prefs.merge('layout', { browser: 310 });
  expect(document.activeElement).toBe(input);
});
