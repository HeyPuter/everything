import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { openChannelEditor } from '../src/rack/editor.js';
import { closeWindows } from '../src/ui/windows.js';
import * as E from '../src/model/edits.js';
import { defaultParams } from '../src/instruments/catalog.js';

let hitDescriptor;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  hitDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
});
afterEach(() => {
  closeWindows();
  if (hitDescriptor) Object.defineProperty(document, 'elementFromPoint', hitDescriptor);
  else delete document.elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  const ready = vi.spyOn(app.engine, 'ready', 'get').mockReturnValue(true);
  const noteOn = vi.spyOn(app.engine, 'noteOn').mockImplementation(() => {});
  const noteOff = vi.spyOn(app.engine, 'noteOff').mockImplementation(() => {});
  const id = app.store.project.channels[0].id;
  const win = openChannelEditor(app, id);
  const keys = win.el.querySelector('.kb-keys');
  keys.setPointerCapture = vi.fn();
  keys.releasePointerCapture = vi.fn();
  let hit = keys.querySelector('[data-key="50"]');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
  const pointer = (type, pointerId = 1, target = keys) => {
    const event = new MouseEvent(type, { button: 0, clientX: 100, clientY: 30, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    target.dispatchEvent(event);
  };
  const press = (key = 48, pointerId = 1) => pointer('pointerdown', pointerId, keys.querySelector(`[data-key="${key}"]`));
  return { app, win, id, keys, ready, noteOn, noteOff, pointer, press, hit: (key) => { hit = keys.querySelector(`[data-key="${key}"]`); } };
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'octave', 'focusout', 'close', 'blur'])('stops a pointer audition on %s and does not revive it on late movement', (end) => {
  const { win, id, keys, noteOn, noteOff, pointer, press, hit } = setup();
  press();
  expect(noteOn).toHaveBeenCalledWith(id, 48, 0.8);
  expect(keys.querySelector('[data-key="48"]').classList.contains('down')).toBe(true);
  if (end === 'octave') win.el.querySelector('[aria-label="Octave up"]').click();
  else if (end === 'focusout') {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
  } else if (end === 'close') win.close();
  else if (end === 'blur') window.dispatchEvent(new Event('blur'));
  else pointer(end);
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 48);
  expect(keys.querySelector('.down')).toBeNull();
  hit(end === 'octave' ? 62 : 50);
  pointer('pointermove');
  pointer('pointerup');
  pointer('lostpointercapture');
  expect(noteOn).toHaveBeenCalledTimes(1);
  expect(noteOff).toHaveBeenCalledTimes(1);
  if (end !== 'close') {
    const key = end === 'octave' ? 60 : 48;
    press(key, 2);
    pointer('pointerup', 2);
    expect(noteOn).toHaveBeenLastCalledWith(id, key, 0.8);
    expect(noteOff).toHaveBeenLastCalledWith(id, key);
    expect(noteOn).toHaveBeenCalledTimes(2);
  }
});

it('preserves pointer chords and glissando while ignoring foreign releases', () => {
  const { id, keys, noteOn, noteOff, pointer, press } = setup();
  press(48, 1);
  press(52, 2);
  pointer('pointerup', 3);
  expect(noteOff).not.toHaveBeenCalled();
  pointer('pointermove', 1);
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 48);
  expect(noteOn).toHaveBeenLastCalledWith(id, 50, 0.8);
  pointer('pointerup', 1);
  expect(keys.querySelector('[data-key="52"]').classList.contains('down')).toBe(true);
  pointer('pointerup', 2);
  pointer('lostpointercapture', 2);
  expect(noteOff.mock.calls.map((c) => c[1])).toEqual([48, 50, 52]);
  expect(keys.querySelector('.down')).toBeNull();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

it.each(['pointer', 'key'].flatMap((input) => ['old first', 'new first', 'shared startup'].map((order) => [input, order])))('does not revive an old %s audition when the same pitch is replayed during startup (%s)', async (input, order) => {
  const { app, win, id, ready, noteOn, noteOff, pointer, press } = setup();
  ready.mockReturnValue(false);
  const first = deferred();
  const second = order === 'shared startup' ? first : deferred();
  const start = vi.spyOn(app.engine, 'start').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const play = () => {
    if (input === 'pointer') press();
    else win.el.querySelector('.ch-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true, cancelable: true }));
  };
  const release = () => {
    if (input === 'pointer') pointer('pointerup');
    else win.el.querySelector('.ch-editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'z', code: 'KeyZ', bubbles: true, cancelable: true }));
  };
  play();
  release();
  play();
  expect(start).toHaveBeenCalledTimes(2);
  if (order === 'old first') {
    first.resolve();
    await first.promise;
    expect(noteOn).not.toHaveBeenCalled();
    second.resolve();
    await second.promise;
  } else {
    second.resolve();
    await second.promise;
    expect(noteOn).toHaveBeenCalledExactlyOnceWith(id, 48, 0.8);
    first.resolve();
    await first.promise;
  }
  expect(noteOn).toHaveBeenCalledExactlyOnceWith(id, 48, 0.8);
  release();
  expect(noteOff).toHaveBeenLastCalledWith(id, 48);
});

it('preserves independently held chord notes across audio startup and cancels released notes', async () => {
  const { app, id, ready, keys, noteOn, pointer, press } = setup();
  ready.mockReturnValue(false);
  const pending = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(pending.promise);
  press(48, 1);
  press(52, 2);
  press(55, 3);
  pointer('pointerup', 2);
  pending.resolve();
  await pending.promise;
  expect(noteOn.mock.calls).toEqual([[id, 48, 0.8], [id, 55, 0.8]]);
  expect(keys.querySelector('[data-key="52"]').classList.contains('down')).toBe(false);
  pointer('pointerup', 1);
  pointer('pointerup', 3);
  expect(keys.querySelector('.down')).toBeNull();
});

it('does not sound a pending chord after its editor closes', async () => {
  const { app, win, ready, noteOn, press } = setup();
  ready.mockReturnValue(false);
  const pending = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(pending.promise);
  press(48, 1);
  press(52, 2);
  win.close();
  pending.resolve();
  await pending.promise;
  expect(noteOn).not.toHaveBeenCalled();
});

it.each(['load', 'same project', 'type', 'sample'].flatMap((action) => [false, true].map((pending) => [action, pending])))('releases the old instrument audition on %s (startup pending: %s)', async (action, pending) => {
  const { app, id, keys, ready, noteOn, noteOff, pointer, press } = setup();
  const store = app.store;
  if (action === 'sample') store.apply('Sampler', (p) => E.updateChannel(p, id, { type: 'sampler', sample: 'old', params: defaultParams('sampler') }));
  const starting = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(starting.promise);
  ready.mockReturnValue(!pending);
  press();
  if (action === 'load') store.load(structuredClone(store.project));
  else if (action === 'same project') store.load(store.project);
  else if (action === 'type') store.apply('Instrument', (p) => E.updateChannel(p, id, { type: 'synth', params: defaultParams('synth') }));
  else store.apply('Sample', (p) => E.updateChannel(p, id, { sample: 'new' }));
  ready.mockReturnValue(true);
  starting.resolve();
  await starting.promise;
  expect(noteOn).toHaveBeenCalledTimes(pending ? 0 : 1);
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 48);
  expect(keys.querySelector('.down')).toBeNull();
  pointer('pointermove');
  pointer('pointerup');
  expect(noteOn).toHaveBeenCalledTimes(pending ? 0 : 1);
  press(50, 2);
  pointer('pointerup', 2);
  expect(noteOn).toHaveBeenLastCalledWith(id, 50, 0.8);
  expect(noteOff).toHaveBeenLastCalledWith(id, 50);
});

it('keeps a held audition through ordinary parameter and tempo edits', async () => {
  const { app, id, keys, ready, noteOn, noteOff, pointer, press } = setup();
  const pending = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(pending.promise);
  ready.mockReturnValue(false);
  press();
  app.store.apply('Decay', (p) => E.setChannelParam(p, id, 'decay', 0.5));
  app.store.apply('Tempo', (p) => ({ ...p, bpm: 150 }));
  ready.mockReturnValue(true);
  pending.resolve();
  await pending.promise;
  expect(noteOn).toHaveBeenCalledExactlyOnceWith(id, 48, 0.8);
  app.store.apply('Decay', (p) => E.setChannelParam(p, id, 'decay', 0.7));
  expect(noteOff).not.toHaveBeenCalled();
  expect(keys.querySelector('[data-key="48"]').classList.contains('down')).toBe(true);
  pointer('pointerup');
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 48);
});

it.each(['two pointers', 'two keys', 'pointer and key'].flatMap((input) => [false, true].map((pending) => [input, pending])))('keeps a shared pitch held by %s until the final release (startup pending: %s)', async (input, pending) => {
  const { app, win, id, keys, ready, noteOn, noteOff, pointer, press } = setup();
  const starting = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(starting.promise);
  ready.mockReturnValue(!pending);
  const key = (type, code) => win.el.querySelector('.ch-editor').dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  if (input === 'two keys') { key('keydown', 'KeyQ'); key('keydown', 'Comma'); }
  else {
    press(60, 1);
    if (input === 'two pointers') press(60, 2);
    else key('keydown', 'KeyQ');
  }
  if (input === 'two keys') key('keyup', 'KeyQ');
  else pointer('pointerup', 1);
  expect(noteOff).not.toHaveBeenCalled();
  expect(keys.querySelector('[data-key="60"]').classList.contains('down')).toBe(true);
  ready.mockReturnValue(true);
  starting.resolve();
  await starting.promise;
  expect(noteOn).toHaveBeenCalledExactlyOnceWith(id, 60, 0.8);
  if (input === 'two keys') key('keyup', 'Comma');
  else if (input === 'two pointers') pointer('pointerup', 2);
  else key('keyup', 'KeyQ');
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 60);
  expect(keys.querySelector('.down')).toBeNull();
});

it('keeps a shared pitch sounding when one finger glides to another key', () => {
  const { id, keys, noteOn, noteOff, pointer, press, hit } = setup();
  press(60, 1);
  press(60, 2);
  hit(62);
  pointer('pointermove', 1);
  expect(noteOff).not.toHaveBeenCalled();
  expect(noteOn.mock.calls).toEqual([[id, 60, 0.8], [id, 62, 0.8]]);
  expect(keys.querySelector('[data-key="60"]').classList.contains('down')).toBe(true);
  pointer('pointerup', 1);
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 62);
  pointer('pointerup', 2);
  expect(noteOff.mock.calls).toEqual([[id, 62], [id, 60]]);
  press(60, 3);
  expect(noteOn).toHaveBeenCalledTimes(3);
  pointer('pointerup', 3);
});

