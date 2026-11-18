import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { serializeSession } from '../src/model/session-io.js';
import { sessionFromText } from '../src/multitrack/storage.js';
import { encodeWav, parseWav } from '../src/audio/wav.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { syncLinkedSources } from '../src/multitrack/insert.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
});
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const values = { main: 0.25, stretch: 0.125, remix: 0.375, duration: 0.5 };
const refs = (clips) => [clips[0].sourceId, clips[0].stretch.sourceId, clips[1].remix.sourceId, clips[0].soundAssistant.duration.orig.sourceId];

async function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  app.on('doc-change', (doc, e) => { if (doc.kind === 'audio' && (e.kind === 'edit' || e.kind === 'history')) syncLinkedSources(app, doc); });
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { stored.set(path, blob); return { path }; } } };
  const load = async (name, sign) => {
    const template = new Session({ name: `${name}.asesx`, sampleRate: 8000, tracks: 1 });
    for (const [id, value] of Object.entries(values)) template.addSource({ id, name: `${id}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(sign * value))] });
    const base = { sourceId: 'main', trackId: template.state.tracks[0].id, length: 32 };
    template.apply('Insert', addClips(template.state, [
      createClip({ ...base, name: 'Stretched', stretch: { sourceId: 'stretch', mode: 'rendered', ratio: 2 }, soundAssistant: { duration: { on: true, orig: { sourceId: 'duration', offset: 0, length: 32 } } } }),
      createClip({ ...base, name: 'Remixed', start: 32, remix: { sourceId: 'remix', offset: 0, length: 32, segments: [[0, 32]], target: 32, xfade: 0 } }),
    ]));
    const data = serializeSession(template);
    stored.set(`/u/${name}.asesx`, new Blob([data.text]));
    for (const media of data.media) stored.set(`/u/${media.file}`, encodeWav({ channels: media.channels, sampleRate: media.sampleRate, bitDepth: 32, float: true }));
    const doc = await sessionFromText(app, data.text, `${name}.asesx`, { type: 'puter', path: `/u/${name}.asesx` }, (src) => stored.get(`/u/${src.file}`));
    app.addDocument(doc);
    return doc;
  };
  const source = await load('Source', 1);
  const target = await load('Target', -1);
  return { app, source, target, stored };
}

it.each(['copy', 'cut'])('preserves copied audio and auxiliary sources when %s and paste crosses colliding loaded source IDs', async (command) => {
  const { app, source, target, stored } = await setup();
  const original = target.state;
  const originalSources = new Map(target.pool);
  app.activate(source);
  source.selectClips(source.state.clips.map((c) => c.id));
  await app.commands.run(`edit.${command}`);
  app.activate(target);
  target.setCursor(64);
  await app.commands.run('edit.paste');
  const pasted = target.clipSelection;
  expect(pasted).toHaveLength(2);
  const mapped = refs(pasted);
  for (const [i, [id, value]] of Object.entries(values).entries()) {
    expect.soft([...target.pool.get(mapped[i]).channels[0].toArray()]).toEqual(Array(32).fill(value));
    expect(target.pool.get(id)).toBe(originalSources.get(id));
    expect([...target.pool.get(id).channels[0].toArray()]).toEqual(Array(32).fill(-value));
    expect.soft(target.pool.get(mapped[i]).docId).toBe(source.pool.get(id).docId);
  }
  const pastedState = target.state;
  await app.commands.run('edit.undo');
  expect(target.state).toBe(original);
  expect(target.dirty).toBe(false);
  await app.commands.run('edit.redo');
  expect(target.state).toBe(pastedState);
  const size = target.pool.size;
  target.setCursor(128);
  await app.commands.run('edit.paste');
  expect(refs(target.clipSelection)).toEqual(mapped);
  expect(target.pool.size).toBe(size);
  await app.commands.run('file.save');
  const data = JSON.parse(await stored.get('/u/Target.asesx').text());
  for (const [i, value] of Object.values(values).entries()) {
    const media = data.sources.find((m) => m.id === mapped[i]);
    expect.soft([...parseWav(await stored.get(`/u/${media.file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(value));
  }
  expect(target.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it('keeps pasted waveform links live and reuses them after edits and fresh copies', async () => {
  const { app, source, target } = await setup();
  const targetOriginal = target.pool.get('main');
  app.activate(source);
  source.selectClips(source.state.clips.map((c) => c.id));
  await app.commands.run('edit.copy');
  app.activate(target);
  target.setCursor(64);
  await app.commands.run('edit.paste');
  const mapped = refs(target.clipSelection);
  const size = target.pool.size;
  const wave = app.documents.find((d) => d.id === source.pool.get('main').docId);
  app.activate(wave);
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(target.pool.get(mapped[0]).stateRef).toBe(wave.state), { interval: 1 });
  expect([...target.pool.get(mapped[0]).channels[0].toArray()]).toEqual(Array(32).fill(-0.25));
  expect(target.pool.get('main')).toBe(targetOriginal);
  app.activate(target);
  target.setCursor(128);
  await app.commands.run('edit.paste');
  expect(refs(target.clipSelection)).toEqual(mapped);
  expect(target.pool.size).toBe(size);
  app.activate(source);
  await app.commands.run('edit.copy');
  app.activate(target);
  target.setCursor(192);
  await app.commands.run('edit.paste');
  expect(refs(target.clipSelection)).toEqual(mapped);
  expect(target.pool.size).toBe(size);
  // A paste back into its original session still uses the current linked audio.
  app.activate(wave);
  await app.commands.run('edit.undo');
  await vi.waitFor(() => expect(source.pool.get('main').stateRef).toBe(wave.state), { interval: 1 });
  app.activate(source);
  const sourceSize = source.pool.size;
  source.setCursor(64);
  await app.commands.run('edit.paste');
  expect(refs(source.clipSelection)).toEqual(Object.keys(values));
  expect(source.pool.size).toBe(sourceSize);
  expect([...source.pool.get(source.clipSelection[0].sourceId).channels[0].toArray()]).toEqual(Array(32).fill(0.25));
  expect(app.notify).not.toHaveBeenCalled();
});

it('preserves offline source details across collisions and repeated copies', async () => {
  const { app, source, target } = await setup();
  const id = source.addSource({ id: 'missing', name: 'Missing.wav', channels: [], offline: true });
  Object.assign(source.pool.get(id), { frames: 120, channelCount: 2 });
  const offline = createClip({ sourceId: id, trackId: source.state.tracks[0].id, start: 64, length: 120 });
  source.apply('Offline clip', addClips(source.state, [offline]));
  target.addSource({ id, name: 'Different.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(-0.75))] });
  const original = target.pool.get(id);
  let imported;
  let size;
  for (let i = 0; i < 2; i++) {
    app.activate(source);
    source.selectClips([offline.id]);
    await app.commands.run('edit.copy');
    app.activate(target);
    target.setCursor(64 + i * 120);
    await app.commands.run('edit.paste');
    const src = target.pool.get(target.clipSelection[0].sourceId);
    expect(src).toMatchObject({ offline: true, channels: [], frames: 120, channelCount: 2 });
    expect(target.pool.get(id)).toBe(original);
    if (i === 0) { imported = src; size = target.pool.size; }
    else { expect(src).toBe(imported); expect(target.pool.size).toBe(size); }
  }
  expect(app.notify).not.toHaveBeenCalled();
});
