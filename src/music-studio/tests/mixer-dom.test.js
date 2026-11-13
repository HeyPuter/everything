import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app.js';
import * as mixer from '../src/panels/mixer.js';
import { demoProject } from '../src/model/demo.js';
import { createMixerTrack, MAX_MIXER_TRACKS } from '../src/model/project.js';
import * as E from '../src/model/edits.js';
import { getWindow, closeWindows } from '../src/ui/windows.js';
import { closeMenus } from '../src/ui/menu.js';
import { createHeaders } from '../src/playlist/headers.js';

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
    closeMenus();
    closeWindows();
    env.panel.onHide();
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

  it.each(['mixer', 'playlist'].flatMap((surface) => ['replacement', 'undo rename', 'tempo edit'].map((change) => [surface, change])))('keeps %s inline rename ownership across %s', (surface, change) => {
    const { store, panel } = env;
    const initial = store.project;
    const update = surface === 'mixer' ? E.updateMixerTrack : E.updateTrack;
    const name = (p) => (surface === 'mixer' ? p.mixer : p.tracks)[1].name;
    if (change === 'undo rename') store.apply('Rename', (p) => update(p, 1, { name: 'Before undo' }));
    let headers;
    if (surface === 'playlist') {
      headers = createHeaders({ store, selectedTrack: 1, scrollY: 0 });
      document.body.append(headers.el);
      headers.render();
    }
    const off = headers ? store.on('change', () => headers.render()) : () => {};
    try {
      if (headers) headers.startRename(1);
      else panel.rename(1);
      const input = document.querySelector(headers ? '.pl-track-input' : '.mx-rename');
      input.value = 'Draft name';
      if (change === 'replacement') store.load({ ...structuredClone(store.project), name: 'Replacement' });
      else if (change === 'undo rename') store.undo();
      else store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 151 }));
      const beforeEnter = store.project;
      key(input, 'Enter');
      if (change === 'tempo edit') {
        expect(name(store.project)).toBe('Draft name');
        store.undo();
        expect(name(store.project)).toBe(name(initial));
        expect(store.project.bpm).toBe(151);
      } else {
        expect(store.project === beforeEnter).toBe(true);
        expect(store.canUndo).toBe(false);
      }
      expect(input.isConnected).toBe(false);
    } finally { off(); }
  });

  it('disables insert buttons at capacity and re-enables them after undo', () => {
    const { store } = env;
    store.apply('Fill mixer', (p) => ({ ...p, mixer: Array.from({ length: MAX_MIXER_TRACKS }, (_, i) => p.mixer[i] || createMixerTrack(i)) }));
    const buttons = [...document.querySelectorAll('button[aria-label="Add mixer insert"]')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    store.undo();
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it('updates send labels when either endpoint is renamed and after undo', () => {
    const { store, panel, ctl } = env;
    ctl.select(1);
    const send = panel.strips[3].el.querySelector('.mx-send-btn');
    expect(send.getAttribute('aria-label')).toBe('Send 1 Kick to 3 Hats');
    store.apply('Rename destination', (p) => E.updateMixerTrack(p, 3, { name: 'Room' }));
    expect(send.getAttribute('aria-label')).toBe('Send 1 Kick to 3 Room');
    store.apply('Rename source', (p) => E.updateMixerTrack(p, 1, { name: 'Drums' }));
    expect(send.getAttribute('aria-label')).toBe('Send 1 Drums to 3 Room');
    expect(send.title).toBe('Click to send 1 Drums here');
    store.undo();
    store.undo();
    expect(send.getAttribute('aria-label')).toBe('Send 1 Kick to 3 Hats');
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

  function mixerControl(kind) {
    vi.advanceTimersByTime(50); // Let the initial panel focus request settle before editing.
    const { ctl, panel } = env;
    let el;
    if (kind === 'volume') el = panel.strips[1].fader.slider;
    else if (kind === 'pan') el = panel.strips[1].el.querySelector('[aria-label="Pan"]');
    else {
      ctl.select(6);
      el = kind === 'mix' ? document.querySelector('.mx-slot [aria-label="Delay mix"]') : document.querySelector('.mx-side [aria-label^="Send level to"]');
    }
    el.setPointerCapture = vi.fn();
    el.releasePointerCapture = vi.fn();
    const pointer = (type, y = 300) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      el.dispatchEvent(e);
    };
    const wheel = () => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
    return { el, pointer, wheel, key: () => key(el, 'ArrowDown') };
  }

  it.each(['volume', 'pan', 'mix', 'send'])('does not let an older mixer %s drag overwrite a newer wheel edit', (kind) => {
    const { store, panel } = env;
    const initial = store.project;
    const old = mixerControl(kind);
    old.pointer('pointerdown');
    old.pointer('pointermove', 308);
    const first = store.project;
    expect(first === initial).toBe(false);
    panel.strips[2].fader.slider.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true }));
    const preview = store.project;
    const owner = store.gesture;
    old.pointer('pointermove', 316);
    old.pointer('pointerup', 316);
    expect(store.project === preview).toBe(true);
    expect(store.gesture === owner).toBe(true);
    vi.advanceTimersByTime(500);
    store.undo();
    expect(store.project === first).toBe(true);
    store.undo();
    expect(store.project === initial).toBe(true);
  });

  it.each(['volume', 'pan', 'mix', 'send'].flatMap((kind) => ['key', 'wheel'].map((input) => [kind, input])))('does not let an old mixer %s %s timer end a newer edit', (kind, input) => {
    const { store, panel } = env;
    const initial = store.project;
    const old = mixerControl(kind);
    old.el.focus();
    old[input]();
    const first = store.project;
    expect(first === initial).toBe(false);
    vi.advanceTimersByTime(100);
    const wheel = () => panel.strips[2].fader.slider.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true }));
    wheel();
    const owner = store.gesture;
    expect(owner).not.toBeNull();
    vi.advanceTimersByTime(350);
    expect(store.gesture === owner).toBe(true);
    wheel();
    vi.advanceTimersByTime(500);
    store.undo();
    expect(store.project === first).toBe(true);
    store.undo();
    expect(store.project === initial).toBe(true);
    old[input]();
    vi.advanceTimersByTime(500);
    expect(store.project === initial).toBe(false);
    store.undo();
    expect(store.project === initial).toBe(true);
  });

  it.each(['mix', 'send'])('keeps successive %s drag updates in one gesture', (kind) => {
    const { store } = env;
    const initial = store.project;
    const control = mixerControl(kind);
    control.pointer('pointerdown');
    control.pointer('pointermove', 308);
    const owner = store.gesture;
    const first = store.project;
    const firstValue = Number(control.el.getAttribute('aria-valuenow'));
    control.pointer('pointermove', 316);
    expect(store.project === first).toBe(false);
    expect(Number(control.el.getAttribute('aria-valuenow'))).toBeLessThan(firstValue);
    expect(store.gesture === owner).toBe(true);
    control.pointer('pointerup', 316);
    expect(store.gesture).toBeNull();
    expect(store.undoStack).toHaveLength(1);
    store.undo();
    expect(store.project === initial).toBe(true);
  });

  it('keeps strip send wheel input working after its source changes', () => {
    const { store, ctl, panel } = env;
    vi.advanceTimersByTime(50);
    ctl.select(6);
    const control = panel.strips[0].el.querySelector('.mx-send-knob');
    const wheel = () => control.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
    wheel();
    const first = store.project;
    expect(first.mixer[6].routes[0]).toBeLessThan(1);
    ctl.select(1);
    expect(store.gesture).toBeNull();
    wheel();
    const secondGain = store.project.mixer[1].routes[0];
    wheel();
    expect(store.project.mixer[1].routes[0]).toBeLessThan(secondGain);
    expect(store.project.mixer[6].routes[0]).toBe(first.mixer[6].routes[0]);
    vi.advanceTimersByTime(500);
    store.undo();
    expect(store.project === first).toBe(true);
  });

  it('preserves a continuous effect-parameter edit before another mixer control takes over', () => {
    const { store, app, ctl, panel } = env;
    vi.advanceTimersByTime(50);
    ctl.select(6);
    const initial = store.project;
    const slot = initial.mixer[6].fx[0];
    const win = app.openEffectEditor(6, slot.id);
    const control = win.el.querySelector('.fxw-knob');
    const wheel = () => control.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true }));
    wheel();
    const firstValue = Number(control.getAttribute('aria-valuenow'));
    wheel();
    expect(Number(control.getAttribute('aria-valuenow'))).toBeGreaterThan(firstValue);
    const first = store.project;
    panel.strips[2].fader.slider.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true }));
    const owner = store.gesture;
    vi.advanceTimersByTime(100);
    expect(store.gesture === owner).toBe(true);
    vi.advanceTimersByTime(500);
    store.undo();
    expect(store.project === first).toBe(true);
    store.undo();
    expect(store.project === initial).toBe(true);
  });

  it.each(['volume', 'pan'])('resynchronizes %s after undo during a keyboard gesture', (param) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    const before = store.project.mixer[2][param];
    key(slider, 'ArrowUp');
    const after = store.project.mixer[2][param];
    expect(after).toBeGreaterThan(before);
    store.undo(); // before the 450 ms key gesture timer expires
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeCloseTo(before, 4);
    key(slider, 'ArrowUp');
    expect(store.project.mixer[2][param]).toBeCloseTo(after, 8);
    vi.advanceTimersByTime(500);
    store.undo();
    expect(store.project.mixer[2][param]).toBe(before);
  });

  it.each(['volume', 'pan'])('stops a %s drag when undo restores the model', (param) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    slider.setPointerCapture = () => {};
    const pointer = (type, y) => slider.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
    const before = store.project.mixer[2][param];
    pointer('pointerdown', 300);
    pointer('pointermove', 298);
    expect(store.project.mixer[2][param]).toBeGreaterThan(before);
    store.undo();
    pointer('pointermove', 296);
    pointer('pointerup', 296);
    expect(store.project.mixer[2][param]).toBe(before);
    expect(store.gesture).toBeNull();
    expect(store.canRedo).toBe(true);
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

  it.each(['volume', 'pan'].flatMap((param) => ['lostpointercapture', 'blur', 'pointerup'].map((event) => [param, event])))('ends a %s drag on %s and ignores its later movement', (param, event) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    slider.setPointerCapture = vi.fn();
    const pointer = (type, y) => slider.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
    const original = store.project;
    pointer('pointerdown', 300);
    pointer('pointermove', 298);
    const committed = store.project;
    expect(committed).not.toBe(original);
    if (event === 'blur') slider.blur();
    else pointer(event, 298);
    pointer('lostpointercapture', 298);
    expect(Boolean(store.gesture)).toBe(false);
    pointer('pointermove', 280);
    pointer('pointerup', 280);
    expect(store.project).toBe(committed);
    expect(slider.classList.contains('dragging')).toBe(false);
    expect(store.undoStack).toHaveLength(1);
    pointer('pointerdown', 300);
    pointer('pointermove', 298);
    pointer('pointerup', 298);
    expect(store.project.mixer[2][param]).toBeGreaterThan(committed.mixer[2][param]);
    store.undo();
    expect(store.project).toBe(committed);
    store.undo();
    expect(store.project).toBe(original);
  });

  it.each(['volume', 'pan'].flatMap((param) => ['replacement', 'undo', 'redo'].map((action) => [param, action])))('discards a pending %s drag after %s with an unchanged displayed value', (param, action) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    slider.setPointerCapture = vi.fn();
    const pointer = (type, y) => slider.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
    if (action !== 'replacement') store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    if (action === 'redo') store.undo();
    pointer('pointerdown', 300);
    if (action === 'replacement') store.load(structuredClone(store.project));
    else store[action]();
    const restored = store.project;
    const history = store.undoStack.length;
    pointer('pointermove', 298);
    pointer('pointerup', 298);
    expect(store.project.mixer[2][param]).toBe(restored.mixer[2][param]);
    expect(store.project).toBe(restored);
    expect(store.undoStack).toHaveLength(history);
    pointer('pointerdown', 300);
    pointer('pointermove', 298);
    pointer('pointerup', 298);
    expect(store.project.mixer[2][param]).toBeGreaterThan(restored.mixer[2][param]);
    store.undo();
    expect(store.project).toBe(restored);
  });

  it.each(['volume', 'pan'])('preserves a pending %s drag across an unrelated edit', (param) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    slider.setPointerCapture = vi.fn();
    const pointer = (type, y) => slider.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
    pointer('pointerdown', 300);
    store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    const before = store.project;
    pointer('pointermove', 298);
    pointer('pointerup', 298);
    expect(store.project.mixer[2][param]).toBeGreaterThan(before.mixer[2][param]);
    expect(store.project.bpm).toBe(150);
    store.undo();
    expect(store.project).toBe(before);
  });

  it.each(['volume', 'pan'])('cancels the %s key timer on replacement even if the value is unchanged', (param) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    key(slider, 'ArrowUp');
    store.load(structuredClone(store.project));
    store.begin('Later edit');
    store.preview((p) => E.setProjectProps(p, { bpm: 150 }));
    const gesture = store.gesture;
    vi.advanceTimersByTime(500);
    expect(store.gesture === gesture).toBe(true);
    expect(store.undoStack).toHaveLength(0);
    store.cancel();
  });

  it.each(['volume', 'pan'].flatMap((param) => ['replacement', 'undo', 'redo'].map((action) => [param, action])))('closes an obsolete %s typed-value editor after %s', (param, action) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    if (action !== 'replacement') store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    if (action === 'redo') store.undo();
    key(slider, 'Enter');
    const input = document.activeElement;
    expect(input.tagName).toBe('INPUT');
    input.value = param === 'volume' ? '-6 dB' : '0.5';
    if (action === 'replacement') store.load(structuredClone(store.project));
    else store[action]();
    const replacement = store.project;
    const history = store.undoStack.length;
    const stayedOpen = input.isConnected;
    key(input, 'Enter');
    expect(store.project.mixer[2][param]).toBe(replacement.mixer[2][param]);
    expect(store.project).toBe(replacement);
    expect(stayedOpen).toBe(false);
    expect(store.undoStack).toHaveLength(history);
  });

  it.each(['volume', 'pan'].flatMap((param) => ['Enter', 'Escape', 'blur'].map((action) => [param, action])))('preserves %s typed-value editing with %s across an unrelated edit', (param, action) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    key(slider, 'Enter');
    const input = document.activeElement;
    input.value = param === 'volume' ? '-6 dB' : '0.5';
    store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    const before = store.project;
    expect(input.isConnected).toBe(true);
    if (action === 'blur') input.blur();
    else key(input, action);
    expect(input.isConnected).toBe(false);
    expect(document.activeElement).toBe(slider);
    expect(store.project.bpm).toBe(150);
    if (action === 'Escape') expect(store.project).toBe(before);
    else {
      expect(store.project.mixer[2][param]).toBeCloseTo(param === 'volume' ? 10 ** (-6 / 20) : 0.5);
      store.undo();
      expect(store.project).toBe(before);
    }
  });

  it.each(['volume', 'pan'].flatMap((param) => ['pointerup', 'pointercancel', 'lostpointercapture'].map((event) => [param, event])))('keeps the first pointer in control of %s when another pointer sends %s', (param, event) => {
    const { store, panel } = env;
    const slider = param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector('[aria-label="Pan"]');
    slider.setPointerCapture = vi.fn();
    const pointer = (type, y, id) => {
      const e = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
      Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } });
      slider.dispatchEvent(e);
    };
    const original = store.project;
    pointer('pointerdown', 300, 1);
    pointer('pointermove', 298, 1);
    const value = store.project.mixer[2][param];
    const gesture = store.gesture;
    pointer('pointermove', 350, 2);
    expect(store.project.mixer[2][param]).toBe(value);
    pointer('pointerdown', 350, 2);
    pointer('pointermove', 300, 2);
    pointer(event, 300, 2);
    expect(store.project.mixer[2][param]).toBe(value);
    expect(store.gesture === gesture).toBe(true);
    pointer('pointermove', 296, 1);
    pointer('pointerup', 296, 1);
    const committed = store.project;
    expect(committed.mixer[2][param]).toBeGreaterThan(value);
    pointer('pointermove', 270, 1);
    pointer('pointermove', 270, 2);
    expect(store.project).toBe(committed);
    expect(store.undoStack).toHaveLength(1);
    store.undo();
    expect(store.project).toBe(original);
    pointer('pointerdown', 300, 2);
    pointer('pointermove', 298, 2);
    pointer('pointerup', 298, 2);
    expect(store.project.mixer[2][param]).toBeCloseTo(value);
  });

  it('updates only strips whose track changed', () => {
    const { store, panel } = env;
    const spies = panel.strips.map((s) => vi.spyOn(s.fader, 'set'));
    store.apply('Vol', (p) => ({ ...p, mixer: p.mixer.map((t, i) => (i === 5 ? { ...t, volume: 0.5 } : t)) }));
    expect(spies[5]).toHaveBeenCalledWith(0.5);
    expect(spies.filter((s, i) => i !== 5 && s.mock.calls.length)).toHaveLength(0);
  });

  function sendPointer(el, type, y = 300) {
    const e = new MouseEvent(type, { button: 0, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    el.dispatchEvent(e);
  }

  it.each(['add', 'remove', 'blocked'])('keeps the source selected throughout a send-button pointer click (%s)', (action) => {
    const { ctl, panel, store } = env;
    const notify = vi.spyOn(env.app, 'notify').mockImplementation(() => {});
    vi.advanceTimersByTime(50);
    if (action === 'remove') ctl.toggleRoute(2, 8);
    if (action === 'blocked') ctl.toggleRoute(8, 2);
    ctl.select(2);
    const before = store.project;
    const button = panel.strips[8].el.querySelector('.mx-send-btn');
    sendPointer(button, 'pointerdown');
    button.focus();
    sendPointer(button, 'pointerup');
    button.click();
    expect(ctl.selected).toBe(2);
    expect(button.hidden).toBe(false);
    expect(store.project.mixer[2].routes[8]).toBe(action === 'add' ? 1 : undefined);
    expect(store.project.mixer[8].routes[2]).toBe(action === 'blocked' ? 1 : undefined);
    if (action === 'blocked') {
      expect(store.project === before).toBe(true);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/feedback loop/), { error: true });
    }
    else {
      store.undo();
      expect(store.project === before).toBe(true);
    }
    notify.mockRestore();
  });

  it.each(['pointer', 'keyboard'])('keeps a strip send gain attached to its source during %s input', (input) => {
    const { ctl, panel, store } = env;
    vi.advanceTimersByTime(50);
    ctl.select(2);
    const before = store.project;
    const control = panel.strips[0].el.querySelector('.mx-send-knob');
    control.setPointerCapture = vi.fn();
    control.releasePointerCapture = vi.fn();
    if (input === 'pointer') {
      sendPointer(control, 'pointerdown');
      sendPointer(control, 'pointermove', 308);
      sendPointer(control, 'pointermove', 316);
      sendPointer(control, 'pointerup', 316);
    } else {
      control.focus();
      key(control, 'ArrowDown');
      key(control, 'ArrowDown');
      vi.advanceTimersByTime(500);
    }
    expect(ctl.selected).toBe(2);
    expect(control.hidden).toBe(false);
    expect(store.project.mixer[2].routes[0]).toBeLessThan(1);
    expect(store.project.mixer[0].routes).toEqual({});
    expect(Number(control.getAttribute('aria-valuenow'))).toBeCloseTo(store.project.mixer[2].routes[0], 3);
    store.undo();
    expect(store.project === before).toBe(true);
  });

  it('still selects a destination strip through its name and ordinary controls', () => {
    const { ctl, panel } = env;
    ctl.select(2);
    const strip = panel.strips[8];
    sendPointer(strip.nameBtn, 'pointerdown');
    expect(ctl.selected).toBe(8);
    ctl.select(2);
    strip.fader.slider.focus();
    expect(ctl.selected).toBe(8);
  });

  it.each(['pan', 'width', 'send', 'volume'])('preserves the %s control context menu and its reset action', (param) => {
    const { ctl, panel, store } = env;
    vi.advanceTimersByTime(50);
    ctl.select(2);
    const label = param === 'pan' ? 'Pan' : param === 'width' ? 'Width' : param === 'send' ? 'Send level' : `${store.project.mixer[2].name} volume`;
    const control = param === 'send' ? panel.strips[0].el.querySelector('.mx-send-knob') : param === 'volume' ? panel.strips[2].fader.slider : panel.strips[2].el.querySelector(`[aria-label="${label}"]`);
    control.focus();
    control.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(500);
    const before = store.project;
    control.dispatchEvent(new MouseEvent('pointerdown', { button: 2, bubbles: true, cancelable: true }));
    control.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    const menu = document.querySelector('[role="menu"]');
    expect(menu.getAttribute('aria-label')).toBe(`${label} options`);
    expect(ctl.selected).toBe(2);
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.some((item) => item.textContent.startsWith('Type in value'))).toBe(true);
    items.find((item) => item.textContent.startsWith('Reset')).click();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(control);
    const value = param === 'send' ? store.project.mixer[2].routes[0] : store.project.mixer[2][param];
    expect(value).toBe(param === 'pan' ? 0 : 1);
    store.undo();
    expect(store.project === before).toBe(true);
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

  function effectDrag(scroll = 0) {
    env.ctl.select(6);
    const side = document.querySelector('.mx-side');
    side.scrollTop = scroll;
    const rows = [...document.querySelectorAll('.mx-slot[data-id]')];
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: 100 + i * 40 - side.scrollTop, height: 40 });
    });
    const grip = rows[0].querySelector('.mx-grip');
    grip.setPointerCapture = vi.fn();
    grip.releasePointerCapture = vi.fn();
    const pointer = (type, y = 190 - scroll, id = 1) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: id });
      grip.dispatchEvent(event);
    };
    pointer('pointerdown', 120 - scroll);
    pointer('pointermove');
    return { grip, pointer, row: rows[0] };
  }

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('discards an effect reorder on %s and ignores late events', (end) => {
    const { store } = env;
    const before = store.project;
    const history = store.undoStack.length;
    const { pointer, row } = effectDrag();
    if (end === 'blur') window.dispatchEvent(new Event('blur'));
    else pointer(end);
    expect(store.project).toBe(before);
    expect(row.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.mx-drop-line')).toBeNull();
    pointer('pointermove');
    pointer('pointerup');
    expect(store.project).toBe(before);
    expect(store.undoStack).toHaveLength(history);
    const fresh = effectDrag();
    fresh.pointer('pointerup');
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    store.undo();
    expect(store.project).toBe(before);
  });

  it.each(['grip', 'text field'])('cancels an effect reorder with Escape while focus is on the %s', (target) => {
    const { store } = env;
    const before = store.project;
    const history = store.undoStack.length;
    const { pointer, row, grip } = effectDrag();
    let focused = grip;
    if (target === 'text field') {
      focused = document.createElement('input');
      document.body.append(focused);
    }
    focused.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    focused.dispatchEvent(escape);
    expect(row.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.mx-drop-line')).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focused);
    pointer('pointermove');
    pointer('pointerup');
    expect(store.project).toBe(before);
    expect(store.undoStack).toHaveLength(history);
    const nextEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    focused.dispatchEvent(nextEscape);
    expect(nextEscape.defaultPrevented).toBe(false);
    const fresh = effectDrag();
    fresh.pointer('pointerup');
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    store.undo();
    expect(store.project).toBe(before);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores a competing effect-reorder pointer and its %s', (end) => {
    const { store } = env;
    const before = store.project;
    const history = store.undoStack.length;
    const { pointer, row } = effectDrag();
    pointer('pointerdown', 120, 2);
    pointer('pointermove', 110, 2);
    pointer(end, 110, 2);
    expect(store.project).toBe(before);
    expect(row.classList.contains('dragging')).toBe(true);
    expect(document.querySelectorAll('.mx-drop-line')).toHaveLength(1);
    pointer('pointerup');
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    expect(store.undoStack).toHaveLength(history + 1);
    pointer('lostpointercapture');
    pointer('pointermove', 110, 2);
    pointer('pointerup', 110, 2);
    expect(store.undoStack).toHaveLength(history + 1);
    store.undo();
    expect(store.project).toBe(before);
  });

  it('commits a normal effect reorder once and leaves a no-move drag unchanged', () => {
    const { store } = env;
    const before = store.project;
    const history = store.undoStack.length;
    const { pointer } = effectDrag();
    pointer('pointerup');
    pointer('lostpointercapture');
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    expect(store.undoStack).toHaveLength(history + 1);
    store.undo();
    expect(store.project).toBe(before);
    pointer('pointerdown', 120);
    pointer('pointerup', 120);
    expect(store.project).toBe(before);
    expect(store.canRedo).toBe(true);
  });

  it.each(['scroll', 'pointermove', 'pointerup'].flatMap((update) => [0, 40].map((scroll) => [update, scroll])))('keeps the effect drop target aligned after scrolling (%s update, starting at %s)', (update, scroll) => {
    const { store, ctl } = env;
    ctl.addEffect(6, 'eq');
    ctl.addEffect(6, 'eq');
    const before = store.project;
    const ids = before.mixer[6].fx.map((slot) => slot.id);
    const { pointer, row } = effectDrag(scroll);
    const side = row.closest('.mx-side');
    const rows = [...side.querySelectorAll('.mx-slot[data-id]')];
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: 100 + i * 40 - side.scrollTop, height: 40 });
      Object.defineProperties(row, { offsetTop: { value: i * 40 }, offsetHeight: { value: 40 } });
    });
    pointer('pointermove', 190 - scroll);
    expect(side.querySelector('.mx-drop-line').style.top).toBe('79px');
    side.scrollTop = scroll + 80;
    if (update === 'scroll') side.dispatchEvent(new Event('scroll'));
    else if (update === 'pointermove') pointer('pointermove', 190 - scroll);
    if (update !== 'pointerup') expect(side.querySelector('.mx-drop-line').style.top).toBe('159px');
    pointer('pointerup', 190 - scroll);
    expect(store.project.mixer[6].fx.map((slot) => slot.id)).toEqual([...ids.slice(1), ids[0]]);
    expect(side.querySelector('.mx-drop-line')).toBeNull();
    side.scrollTop = 0;
    side.dispatchEvent(new Event('scroll'));
    pointer('pointermove', 110);
    store.undo();
    expect(store.project).toBe(before);
    store.redo();
    expect(store.project.mixer[6].fx.map((slot) => slot.id)).toEqual([...ids.slice(1), ids[0]]);
  });

  it.each(['load', 'undo', 'redo', 'select insert', 'hide mixer', 'hide effects', 'change chain', 'destroy'])('cancels obsolete effect reorders after %s', (change) => {
    const { app, store, panel, ctl } = env;
    if (change === 'undo' || change === 'redo') {
      store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 151 }));
      if (change === 'redo') store.undo();
    }
    const { pointer, row } = effectDrag();
    if (change === 'load') store.load(structuredClone(store.project));
    else if (change === 'undo') store.undo();
    else if (change === 'redo') store.redo();
    else if (change === 'select insert') ctl.select(3);
    else if (change === 'hide mixer') app.shell.hide('mixer');
    else if (change === 'hide effects') app.commands.run('mixer.toggleEffectsPanel');
    else if (change === 'change chain') ctl.addEffect(6, 'eq', 0);
    else panel.destroy();
    const restored = store.project;
    const history = store.undoStack.length;
    expect(row.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.mx-drop-line')).toBeNull();
    pointer('pointermove');
    pointer('pointerup');
    expect(store.project).toBe(restored);
    expect(store.undoStack).toHaveLength(history);
    expect(row.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.mx-drop-line')).toBeNull();
  });

  it.each(['tempo', 'volume', 'effect parameter'])('preserves an effect reorder across an unrelated %s edit', (change) => {
    const { store } = env;
    const { pointer } = effectDrag();
    const id = store.project.mixer[6].fx[0].id;
    if (change === 'tempo') store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 151 }));
    else if (change === 'volume') store.apply('Volume', (p) => E.updateMixerTrack(p, 6, { volume: 0.5 }));
    else store.apply('Effect mix', (p) => E.updateSlot(p, 6, id, { mix: 0.5 }));
    const edited = store.project;
    const history = store.undoStack.length;
    expect(document.querySelector('.mx-slot.dragging')).not.toBeNull();
    pointer('pointerup');
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
    expect(store.undoStack).toHaveLength(history + 1);
    store.undo();
    expect(store.project).toBe(edited);
    store.redo();
    expect(store.project.mixer[6].fx.map((s) => s.type)).toEqual(['reverb', 'delay']);
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
    closeMenus();
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
