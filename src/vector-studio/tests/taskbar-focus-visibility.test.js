import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';

let app, listeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = await bootAppWithFeatures();
  app.newDocument();
  vi.advanceTimersByTime(20);
  app.taskbar.querySelector('[aria-label="More options"]').focus();
  expect(app.taskbar.hidden).toBe(false);
  expect(app.taskbar.contains(document.activeElement)).toBe(true);
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each([true, false])('hides the focused task bar when the last document closes (start screen: %s)', async (showStartScreen) => {
  app.prefs.set('showStartScreen', showStartScreen);
  await app.closeDocument(app.editor, { force: true });
  vi.advanceTimersByTime(20);
  expect(app.editor).toBeNull();
  expect(app.taskbar.hidden).toBe(true);
  expect(app.taskbar.contains(document.activeElement)).toBe(false);
  expect(showStartScreen ? app.home.contains(document.activeElement) : document.activeElement === app.root.querySelector('.home-btn')).toBe(true);
});

it('honors Hide Task Bar while one of its buttons has keyboard focus', () => {
  app.commands.run('window.contextualTaskbar');
  vi.advanceTimersByTime(20);
  expect(app.taskbar.hidden).toBe(true);
  expect(document.activeElement).toBe(app.canvasHost);
  app.commands.run('window.contextualTaskbar');
  vi.advanceTimersByTime(20);
  expect(app.taskbar.hidden).toBe(false);
});

it.each([true, false])('hides on Home without retaining canvas actions (task bar focused: %s)', (focused) => {
  if (!focused) app.canvasHost.focus();
  app.showHome();
  vi.advanceTimersByTime(20);
  expect(app.taskbar.hidden).toBe(true);
  if (focused) expect(app.home.contains(document.activeElement)).toBe(true);
});

it('can leave a pending font-size input safely after its document closes', async () => {
  const editor = app.editor;
  const text = createText('Example', 10, 10);
  editor.doc.transact('Text', () => editor.doc.insert(text, editor.targetLayer().id));
  editor.select([text.id]);
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  input.focus();
  input.value = '48';
  const errors = [];
  const onError = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    await app.closeDocument(editor, { force: true });
    vi.advanceTimersByTime(20);
    app.canvasHost.focus();
    expect(errors).toEqual([]);
    expect(app.taskbar.hidden).toBe(true);
  } finally { window.removeEventListener('error', onError); }
});

it('keeps keyboard focus in the task bar during temporary view suppression', () => {
  const focused = document.activeElement;
  app.editor.emit('view');
  vi.advanceTimersByTime(200);
  expect(app.taskbar.hidden).toBe(false);
  expect(document.activeElement).toBe(focused);
});

it('keeps a focused task bar usable when closing one of several documents', async () => {
  const outgoing = app.editor;
  app.newDocument();
  app.activate(outgoing);
  vi.advanceTimersByTime(20);
  app.taskbar.querySelector('[aria-label="More options"]').focus();
  await app.closeDocument(outgoing, { force: true });
  vi.advanceTimersByTime(20);
  expect(app.editor).not.toBeNull();
  expect(app.taskbar.hidden).toBe(false);
  expect(app.taskbar.contains(document.activeElement)).toBe(true);
});

it('does not move focus elsewhere when an unfocused task bar becomes unavailable', async () => {
  const home = app.root.querySelector('.home-btn');
  home.focus();
  await app.closeDocument(app.editor, { force: true });
  vi.advanceTimersByTime(20);
  expect(app.taskbar.hidden).toBe(true);
  expect(document.activeElement).toBe(home);
});

it.each(['artboard', 'hidden panels'])('releases task bar focus when its context changes to %s', (mode) => {
  if (mode === 'artboard') app.setTool('artboard');
  else { app.root.classList.add('hide-panels'); app.refreshChrome(); }
  vi.advanceTimersByTime(20);
  expect(app.taskbar.hidden).toBe(true);
  expect(document.activeElement).toBe(app.canvasHost);
});

it('commits an ordinary font-size edit when hiding the bar in an open document', () => {
  const editor = app.editor;
  const text = createText('Example', 10, 10);
  editor.doc.transact('Text', () => editor.doc.insert(text, editor.targetLayer().id));
  editor.select([text.id]);
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  input.focus();
  input.value = '48';
  app.commands.run('window.contextualTaskbar');
  vi.advanceTimersByTime(20);
  expect(editor.doc.get(text.id).char.fontSize).toBe(48);
  expect(app.taskbar.hidden).toBe(true);
});