it.each(['ctrlKey', 'metaKey', 'altKey', 'name input', 'toolbar'].flatMap((target) => [false, true].map((pending) => [target, pending])))('releases an owned computer key after changing %s (startup pending: %s)', async (target, pending) => {
  const { app, win, id, keys, ready, noteOn, noteOff } = setup();
  const starting = deferred();
  vi.spyOn(app.engine, 'start').mockReturnValue(starting.promise);
  ready.mockReturnValue(!pending);
  const editor = win.el.querySelector('.ch-editor');
  editor.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', bubbles: true, cancelable: true }));
  let releaseTarget = editor;
  const modifiers = {};
  if (target === 'name input') releaseTarget = win.el.querySelector('[aria-label="Channel name"]');
  else if (target === 'toolbar') releaseTarget = win.el.querySelector('[aria-label="Save preset"]');
  else modifiers[target] = true;
  releaseTarget.focus();
  releaseTarget.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', bubbles: true, cancelable: true, ...modifiers }));
  expect(noteOff).toHaveBeenCalledExactlyOnceWith(id, 48);
  expect(keys.querySelector('.down')).toBeNull();
  starting.resolve();
  await starting.promise;
  expect(noteOn).toHaveBeenCalledTimes(pending ? 0 : 1);
  ready.mockReturnValue(true);
  editor.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', bubbles: true }));
  expect(noteOn).toHaveBeenLastCalledWith(id, 48, 0.8);
  expect(noteOff).toHaveBeenCalledTimes(2);
});

it('preserves typing and shortcuts that did not start an audition', () => {
  const { win, noteOn, noteOff } = setup();
  const editor = win.el.querySelector('.ch-editor');
  const input = win.el.querySelector('[aria-label="Channel name"]');
  for (const [target, modifiers] of [[input, {}], [editor, { ctrlKey: true }], [editor, { metaKey: true }], [editor, { altKey: true }]]) {
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, { code: 'KeyZ', bubbles: true, cancelable: true, ...modifiers });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(noteOn).not.toHaveBeenCalled();
  expect(noteOff).not.toHaveBeenCalled();
});
