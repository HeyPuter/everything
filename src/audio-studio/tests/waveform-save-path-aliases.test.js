import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import { posix } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installIo } from '../src/features/io.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';
import { audioFileFromBlob } from '../src/storage/files.js';

const encoding = vi.hoisted(() => ({ jobs: [], fail: -1, pause: -1 }));
vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return { default: class {
    constructor() { this.index = encoding.jobs.length; encoding.jobs.push(this); }
    postMessage(message) {
      if (message.type === 'start') {
        this.job = message.job;
        queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
      } else if (message.type === 'chunk') {
        const writer = new WavWriter({ ...this.job.options, frames: this.job.frames });
        writer.write(message.channels, this.job.frames);
        const blob = writer.finish();
        this.finish = () => {
          this.delivered = true;
          this.onmessage({ data: this.index === encoding.fail ? { type: 'error', message: 'Encoding failed' } : { type: 'done', blob } });
        };
        if (this.index !== 0 && this.index !== encoding.pause) this.finish();
      }
    }
    terminate() { this.terminated = true; }
  } };
});
beforeEach(async () => {
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
  encoding.jobs = [];
  encoding.fail = -1;
  encoding.pause = -1;
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Keep the test inside the 250ms window before encoding progress becomes modal.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  delete window.puter;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  installCoreCommands(app);
  installIo(app);
  const doc = addDoc(app, 'Source.wav');
  const saved = new Map();
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { saved.set(path, blob); writes.push(path); return {}; } } };
  return { app, doc, saved, writes };
}
function addDoc(app, name) {
  return app.addDocument(new AudioFile({ name, sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))], info: { bitDepth: 32 }, source: { type: 'puter', path: `/u/${name}` } }));
}
async function ready(index) {
  await vi.waitFor(() => expect(typeof encoding.jobs[index]?.finish).toBe('function'), { interval: 1 });
}
async function samples(saved, path = '/u/Source.wav') {
  return [...parseWav(await saved.get(path).arrayBuffer()).channels[0]];
}


const pairs = [['~/Source.wav', '/u/Source.wav'], ['/u/Source.wav', '~/Source.wav'], ['/u/Folder/../Source.wav', '/u/Source.wav']];
const canonical = (path) => posix.normalize(path.replace(/^~(?=\/|$)/, '/u'));
it.each(pairs.flatMap(([a, b]) => ['saved', 'encode-failed', 'upload-failed', 'cancelled', 'middle-failed', 'middle-cancelled'].map((outcome) => [a, b, outcome])))('orders %s and %s when the earlier operation is %s', async (firstPath, secondPath, outcome) => {
  const { app, doc, saved, writes } = setup();
  doc.source.path = firstPath;
  window.puter.auth.getUser = async () => ({ username: 'u' });
  window.puter.fs.write = async (path, blob) => {
    if (path === firstPath && outcome === 'upload-failed') throw new Error('Upload failed');
    saved.set(canonical(path), blob); writes.push(path); return { path: canonical(path) };
  };
  if (outcome === 'encode-failed') encoding.fail = 0;
  const first = app.commands.run('file.save');
  await ready(0);
  const original = doc.state;
  const other = addDoc(app, 'Source.wav'); other.source.path = secondPath;
  await app.commands.run('fx.invert');
  const latest = other.state;
  if (outcome === 'middle-failed') {
    encoding.fail = 1;
    await app.commands.run('file.save');
  }
  if (outcome === 'middle-cancelled') {
    encoding.pause = 1;
    const middle = app.commands.run('file.save'); await ready(1);
    await vi.advanceTimersByTimeAsync(250);
    [...document.querySelectorAll('.io-progress-dialog .dialog-foot button[data-value="cancel"]')].at(-1).click();
    expect(await middle).toBe(false);
  }
  const second = app.commands.run('file.save');
  await ready(outcome.startsWith('middle-') ? 2 : 1);
  try {
    await setImmediate();
    const independent = addDoc(app, 'Source.wav'); independent.source.path = '/v/Source.wav';
    await app.commands.run('file.save');
    expect(independent.dirty).toBe(false);
    expect(await samples(saved, '/v/Source.wav')).toEqual(Array(32).fill(0.25));
    if (outcome === 'cancelled') {
      await vi.advanceTimersByTimeAsync(250);
      document.querySelector('.io-progress-dialog .dialog-foot button[data-value="cancel"]').click();
    } else encoding.jobs[0].finish();
    await Promise.all([first, second]);
    expect.soft(await samples(saved)).toEqual(Array(32).fill(-0.25));
    expect.soft(doc.dirty).toBe(true);
    expect.soft([...doc.savedState.channels[0].toArray()]).toEqual(Array(32).fill(-0.25));
    expect(doc.state).toBe(original); expect(other.state).toBe(latest); expect(other.dirty).toBe(false);
    expect(app.active).toBe(independent);
    expect(app.notify).toHaveBeenCalledTimes(outcome.endsWith('failed') ? 1 : 0);
    app.activate(doc);
    // Exercise actual Revert, followed by Undo/Redo and a normal Save.
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click(); await reverting;
    expect([...doc.state.channels[0].toArray()]).toEqual(Array(32).fill(-0.25));
    expect(doc.dirty).toBe(false);
    await app.commands.run('edit.undo'); expect(doc.state).toBe(original); expect(doc.dirty).toBe(true);
    await app.commands.run('edit.redo'); expect(doc.dirty).toBe(false);
    if (outcome !== 'upload-failed') { await app.commands.run('file.save'); expect(await samples(saved)).toEqual(Array(32).fill(-0.25)); }
  } finally { if (!encoding.jobs[0].delivered && !encoding.jobs[0].terminated) encoding.jobs[0].finish(); await Promise.all([first, second]); }
});

