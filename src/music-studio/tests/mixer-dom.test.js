import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app.js';
import * as mixer from '../src/panels/mixer.js';
import { demoProject } from '../src/model/demo.js';
import { getWindow, closeWindows } from '../src/ui/windows.js';

// jsdom has no canvas: a 2D context whose methods do nothing.
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ width: 0 })), set: (t, k, v) => ((t[k] = v), true) });
HTMLCanvasElement.prototype.getContext = function getContext(type) {
  return type === '2d' ? ctx2d : null;
};

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

function start() {
  document.body.innerHTML = '<div id="app"></div>';
  const app = new App(document.getElementById('app'), { project: demoProject(), storage: memory() });
  app.start([mixer]);
  app.shell.show('mixer');
  app.shell.layout();
  const panel = app.panel('mixer');
  return { app, panel, store: app.store, ctl: app.mixerController };
}

const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

describe('mixer panel', () => {
  let env;
  beforeEach(() => {
    vi.useFakeTimers();
    env = start();
  });
  afterEach(() => {
    closeWindows();
    cancelAnimationFrame(env.app.raf);
    vi.useRealTimers();
  });

  it('renders the master and every insert', () => {
    const strips = document.querySelectorAll('.mx-strip');
    expect(strips).toHaveLength(env.store.project.mixer.length);
    expect(strips[0].classList.contains('master')).toBe(true);
    expect(strips[1].querySelector('.mx-name').textContent).toBe('Kick');
    expect(strips[3].querySelector('.mx-in').getAttribute('aria-label')).toBe('Inputs: Closed Hat, Open Hat');
  });

  it('fader keys change the volume in the store as one undo step', () => {
    const { store, panel } = env;
    const slider = panel.strips[2].fader.slider;
    const before = store.undoStack.length;
    key(slider, 'ArrowUp');
    key(slider, 'ArrowUp');
    key(slider, 'ArrowUp');
    expect(store.project.mixer[2].volume).toBeGreaterThan(0.8);
    expect(slider.getAttribute('aria-valuetext')).toBe('-0.4 dB');
    vi.advanceTimersByTime(500);
    expect(store.undoStack.length).toBe(before + 1);
    expect(store.undoLabel).toBe('Insert volume');
    expect(env.app.lastTweaked.target).toEqual({ kind: 'mixer', track: 2, param: 'volume' });
    store.undo();
    expect(store.project.mixer[2].volume).toBe(0.8);
    expect(slider.getAttribute('aria-valuetext')).toBe('-1.9 dB');
  });

  it('a fader drag is one undo step and double-click resets to 0 dB', () => {
    const { store, panel } = env;
    const slider = panel.strips[4].fader.slider;
    const before = store.undoStack.length;
    const ev = (type, y) => {
      const e = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      slider.dispatchEvent(e);
    };
    ev('pointerdown', 300);
    for (let y = 298; y >= 260; y -= 2) ev('pointermove', y);
    ev('pointerup', 260);
    expect(store.project.mixer[4].volume).toBeGreaterThan(0.8);
    expect(store.undoStack.length).toBe(before + 1);
    slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(store.project.mixer[4].volume).toBe(1);
  });

  it('updates only strips whose track changed', () => {
    const { store, panel } = env;
    const spies = panel.strips.map((s) => vi.spyOn(s.fader, 'set'));
    store.apply('Vol', (p) => ({ ...p, mixer: p.mixer.map((t, i) => (i === 5 ? { ...t, volume: 0.5 } : t)) }));
    expect(spies[5]).toHaveBeenCalledWith(0.5);
    expect(spies.filter((s, i) => i !== 5 && s.mock.calls.length)).toHaveLength(0);
  });

  it('send buttons route the selected insert and refuse loops with a toast', () => {
    const { store, panel, ctl } = env;
    ctl.select(2);
    panel.strips[8].el.querySelector('.mx-send-btn').click();
    expect(store.project.mixer[2].routes).toEqual({ 0: 1, 8: 1 });
    ctl.select(8);
    expect(panel.strips[2].el.querySelector('.mx-send').dataset.mode).toBe('blocked');
    panel.strips[2].el.querySelector('.mx-send-btn').click();
    expect(store.project.mixer[8].routes).toEqual({ 0: 1 });
    expect(document.querySelector('.toast.error').textContent).toMatch(/feedback loop/);
  });

  it('lists effect slots, reorders with Mod+Down and deletes the focused one', () => {
    const { store, ctl, app } = env;
    ctl.select(6);
    const names = () => [...document.querySelectorAll('.mx-slot-name')].map((n) => n.textContent);
    expect(names()).toEqual(['Delay', 'Reverb']);
    expect(document.querySelectorAll('.mx-slot.empty')).toHaveLength(8);
    const first = document.querySelector('.mx-slot-name');
    first.focus();
    key(first, 'ArrowDown', { ctrlKey: true, metaKey: true });
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    expect(names()).toEqual(['Reverb', 'Delay']);
    expect(document.activeElement.textContent).toBe('Delay');
    app.panel('mixer').actions.delete();
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb']);
  });

  it('provides effect menu items for the selected insert', () => {
    const { app, ctl, store } = env;
    ctl.select(4);
    const items = app.effectMenuItems();
    expect(items[0].label).toBe('On 4 Bass');
    const filters = items.find((i) => i.label === 'Filter and EQ');
    filters.items.find((i) => i.label === 'Parametric EQ').run();
    expect(store.project.mixer[4].fx.at(-1).type).toBe('eq');
    expect(getWindow(`fx:4:${store.project.mixer[4].fx.at(-1).id}`)).toBeTruthy();
  });

  it('follows the rack selection and routes selected channels', () => {
    const { store, ctl } = env;
    const bass = store.project.channels.find((c) => c.name === 'Bass');
    store.selectChannels([bass.id]);
    expect(ctl.selected).toBe(4);
    ctl.routeSelectedChannels(9);
    expect(store.project.channels.find((c) => c.id === bass.id).mixer).toBe(9);
  });
});

