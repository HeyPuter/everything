import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { sessionSaveDialog } from '../src/multitrack/save-dialog.js';
import { sessionSaveForm } from './helpers/session-save.js';

beforeEach(() => localStorage.clear());
afterEach(() => { delete window.puter; document.body.replaceChildren(); vi.restoreAllMocks(); });
const missing = () => { throw { code: 'subject_does_not_exist' }; };
function setup(source = { type: 'puter', path: '/u/Song.asesx' }) {
  const app = new App();
  const doc = new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1, source });
  window.puter = { auth: { getUser: async () => ({ username: 'u' }) }, fs: { stat: vi.fn(missing), write: vi.fn() }, ui: { showSaveFilePicker: vi.fn() } };
  return { app, doc };
}
const field = (form, label) => form.querySelector(`[aria-label="${label}"]`);
const save = (form) => form.querySelector('.dialog-foot button[data-value="save"]').click();
const cancel = (form) => form.querySelector('.dialog-foot button[data-value="null"]').click();
const browse = (form) => [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...');

it('validates names and folders, confirms with Enter, and remembers the destination', async () => {
  const { app, doc } = setup();
  const state = doc.state;
  const pending = sessionSaveDialog(app, doc);
  const form = await sessionSaveForm();
  expect(document.activeElement).toBe(field(form, 'File name'));
  expect(field(form, 'File name').selectionEnd).toBe(4);
  field(form, 'File name').value = '.asesx';
  save(form);
  await setImmediate();
  expect(form.textContent).toContain('Enter a file name.');
  expect(window.puter.fs.stat).not.toHaveBeenCalled();
  field(form, 'File name').value = 'Mix?.ASESX';
  field(form, 'Puter folder').value = 'relative/folder';
  save(form);
  await setImmediate();
  expect(form.textContent).toContain('Enter a Puter folder path');
  expect(window.puter.fs.stat).not.toHaveBeenCalled();
  field(form, 'Puter folder').value = '/u/Projects/';
  field(form, 'File name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(await pending).toEqual({ name: 'Mix_.asesx', dir: '/u/Projects/', path: '/u/Projects/Mix_.asesx' });
  expect(app.prefs.get('sessionSaveFolder')).toBe('/u/Projects/');
  expect(window.puter.fs.write).not.toHaveBeenCalled();
  expect(window.puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
  expect(doc.state === state).toBe(true);
  expect(doc.source.path).toBe('/u/Song.asesx');
});

it('keeps the chosen destination editable after declining replacement', async () => {
  const { app, doc } = setup();
  window.puter.fs.stat.mockImplementation(async (path) => path.endsWith('/Song.asesx') ? {} : missing());
  const pending = sessionSaveDialog(app, doc, { copy: true });
  const form = await sessionSaveForm();
  save(form);
  await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2), { interval: 1 });
  const replace = document.querySelectorAll('[role="dialog"]')[1];
  expect(replace.textContent).toContain('Replace Session?');
  expect(window.puter.fs.write).not.toHaveBeenCalled();
  replace.querySelector('button[data-value="false"]').click();
  await setImmediate();
  expect(form.isConnected).toBe(true);
  expect(field(form, 'File name').disabled).toBe(false);
  expect(document.activeElement).toBe(field(form, 'File name'));
  expect(field(form, 'Puter folder').value).toBe('/u');
  field(form, 'File name').value = 'Other';
  save(form);
  expect(await pending).toEqual({ name: 'Other.asesx', dir: '/u', path: '/u/Other.asesx' });
});

it('cancels during a destination check without reopening a replacement prompt', async () => {
  const { app, doc } = setup();
  let release;
  window.puter.fs.stat.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const pending = sessionSaveDialog(app, doc);
  const form = await sessionSaveForm();
  save(form);
  expect(field(form, 'File name').disabled).toBe(true);
  expect(field(form, 'Puter folder').disabled).toBe(true);
  field(form, 'File name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(window.puter.fs.stat).toHaveBeenCalledOnce();
  cancel(form);
  expect(await pending).toBeNull();
  release({});
  await setImmediate();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(window.puter.fs.write).not.toHaveBeenCalled();
});

it('reports destination check failures and permits retry without writing', async () => {
  const { app, doc } = setup();
  window.puter.fs.stat.mockRejectedValueOnce(new Error('Offline'));
  const pending = sessionSaveDialog(app, doc);
  const form = await sessionSaveForm();
  save(form);
  await setImmediate();
  expect(form.querySelector('[role="alert"]').textContent).toContain('Offline');
  expect(field(form, 'File name').disabled).toBe(false);
  expect(window.puter.fs.write).not.toHaveBeenCalled();
  save(form);
  expect((await pending).path).toBe('/u/Song.asesx');
});

it.each(['cancelled', 'saved', 'failed'])('restores Browse after the folder picker is %s', async (outcome) => {
  const { app, doc } = setup();
  const pending = sessionSaveDialog(app, doc);
  const form = await sessionSaveForm();
  const primary = outcome === 'failed' ? Promise.reject(new Error('Picker failed')) : new Promise(() => {});
  primary.catch(() => {});
  primary.undefinedOnCancel = outcome === 'failed' ? new Promise(() => {}) : Promise.resolve(outcome === 'saved' ? { path: '/u/Selected' } : undefined);
  window.puter.ui.showDirectoryPicker = () => primary;
  browse(form).click();
  expect(browse(form).disabled).toBe(true);
  expect(form.querySelector('button[data-value="save"]').disabled).toBe(true);
  field(form, 'File name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(window.puter.fs.stat).not.toHaveBeenCalled();
  await setImmediate();
  expect(browse(form).disabled).toBe(false);
  expect(form.querySelector('button[data-value="save"]').disabled).toBe(false);
  expect(document.activeElement).toBe(browse(form));
  expect(field(form, 'Puter folder').value).toBe(outcome === 'saved' ? '/u/Selected' : '/u');
  if (outcome === 'failed') expect(form.querySelector('[role="alert"]').textContent).toBe('Picker failed');
  window.puter.ui.showDirectoryPicker = async () => ({ path: '/u/Retry' });
  browse(form).click();
  await setImmediate();
  expect(field(form, 'Puter folder').value).toBe('/u/Retry');
  cancel(form);
  expect(await pending).toBeNull();
  expect(window.puter.fs.write).not.toHaveBeenCalled();
});

it('ignores a folder picker returning after its dialog has closed', async () => {
  const { app, doc } = setup();
  let release;
  window.puter.ui.showDirectoryPicker = () => new Promise((resolve) => { release = resolve; });
  const pending = sessionSaveDialog(app, doc);
  const form = await sessionSaveForm();
  browse(form).click();
  cancel(form);
  expect(await pending).toBeNull();
  const next = sessionSaveDialog(app, doc);
  const nextForm = await sessionSaveForm();
  release({ path: '/u/Late' });
  await setImmediate();
  expect(field(nextForm, 'Puter folder').value).toBe('/u');
  expect(document.activeElement).toBe(field(nextForm, 'File name'));
  cancel(nextForm);
  await next;
});

it('starts a new session in the app folder and honors a remembered folder', async () => {
  const { app, doc } = setup({ type: 'new' });
  let pending = sessionSaveDialog(app, doc);
  let form = await sessionSaveForm();
  expect(field(form, 'Puter folder').value).toBe('/u/AudioStudio');
  cancel(form);
  await pending;
  app.prefs.set('sessionSaveFolder', '/u/Remembered');
  pending = sessionSaveDialog(app, doc);
  form = await sessionSaveForm();
  expect(field(form, 'Puter folder').value).toBe('/u/Remembered');
  cancel(form);
  await pending;
});
