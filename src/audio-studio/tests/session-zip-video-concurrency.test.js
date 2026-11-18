import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
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

it.each([
  ['file.save', 'file.save'],
  ['file.saveCopy', 'file.download'],
  ['file.download', 'file.download'],
])('keeps video in both overlapping %s and %s archives', async (first, second) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const doc = app.addDocument(new Session({ name: 'Film.asesx', sampleRate: 8000, tracks: 1 }));
  // Media packaging treats video as opaque bytes; no decoder or large media is needed.
  const bytes = [1, 2, 3, 4];
  const blob = new Blob([new Uint8Array(bytes)], { type: 'video/webm' });
  const sourceId = addVideoSource(doc, { name: 'Scene.webm', blob, width: 320, height: 180, duration: 1, fps: 25 });
  doc.apply('Insert File', setVideoClip(doc.state, createVideoClip({ sourceId, name: 'Scene', start: 0, length: 8000 })));
  const state = doc.state;
  const savedState = doc.savedState;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let reading = 0;
  const read = blob.arrayBuffer.bind(blob);
  vi.spyOn(blob, 'arrayBuffer').mockImplementation(async () => {
    const result = await read();
    reading++;
    await wait;
    return result;
  });
  const pending = [app.commands.run(first), app.commands.run(second)];
  await vi.waitFor(() => expect(reading).toBe(2), { interval: 1 });
  release();
  await Promise.all(pending);
  expect(downloads).toHaveLength(2);
  const verify = async (archive) => {
    const files = unzipStore(await archive.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(files.get('Film.asesx')));
    expect(manifest.video.file).toBe('Film_Media/Scene.webm');
    expect(files.has(manifest.video.file)).toBe(true);
    expect([...files.get(manifest.video.file)]).toEqual(bytes);
  };
  for (const archive of downloads) await verify(archive);
  expect(doc.state === state).toBe(true);
  expect(doc.savedState === (first === 'file.save' ? state : savedState)).toBe(true);
  // Consuming one job's prepared bytes must not affect a later invocation either.
  await app.commands.run(first);
  expect(downloads).toHaveLength(3);
  await verify(downloads[2]);
  expect(app.notify).not.toHaveBeenCalled();
});