describe('effect editor windows', () => {
  let env;
  beforeEach(() => {
    env = start();
  });
  afterEach(() => {
    closeWindows();
    cancelAnimationFrame(env.app.raf);
  });

  it('opens once per slot, follows the store and closes when the slot goes', () => {
    const { app, ctl, store } = env;
    const id = ctl.addEffect(3, 'compressor');
    const win = app.openEffectEditor(3, id);
    expect(app.openEffectEditor(3, id)).toBe(win);
    expect(win.el.getAttribute('aria-label')).toBe('Compressor on 3 Hats');
    const knob = win.el.querySelector('[data-param="threshold"]');
    store.apply('t', (p) => ({ ...p, mixer: p.mixer.map((t, i) => (i === 3 ? { ...t, fx: t.fx.map((s) => ({ ...s, params: { ...s.params, threshold: -30 } })) } : t)) }));
    expect(knob.getAttribute('aria-valuenow')).toBe('-30');
    store.undo();
    expect(knob.getAttribute('aria-valuenow')).toBe('-18');
    store.undo(); // removes the slot
    expect(getWindow(`fx:3:${id}`)).toBeNull();
  });

  it('EQ handles change frequency and gain from the keyboard', () => {
    const { app, ctl, store } = env;
    const id = ctl.addEffect(1, 'eq');
    const win = app.openEffectEditor(1, id);
    const handle = win.el.querySelector('.eqg-handle[data-band="m1"]');
    key(handle, 'ArrowUp');
    key(handle, 'ArrowUp');
    key(handle, 'ArrowRight');
    const s = store.project.mixer[1].fx.find((x) => x.id === id);
    expect(s.params.m1_gain).toBe(1);
    expect(s.params.m1_freq).toBeCloseTo(500 * 2 ** (1 / 12), 6);
    expect(handle.getAttribute('aria-valuetext')).toMatch(/^Band 1: 530 Hz, \+1\.0 dB, Q 1\.00$/);
  });

  it('delay shows the synced time at the project tempo', () => {
    const { app, store } = env;
    const delay = store.project.mixer[6].fx.find((s) => s.type === 'delay');
    const win = app.openEffectEditor(6, delay.id);
    expect(win.el.querySelector('.fxw-time').textContent).toBe('1/8 dotted = 363 ms at 124 BPM');
    store.apply('Tempo', (p) => ({ ...p, bpm: 120 }));
    expect(win.el.querySelector('.fxw-time').textContent).toBe('1/8 dotted = 375 ms at 120 BPM');
  });
});
