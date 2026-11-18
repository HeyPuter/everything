import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { parseWav } from '../src/audio/wav.js';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  return app;
}
function session(app, name = 'Song') {
  const doc = app.addDocument(new Session({ name: `${name}.asesx`, sampleRate: 8000, tracks: 1, source: { type: 'puter', path: `/u/${name}.asesx` } }));
  const clips = [0.25, -0.5].map((value) => {
    const sourceId = doc.addSource({ name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
    return createClip({ trackId: doc.state.tracks[0].id, sourceId, start: 0, length: 32 });
  });
  doc.apply('Insert', addClips(doc.state, clips));
  return { doc, clips };
}
function storage(outcome = 'saved') {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const stored = new Map();
  const calls = [];
  const write = vi.fn(async (path, blob) => {
    calls.push(path);
    if (calls.length === 1) {
      await wait;
      if (outcome === 'failed') throw new Error('Upload failed');
    }
    stored.set(path, blob);
    return {};
  });
  window.puter = { auth: { isSignedIn: () => true }, fs: { write } };
  return { release, stored, calls };
}

it.each(['saved', 'failed'])('keeps the latest cloud save after an older upload is %s', async (outcome) => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage(outcome);
  const first = app.commands.run('file.save');
  await vi.waitFor(() => expect(cloud.calls).toHaveLength(1), { interval: 1 });
  doc.selectClips([clips[0].id]);
  await app.commands.run('edit.delete');
  const latest = doc.state;
  expect(latest.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  const second = app.commands.run('file.save');
  // All SDK operations except the gated first upload resolve immediately.
  // Let their microtasks drain without assuming how many awaits save performs.
  await setImmediate();
  cloud.release();
  await Promise.all([first, second]);
  const manifest = JSON.parse(await cloud.stored.get('/u/Song.asesx').text());
  expect(manifest.session.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  const media = manifest.sources.find((src) => src.id === clips[1].sourceId);
  const wav = parseWav(await cloud.stored.get(`/u/${media.file}`).arrayBuffer());
  expect([...wav.channels[0]]).toEqual(Array(32).fill(-0.5));
  expect(doc.state === latest).toBe(true);
  expect(doc.savedState === latest).toBe(true);
  expect(doc.dirty).toBe(false);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  // The cache must describe the last writer: an unchanged save skips its media.
  const before = cloud.calls.length;
  await app.commands.run('file.save');
  expect(cloud.calls.slice(before)).toEqual(['/u/Song.asesx']);
});

it('lets an unrelated session save while another session upload is pending', async () => {
  const app = setup();
  const firstDoc = session(app, 'First').doc;
  const cloud = storage();
  const first = app.commands.run('file.save');
  await vi.waitFor(() => expect(cloud.calls).toHaveLength(1), { interval: 1 });
  const otherDoc = session(app, 'Other').doc;
  const second = app.commands.run('file.save');
  await second;
  expect(cloud.stored.has('/u/Other.asesx')).toBe(true);
  expect(otherDoc.dirty).toBe(false);
  cloud.release();
  await first;
  expect(cloud.stored.has('/u/First.asesx')).toBe(true);
  expect(firstDoc.dirty).toBe(false);
  expect(app.active === otherDoc).toBe(true);
});
