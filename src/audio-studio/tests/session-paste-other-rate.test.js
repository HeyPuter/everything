// Pasting clips copied from a session at another sample rate: media resampled, frames conformed.
import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

beforeEach(async () => {
  localStorage.clear();
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
});
afterEach(() => vi.restoreAllMocks());

it('pastes clips from a 44.1 kHz session into a 48 kHz one at the right length and times', async () => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const source = new Session({ name: 'A.asesx', sampleRate: 44100, tracks: 1 });
  const target = new Session({ name: 'B.asesx', sampleRate: 48000, tracks: 1 });
  app.addDocument(source);
  app.addDocument(target);
  const tone = new Float32Array(44100).map((_, i) => Math.sin(i / 20) * 0.5);
  const src = source.addSource({ name: 'tone.wav', channels: [Channel.fromSamples(tone)] });
  source.apply('Insert', S.addClips(source.state, [S.createClip({
    trackId: source.state.tracks[0].id, sourceId: src, start: 4410, offset: 441, length: 22050,
    fadeIn: { length: 2205, curve: 0 }, volumeEnv: [{ t: 0, v: 0 }, { t: 11025, v: -6, hold: true }],
    fxEnv: { 'fx.s1.left': [{ t: 22050, v: 3 }] }, fx: [{ id: 's1', effect: 'amplify', values: {}, enabled: true }],
  })]));
  app.activate(source);
  source.selectClips([source.state.clips[0].id]);
  await app.commands.run('edit.copy');
  app.activate(target);
  target.setCursor(0);
  await app.commands.run('edit.paste');
  const [c] = target.state.clips;
  expect(c).toBeTruthy();
  expect(app.notify).not.toHaveBeenCalledWith(expect.stringMatching(/cannot be pasted/), expect.anything());
  expect([c.offset, c.length, c.fadeIn.length]).toEqual([480, 24000, 2400]);
  expect(c.volumeEnv).toEqual([{ t: 0, v: 0 }, { t: 12000, v: -6, hold: true }]);
  expect(c.fxEnv['fx.s1.left']).toEqual([{ t: 24000, v: 3 }]);
  const pasted = target.pool.get(c.sourceId);
  expect(pasted.channels[0].length).toBe(48000);
  expect(pasted.channelRate).toBe(48000);
  expect(target.history.undoLabel).toBe('Paste');
});