it.each([...pairs.slice(0, 2).map(([a, b]) => [a, b, false]), ['/u/Source.wav', '~/Source.wav', true]])('updates a late-opened waveform alias %s / %s after account lookup fails (pending Revert: %s)', async (firstPath, secondPath, pendingRevert) => {
  const { app, doc, saved } = setup(); doc.source.path = firstPath;
  let hold = false, waiting = false, release, failLookup = false;
  const wait = new Promise((resolve) => { release = resolve; });
  window.puter.auth.getUser = async () => { if (failLookup) throw new Error('Lookup unavailable'); return { username: 'u' }; };
  window.puter.fs.write = async (path, blob) => {
    if (hold) { waiting = true; await wait; }
    saved.set(canonical(path), blob); return { path: canonical(path) };
  };
  const initial = app.commands.run('file.save'); await ready(0); encoding.jobs[0].finish(); await initial;
  const originalBlob = saved.get('/u/Source.wav');
  await app.commands.run('fx.invert'); const latest = doc.state;
  hold = true;
  const saving = app.commands.run('file.save');
  await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
  try {
    const alias = app.addDocument(await audioFileFromBlob(originalBlob, 'Source.wav', { type: 'puter', path: secondPath }));
    let reverting;
    if (pendingRevert) {
      await app.commands.run('fx.invert');
      reverting = app.commands.run('file.revert');
      await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    }
    const original = alias.state;
    failLookup = true; release(); await saving;
    expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
    expect(doc.state).toBe(latest); expect(doc.dirty).toBe(false);
    expect.soft(alias.dirty).toBe(true); expect(alias.state).toBe(original);
    if (pendingRevert) {
      [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click(); await reverting;
      expect(alias.state).toBe(original);
    }
    if (secondPath.startsWith('~')) {
      expect(alias.savedStateKnown).toBe(false);
      expect(app.commands.isEnabled('file.revert')).toBe(false);
      expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/saved.*could not verify/i), { error: true });
      await app.commands.run('fx.invert'); await app.commands.run('edit.undo'); expect(alias.dirty).toBe(true);
      hold = false; failLookup = false;
      await app.commands.run('file.save'); expect(alias.dirty).toBe(false); expect(doc.dirty).toBe(true);
    } else {
      expect([...alias.savedState.channels[0].toArray()]).toEqual(Array(32).fill(-0.25));
      expect(app.commands.isEnabled('file.revert')).toBe(true);
      expect(app.notify).not.toHaveBeenCalled();
    }
  } finally { release(); await saving; }
});

