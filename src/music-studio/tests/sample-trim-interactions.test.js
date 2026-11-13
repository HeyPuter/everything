import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { createChannel } from '../src/model/project.js';
import { newProject } from '../src/model/demo.js';
import { openChannelEditor } from '../src/rack/editor.js';
import { closeWindows } from '../src/ui/windows.js';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  closeWindows();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup(which = 'start') {
  const project = newProject();
  project.channels[0] = createChannel({ type: 'sampler', name: 'Sample', sample: 'audio', mixer: 1 });
  project.samples.audio = { id: 'audio', name: 'test.wav' };
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { project, storage: { getItem: () => null, setItem() {} } });
  const id = project.channels[0].id;
  const win = openChannelEditor(app, id);
  win.el.querySelector('[role="tab"]').click();
  const box = win.el.querySelector('.ed-wave');
  box.getBoundingClientRect = () => ({ left: 100, top: 0, width: 400, height: 72 });
  box.setPointerCapture = vi.fn();
  box.releasePointerCapture = vi.fn();
  const pointer = (type, fraction = which === 'start' ? 0.1 : 0.9, pointerId = 1) => {
    const event = new MouseEvent(type, { button: 0, clientX: 100 + fraction * 400, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    box.dispatchEvent(event);
  };
  return { app, store: app.store, win, box, id, pointer, value: () => app.store.project.channels[0].params[which] };
}

it.each(['start', 'end'].flatMap((which) => ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'close', 'hide'].map((end) => [which, end])))('finishes sample %s trimming on %s and ignores stale movement', (which, end) => {
  const { store, win, pointer, value } = setup(which);
  const before = store.project;
  pointer('pointerdown');
  pointer('pointermove', which === 'start' ? 0.2 : 0.8);
  expect(value()).toBe(which === 'start' ? 0.2 : 0.8);
  if (end === 'blur') window.dispatchEvent(new Event('blur'));
  else if (end === 'close') win.close();
  else if (end === 'hide') win.el.querySelectorAll('[role="tab"]')[1].click();
  else pointer(end);
  const finished = store.project;
  expect(Boolean(store.gesture)).toBe(false);
  expect(store.undoStack).toHaveLength(1);
  pointer('pointermove', 0.4);
  pointer('pointerup', 0.4);
  pointer('lostpointercapture', 0.4);
  expect(store.project === finished).toBe(true);
  expect(store.undoStack).toHaveLength(1);
  store.undo();
  expect(store.project === before).toBe(true);
  if (end !== 'close') {
    win.el.querySelector('[role="tab"]').click();
    pointer('pointerdown');
    pointer('pointermove', which === 'start' ? 0.2 : 0.8);
    pointer('pointerup');
    expect(value()).toBe(which === 'start' ? 0.2 : 0.8);
    store.undo();
    expect(store.project === before).toBe(true);
  }
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores a competing sample-trim pointer and its %s', (end) => {
  const { store, pointer, value } = setup();
  const before = store.project;
  pointer('pointerdown');
  pointer('pointermove', 0.2);
  pointer('pointerdown', 0.9, 2);
  pointer('pointermove', 0.6, 2);
  pointer(end, 0.6, 2);
  expect(value()).toBe(0.2);
  expect(store.project.channels[0].params.end).toBe(1);
  expect(Boolean(store.gesture)).toBe(true);
  pointer('pointermove', 0.3);
  pointer('pointerup', 0.3);
  expect(value()).toBe(0.3);
  expect(store.undoStack).toHaveLength(1);
  store.undo();
  expect(store.project === before).toBe(true);
});
