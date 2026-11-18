import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { parseWav } from '../src/audio/wav.js';
import { Session } from '../src/model/session.js';
import { addVideoSource, createVideoClip, setVideoClip } from '../src/model/session-video.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { unzipStore } from '../src/lib/zip.js';

let downloads;
beforeEach(() => {
  localStorage.clear();
  delete window.puter;
  downloads = [];
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob) { downloads.push(blob); return 'blob:session-test'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(['file.save', 'file.saveCopy', 'file.download'])('%s keeps its manifest and media consistent through Undo during video preparation', async (command) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const doc = app.addDocument(new Session({ name: 'Film.asesx', sampleRate: 8000, tracks: 1 }));
  const audioId = doc.addSource({ name: 'Tone', channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
  doc.apply('Insert Audio', addClips(doc.state, [createClip({ trackId: doc.state.tracks[0].id, sourceId: audioId, name: 'Tone', start: 0, length: 32 })]));
  const videos = [[1, 2, 3, 4], [5, 6, 7, 8]].map((bytes, i) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'video/webm' });
    const name = `Scene ${i + 1}.webm`;
    const id = addVideoSource(doc, { name, blob, duration: 1, fps: 25, width: 320, height: 180 });
    doc.apply('Insert Video', setVideoClip(doc.state, createVideoClip({ sourceId: id, name, start: 0, length: 8000 })));
    return { id, blob, name, bytes, state: doc.state };
  });
  const savedState = doc.savedState;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let reading = false;
  const read = videos[1].blob.arrayBuffer.bind(videos[1].blob);
  vi.spyOn(videos[1].blob, 'arrayBuffer').mockImplementation(async () => {
    const bytes = await read();
    reading = true;
    await wait;
    return bytes;
  });
  const pending = app.commands.run(command);
  await vi.waitFor(() => expect(reading).toBe(true), { interval: 1 });
  await app.commands.run('edit.undo');
  expect(doc.state === videos[0].state).toBe(true);
  release();
  await pending;
  expect(downloads).toHaveLength(1);
  expect.soft(doc.dirty).toBe(true);
  const verify = async (archive, video) => {
    const files = unzipStore(await archive.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(files.get('Film.asesx')));
    expect.soft(files.has(manifest.video.file)).toBe(true);
    expect(manifest.video.id).toBe(video.id);
    expect(manifest.session.video.sourceId).toBe(video.id);
    expect([...files.get(manifest.video.file)]).toEqual(video.bytes);
    const audio = parseWav(files.get(manifest.sources[0].file).slice().buffer);
    expect(audio.sampleRate).toBe(8000);
    expect([...audio.channels[0]]).toEqual(Array(32).fill(0.25));
  };
  await verify(downloads[0], videos[1]);
  expect(doc.state === videos[0].state).toBe(true);
  expect(doc.savedState === (command === 'file.save' ? videos[1].state : savedState)).toBe(true);
  expect(doc.dirty).toBe(true);
  await app.commands.run(command);
  expect(downloads).toHaveLength(2);
  await verify(downloads[1], videos[0]);
  expect(doc.dirty).toBe(command !== 'file.save');
  await app.commands.run('edit.redo');
  expect(doc.state === videos[1].state).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});