it.each(pairs.flatMap(([a, b]) => ['upload', ...(a.includes('~') || b.includes('~') ? ['lookup'] : [])].flatMap((phase) => ['saved', 'failed'].map((outcome) => [a, b, phase, outcome]))))('reserves %s / %s before a delayed %s (%s)', async (firstPath, secondPath, phase, outcome) => {
  const { app, doc, saved } = setup(); doc.source.path = firstPath;
  const other = addDoc(app, 'Source.wav'); other.source.path = secondPath;
  await app.commands.run('fx.invert'); app.activate(doc);
  let waiting = false, release, holdLookup = phase === 'lookup';
  const wait = new Promise((resolve) => { release = resolve; });
  window.puter.auth.getUser = async () => {
    if (holdLookup) { holdLookup = false; waiting = true; await wait; if (outcome === 'failed') throw new Error('Lookup failed'); }
    return { username: 'u' };
  };
  window.puter.fs.write = async (path, blob) => {
    if (phase === 'upload' && path === firstPath) { waiting = true; await wait; if (outcome === 'failed') throw new Error('Upload failed'); }
    saved.set(canonical(path), blob); return { path: canonical(path) };
  };
  const first = app.commands.run('file.save'); await ready(0); encoding.jobs[0].finish();
  await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
  app.activate(other); const second = app.commands.run('file.save'); await ready(1);
  try {
    const independent = addDoc(app, 'Source.wav'); independent.source.path = '/v/Source.wav';
    await app.commands.run('file.save'); expect(independent.dirty).toBe(false);
    release(); await Promise.all([first, second]);
    expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
    expect(doc.dirty).toBe(true); expect(other.dirty).toBe(false);
    expect([...doc.savedState.channels[0].toArray()]).toEqual(Array(32).fill(-0.25));
    expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  } finally { release(); await Promise.all([first, second]); }
});

it.each(pairs.slice(0, 2).flatMap(([a, b]) => ['saveAs', 'saveCopy', 'exportFile', 'saveSelectionAs'].map((command) => [a, b, command])))('recognizes the own-file alias %s / %s in %s', async (firstPath, secondPath, command) => {
  const { app, doc, saved } = setup(); doc.source.path = firstPath;
  const folder = posix.dirname(secondPath);
  window.puter.auth.getUser = async () => ({ username: 'u' });
  window.puter.ui = { showDirectoryPicker: async () => ({ path: folder }) };
  window.puter.fs.stat = async (path) => { if (saved.has(canonical(path))) return { path: canonical(path) }; throw { code: 'subject_does_not_exist' }; };
  window.puter.fs.write = async (path, blob) => { saved.set(canonical(path), blob); return { path: canonical(path) }; };
  const initial = app.commands.run('file.save'); await ready(0); encoding.jobs[0].finish(); await initial;
  await app.commands.run('fx.invert'); const changed = doc.state;
  doc.setSelection(8, 24);
  const pending = app.commands.run(`file.${command}`);
  await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
  const form = document.querySelector('.io-export-dialog');
  const nameInput = form.querySelector('[aria-label="File name"]'); nameInput.value = 'Source.wav'; nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click();
  await vi.waitFor(() => expect(form.querySelector('.io-path').textContent).toBe(folder), { interval: 1 });
  form.querySelector('.dialog-foot button[data-value="ok"]').click();
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Replace')).toBe(true), { interval: 1 });
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click(); await pending;
  const partial = command === 'saveSelectionAs', output = Array(partial ? 16 : 32).fill(-0.25);
  expect(await samples(saved)).toEqual(output);
  expect.soft([...doc.savedState.channels[0].toArray()]).toEqual(output);
  expect(doc.state).toBe(changed); expect(doc.source.path).toBe(command === 'saveAs' ? secondPath : firstPath);
  expect.soft(doc.dirty).toBe(partial);
  await app.commands.run('edit.undo'); expect(doc.dirty).toBe(true);
  await app.commands.run('edit.redo'); expect(doc.dirty).toBe(partial);
  if (partial) {
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click(); await reverting;
    expect([...doc.state.channels[0].toArray()]).toEqual(output); expect(doc.dirty).toBe(false);
  }
  await app.commands.run('file.save'); expect(await samples(saved)).toEqual(output);
  expect(app.notify).not.toHaveBeenCalled();
});
