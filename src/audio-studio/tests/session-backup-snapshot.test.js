import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';
import { addClips, createClip, updateTrack } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { SessionBackupStore, installSessionBackup } from '../src/storage/session-backup.js';
import { MemDir } from './helpers/mem-opfs.js';
import { confirmSessionSave } from './helpers/session-save.js';

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
});
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function session(app, name, sampleRate, value) {
  const doc = app.addDocument(new Session({ name: `${name}.asesx`, sampleRate, tracks: 1, source: { type: 'puter', path: `/u/${name}.asesx` } }));
  for (let i = 0; i < 2; i++) {
    const sourceId = doc.addSource({ name: `Take ${i}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(value / (i + 1)))] });
    doc.apply('Insert', addClips(doc.state, [createClip({ sourceId, trackId: doc.state.tracks[0].id, start: i * 32, length: 32 })]));
  }
  return doc;
}

it.each([[8000, 16000, 1], [8000, 16000, 2], [16000, 8000, 1], [16000, 8000, 2]])('preserves a %s Hz backup when Revert switches to %s Hz during media check %s', async (originalRate, replacementRate, heldCheck) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const target = session(app, 'Target', originalRate, 0.25);
  await app.commands.run('file.save');
  const writer = session(app, 'Other', replacementRate, -0.5);
  await app.commands.run('file.save');
  app.activate(target);
  target.apply('Volume', updateTrack(target.state, target.state.tracks[0].id, { volume: -3 }));
  const original = target.state;
  const root = new MemDir();
  const store = new SessionBackupStore(async () => root);
  let time = Date.now();
  const ctl = installSessionBackup(app, { store, tab: 'test', now: () => time++ });
  const hasMedia = store.hasMedia.bind(store);
  let checks = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  store.hasMedia = async (key) => { if (++checks === heldCheck) await gate; return hasMedia(key); };
  const backingUp = ctl.run();
  try {
    await vi.waitFor(() => expect(checks).toBe(heldCheck), { interval: 1 });
    app.activate(writer);
    const copying = app.commands.run('file.saveCopy');
    await confirmSessionSave('Target.asesx', { replace: true });
    await copying;
    app.activate(target);
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click();
    await reverting;
    expect(target.sampleRate).toBe(replacementRate);
    release();
    await backingUp;
    const [first] = await ctl.list();
    expect(JSON.parse(first.text).session.sampleRate).toBe(originalRate);
    for (const [i, entry] of first.media.entries()) {
      const wav = parseWav(await (await store.readMedia(entry.key)).arrayBuffer());
      expect.soft(wav.sampleRate).toBe(originalRate);
      expect([...wav.channels[0]]).toEqual(Array(32).fill(0.25 / (i + 1)));
    }
    await ctl.run();
    const [second] = await ctl.list();
    expect(JSON.parse(second.text).session.sampleRate).toBe(replacementRate);
    await app.commands.run('edit.undo');
    expect(target.state).toBe(original);
    await ctl.run();
    const list = await ctl.list();
    expect(list).toHaveLength(3);
    expect(list[0].media).toEqual(first.media);
    ctl.destroy();
    for (const [manifest, rate, value] of [[first, originalRate, 0.25], [second, replacementRate, -0.5]]) {
      const restored = await ctl.restore(manifest);
      expect(restored.sampleRate).toBe(rate);
      expect(restored.length).toBe(64);
      for (const [i, clip] of restored.state.clips.entries()) {
        expect.soft([...restored.pool.get(clip.sourceId).channels[0].toArray()]).toEqual(Array(32).fill(value / (i + 1)));
      }
    }
    expect(target.state).toBe(original);
    expect(app.notify).not.toHaveBeenCalled();
  } finally {
    release();
    await backingUp;
    ctl.destroy();
  }
});
