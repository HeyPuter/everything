import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { updateTrack } from '../src/model/session-edits.js';
import { setVideoClip, videoPool } from '../src/model/session-video.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { INSERT_HOOKS } from '../src/multitrack/insert.js';
import { insertVideoHook, linkVideo, setVideoOfDoc } from '../src/video/media.js';
import { announce } from '../src/lib/dom.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
vi.mock('../src/lib/dom.js', async (original) => ({ ...(await original()), announce: vi.fn() }));
let hooks;
let processor;
beforeEach(async () => {
  localStorage.clear();
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  processor = await dsp();
  gate.calls = 0;
  hooks = INSERT_HOOKS.slice();
  INSERT_HOOKS.splice(0, INSERT_HOOKS.length, insertVideoHook);
  announce.mockClear();
});
afterEach(() => { INSERT_HOOKS.splice(0, INSERT_HOOKS.length, ...hooks); vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(['conversion', 'replacement'].flatMap((phase) => ['close', 'switch', 'cancel close'].map((action) => [phase, action])))('handles a session %s wait followed by %s', async (phase, action) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const rate = phase === 'conversion' ? 16000 : 8000;
  const pcm = new Float32Array(32).fill(0.25);
  const source = app.addDocument(new AudioFile({ name: 'Source.wav', sampleRate: rate, channels: [Channel.fromSamples(pcm)] }));
  const target = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: 8000, tracks: 1 }));
  const other = app.addDocument(new AudioFile({ name: 'Other.wav', sampleRate: 8000, channels: [Channel.silence(32)] }));
  if (phase === 'replacement') {
    const info = (name) => ({ name, blob: new Blob([name]), width: 16, height: 16, duration: 0.004, fps: 25 });
    target.apply('Video', setVideoClip(target.state, { sourceId: linkVideo(target, info('Old.webm')), name: 'Old', length: 32 }));
    target.markSaved();
    setVideoOfDoc(source, info('New.webm'));
  }
  if (action === 'cancel close') target.apply('Volume', updateTrack(target.state, target.state.tracks[0].id, { volume: -3 }));
  const before = target.state;
  const history = target.history.entries.slice();
  const videos = videoPool(target).size;
  const sourceState = source.state;
  app.activate(target);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  if (phase === 'conversion') gate.wait = wait;
  const inserting = app.commands.run('mt.insertFiles', { docs: [source] });
  try {
    await vi.waitFor(() => expect(phase === 'conversion' ? gate.calls > 0 : Boolean(document.querySelector('[role=dialog]'))).toBe(true), { interval: 1 });
    if (action === 'close') expect(await app.closeDocument(target)).toBe(true);
    else if (action === 'cancel close') {
      const closing = app.closeDocument(target);
      await vi.waitFor(() => expect(document.querySelector('.dialog-foot button[data-value="save"]')).not.toBeNull(), { interval: 1 });
      document.querySelector('.dialog-foot button[data-value="save"]').closest('[role=dialog]').querySelector('button[data-value="null"]').click();
      expect(await closing).toBe(false);
    }
    app.activate(other);
    release();
    if (phase === 'replacement') [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click();
    const result = await inserting;
    expect(app.active).toBe(other);
    expect(source.state).toBe(sourceState);
    expect(app.documents).toContain(source);
    if (action === 'close') {
      expect(target.state).toBe(before);
      expect(target.history.entries).toEqual(history);
      expect(target.dirty).toBe(false);
      expect(videoPool(target).size).toBe(videos);
      expect(app.documents).not.toContain(target);
      expect(result).toEqual([]);
      expect(announce).not.toHaveBeenCalled();
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('closed'), { error: true });
    } else {
      expect(result).toHaveLength(1);
      const clip = target.state.clips.find((c) => c.id === result[0]);
      const expected = phase === 'conversion' ? processor.resample(pcm, rate, 8000) : pcm;
      expect([...target.pool.get(clip.sourceId).channels[0].toArray()]).toEqual([...expected]);
      expect(clip.length).toBe(expected.length);
      if (phase === 'replacement') expect(target.state.video.name).toBe('New');
      app.activate(target);
      await app.commands.run('edit.undo');
      expect(target.state).toBe(before);
      expect(app.notify).not.toHaveBeenCalled();
    }
  } finally {
    release();
    const replace = [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace');
    replace?.click();
    await inserting;
  }
});
