import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { openChannelEditor } from '../src/rack/editor.js';
import { closeWindows } from '../src/ui/windows.js';

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
