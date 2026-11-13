import { afterEach, expect, it, vi } from 'vitest';
import { Emitter } from '../src/lib/emitter.js';
import { Prefs } from '../src/prefs.js';
import { installTaskbar } from '../src/features/artboards/taskbar.js';

let listeners;
afterEach(() => {
  for (const args of listeners?.mock.calls || []) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const editor = () => Object.assign(new Emitter(), { selection: new Set(), topSelection: () => [] });
function setup() {
  vi.useFakeTimers();
  const raf = vi.fn((callback) => setTimeout(callback, 0));
  vi.stubGlobal('requestAnimationFrame', raf);
  listeners = vi.spyOn(window, 'addEventListener');
  const root = document.createElement('div'), canvasHost = document.createElement('div'), taskbar = document.createElement('div');
  root.append(canvasHost, taskbar);
  document.body.append(root);
  const app = Object.assign(new Emitter(), { root, canvasHost, taskbar, editor: editor(), prefs: new Prefs(null),
    toolClasses: new Map(), commands: { get: () => null, register: vi.fn(), isEnabled: () => true } });
  installTaskbar(app);
  vi.advanceTimersByTime(0);
  expect(taskbar.hidden).toBe(false);
  return { app, raf, activate: (next) => { app.editor = next; app.emit('active-editor', next); vi.advanceTimersByTime(0); } };
}

it.each(['switch', 'close'])('cancels the outgoing view timer when documents %s', (action) => {
  const { app, raf, activate } = setup();
  const previous = app.editor;
  previous.emit('view');
  expect(app.taskbar.hidden).toBe(true);
  activate(action === 'close' ? null : editor());
  expect(app.taskbar.hidden).toBe(action === 'close');
  raf.mockClear();
  vi.advanceTimersByTime(200);
  expect(raf).not.toHaveBeenCalled();
  previous.emit('view');
  vi.advanceTimersByTime(200);
  expect(raf).not.toHaveBeenCalled();
});

it('does not invoke a delayed view callback after the last editor closes and animation globals disappear', () => {
  const { app, activate } = setup();
  app.editor.emit('view');
  activate(null);
  vi.stubGlobal('requestAnimationFrame', undefined);
  expect(() => vi.advanceTimersByTime(200)).not.toThrow();
});

it('does not carry a cancelled interaction hidden state into a newly active document', () => {
  const { app, activate } = setup();
  app.canvasHost.dispatchEvent(new Event('pointerdown'));
  expect(app.taskbar.hidden).toBe(true);
  activate(editor());
  expect(app.taskbar.hidden).toBe(false);
});

it('restores the taskbar after a pointer interaction is cancelled', () => {
  const { app } = setup();
  app.canvasHost.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new Event('pointercancel'));
  vi.advanceTimersByTime(61);
  expect(app.taskbar.hidden).toBe(false);
});

it('still restores the current taskbar after view changes and a completed pointer interaction', () => {
  const { app } = setup();
  app.editor.emit('view');
  vi.advanceTimersByTime(179);
  expect(app.taskbar.hidden).toBe(true);
  vi.advanceTimersByTime(2);
  expect(app.taskbar.hidden).toBe(false);
  app.canvasHost.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new Event('pointerup'));
  vi.advanceTimersByTime(59);
  expect(app.taskbar.hidden).toBe(true);
  vi.advanceTimersByTime(2);
  expect(app.taskbar.hidden).toBe(false);
});

it('does not schedule a delayed refresh after the taskbar is detached', () => {
  const { app, raf } = setup();
  app.editor.emit('view');
  app.root.remove();
  raf.mockClear();
  vi.advanceTimersByTime(200);
  expect(raf).not.toHaveBeenCalled();
});

it('skips an already queued frame after detachment and resumes when reattached', () => {
  const { app } = setup();
  app.taskbar.hidden = true;
  app.emit('chrome');
  app.root.remove();
  vi.advanceTimersByTime(0);
  expect(app.taskbar.hidden).toBe(true);
  document.body.append(app.root);
  app.emit('chrome');
  vi.advanceTimersByTime(0);
  expect(app.taskbar.hidden).toBe(false);
});
