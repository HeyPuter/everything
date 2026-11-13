import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openVoiceoverDialog } from '../src/ui/voiceover-dialog.js';
import { openRecordDialog } from '../src/ui/record-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, onMain, clip } from './helpers.js';

class Track extends EventTarget {
  constructor(kind) { super();this.kind = kind;this.readyState = 'live'; }
  getSettings() { return {}; }
  stop() { this.readyState = 'ended'; }
  endExternally() { this.stop();this.dispatchEvent(new Event('ended')); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
class Recorder extends EventTarget {
  static isTypeSupported() { return false; }
  constructor(stream) {
    super();this.stream = stream;this.state = 'inactive';this.mimeType = 'video/webm';
    for (const track of stream.getTracks()) track.addEventListener('ended', () => {
      if (this.state !== 'inactive' && stream.getTracks().every(t => t.readyState === 'ended')) this.stop();
    });
  }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded take'], { type: 'video/webm' }) });this.dispatchEvent(new Event('stop')); });
  }
}
let stream, dialog;
const button = (label, root = dialog.el) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
const settle = () => vi.advanceTimersByTimeAsync(0);
const unloadBlocked = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
beforeEach(() => {
  vi.useFakeTimers();
  stream = new Stream([new Track('video'), new Track('audio')]);
  vi.stubGlobal('MediaRecorder', Recorder);vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: async () => stream, getDisplayMedia: async () => stream, enumerateDevices: async () => [],
  } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setPref('record', { mode: 'camera', countdown: false, micId: '', addToTimeline: true, screenMic: false });
});
afterEach(async () => {
  dialog?.close();
  const confirmation = [...document.querySelectorAll('dialog')].find(d => d !== dialog?.el);
  button('Discard recording', confirmation || document.createElement('div'))?.click();
  await settle();
  dialog?.close();dialog = null;
  vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();
});

async function record(mode = 'camera', { fail = true, stop = true } = {}) {
  const { createActions } = await import('../src/ui/actions.js');
  const store = new EditorStore(fixture());
  store.project.bins = [{ id: 'takes', name: 'Takes' }];
  onMain(store.project, clip('video', 0, 10));
  store.seek(2000000);
  const asset = { ...store.project.assets[mode === 'voiceover' ? 'aud' : 'vid'], id: 'take', name: 'Recorded take', duration: 0 };
  const library = { importFile: vi.fn().mockImplementation(async () => {
    if (fail) throw new DOMException('Storage is full', 'QuotaExceededError');
    return asset;
  }) };
  const ctx = { store, library, player: { play() {}, pause() {} } };
  ctx.actions = createActions(ctx);
  dialog = mode === 'voiceover' ? openVoiceoverDialog(ctx) : openRecordDialog(ctx, { mode, folder: 'takes' });
  await settle();
  dialog.el.querySelector('[aria-label="Start recording"]').click();
  await vi.advanceTimersByTimeAsync(mode === 'voiceover' ? 4100 : 1100);
  if (stop) {
    dialog.el.querySelector('[aria-label="Stop recording"]').click();await settle();
  }
  return { ...ctx, asset };
}

it.each(['camera', 'screen', 'voiceover'])('retains a failed %s take and retries its original file and timeline position once', async mode => {
  const { library, store, asset, actions } = await record(mode);
  const insert = vi.spyOn(actions, 'addAsset');
  expect(library.importFile).toHaveBeenCalledTimes(1);
  const file = library.importFile.mock.calls[0][0];
  expect(file.size).toBeGreaterThan(0);
  expect(store.project.assets.take).toBeUndefined();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(true);
  expect(document.activeElement).toBe(button('Retry saving'));
  expect(unloadBlocked()).toBe(true);
  store.seek(9000000);
  button('Retry saving').click();await settle(); // Still full: keep the same take.
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
  let finish;
  library.importFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  button('Retry saving').click();button('Retry saving').click();await settle();
  expect(library.importFile).toHaveBeenCalledTimes(3);
  finish(asset);await settle();
  expect(library.importFile.mock.calls.every(([take]) => take === file)).toBe(true);
  expect(store.project.assets.take).toBeDefined();
  expect(asset.duration).toBeGreaterThan(0);
  const clips = store.project.tracks.flatMap(t => t.clips).filter(c => c.assetId === 'take');
  expect(clips).toHaveLength(1);
  expect(insert).toHaveBeenCalledExactlyOnceWith(asset, { start: 2000000 });
  if (mode === 'voiceover') expect(clips[0].start).toBe(2000000);
  if (mode !== 'voiceover') {
    expect(asset.folder).toBe('takes');
    expect(library.importFile.mock.calls.every(([, opts]) => opts.origin === 'record')).toBe(true);
  }
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(true);
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(false);
  expect(unloadBlocked()).toBe(false);
});

it.each(['camera', 'voiceover'])('downloads the original %s file without silently discarding it', async mode => {
  const { library } = await record(mode);
  const urls = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:take');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  let link;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { link = { href: this.href, download: this.download }; });
  button('Download recording').click();
  const file = library.importFile.mock.calls[0][0];
  expect(urls).toHaveBeenCalledWith(file);
  expect(link).toEqual({ href: 'blob:take', download: file.name });
  expect(unloadBlocked()).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(revoke).toHaveBeenCalledWith('blob:take');
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
});

it.each(['button', 'escape', 'programmatic'])('requires an explicit discard when closing by %s', async how => {
  await record();
  if (how === 'button') dialog.el.querySelector('.dialog-close').click();
  else if (how === 'escape') dialog.el.dispatchEvent(new Event('cancel', { cancelable: true }));
  else dialog.close();
  expect(dialog.el.isConnected).toBe(true);
  expect(document.activeElement.textContent).toBe('Keep recording');
  document.activeElement.click();await settle();
  expect(dialog.el.isConnected).toBe(true);
  expect(unloadBlocked()).toBe(true);
  dialog.close();dialog.close();
  expect(document.querySelectorAll('dialog')).toHaveLength(2);
  const confirm = [...document.querySelectorAll('dialog')].at(-1);
  button('Discard recording', confirm).click();await settle();
  expect(dialog.el.isConnected).toBe(false);
  expect(unloadBlocked()).toBe(false);
  expect(stream.getTracks().every(t => t.readyState === 'ended')).toBe(true);
});

it('discards only the failed take and allows a fresh recording', async () => {
  const { library, asset } = await record();
  const original = library.importFile.mock.calls[0][0];
  button('Discard recording').click();
  button('Discard recording', [...document.querySelectorAll('dialog')].at(-1)).click();await settle();
  expect(dialog.el.isConnected).toBe(true);
  expect(unloadBlocked()).toBe(false);
  library.importFile.mockResolvedValue(asset);
  dialog.el.querySelector('[aria-label="Start recording"]').click();
  await vi.advanceTimersByTimeAsync(1000);
  dialog.el.querySelector('[aria-label="Stop recording"]').click();await settle();
  expect(library.importFile).toHaveBeenCalledTimes(2);
  expect(library.importFile.mock.calls[1][0]).not.toBe(original);
});

it.each(['camera', 'voiceover'])('keeps the %s dialog reachable when a save in progress later fails', async mode => {
  const { library } = await record(mode, { stop: false });
  let fail;
  library.importFile.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  dialog.el.querySelector('[aria-label="Stop recording"]').click();
  dialog.close(); // Includes the interval awaiting the final recorder blob.
  await settle();dialog.close();
  expect(dialog.el.isConnected).toBe(true);
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  fail(new Error('Storage unavailable'));await settle();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
});

it('does not offer a duplicate import when only timeline insertion fails', async () => {
  const { library, actions, store } = await record('camera', { stop: false, fail: false });
  vi.spyOn(actions, 'addAsset').mockImplementation(() => { throw new Error('Timeline unavailable'); });
  dialog.el.querySelector('[aria-label="Stop recording"]').click();await settle();
  expect(library.importFile).toHaveBeenCalledTimes(1);
  expect(store.project.assets.take).toBeDefined();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(true);
  expect([...document.querySelectorAll('.toast.error')].at(-1).textContent).toContain('saved in your media');
  expect(unloadBlocked()).toBe(false);
});

it('retains the file if the import action itself throws', async () => {
  const { actions } = await record('camera', { stop: false });
  vi.spyOn(actions, 'importFiles').mockRejectedValue(new Error('Unexpected import failure'));
  dialog.el.querySelector('[aria-label="Stop recording"]').click();await settle();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
  expect(unloadBlocked()).toBe(true);
});


it.each(['camera', 'voiceover'])('retains an interrupted %s take without enabling an ended source after retry', async mode => {
  const { library, asset } = await record(mode, { stop: false });
  if (mode === 'camera') stream.getVideoTracks()[0].endExternally();
  else for (const track of stream.getTracks()) track.endExternally();
  await settle();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
  expect(stream.getTracks().every(t => t.readyState === 'ended')).toBe(true);
  library.importFile.mockResolvedValue(asset);
  button('Retry saving').click();await settle();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(true);
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(true);
});


it('preserves the media-only choice when retrying a camera take', async () => {
  setPref('record', { mode: 'camera', countdown: false, addToTimeline: false });
  const { library, asset, actions, store } = await record();
  const insert = vi.spyOn(actions, 'addAsset');
  library.importFile.mockResolvedValue(asset);
  button('Retry saving').click();await settle();
  expect(store.project.assets.take).toBeDefined();
  expect(insert).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(dialog.el.querySelector('[aria-label="Start recording"]'));
});

it('keeps the take recoverable if starting its download fails', async () => {
  await record();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('Download unavailable'); });
  button('Download recording').click();
  expect(dialog.el.querySelector('.recording-recovery').hidden).toBe(false);
  expect(unloadBlocked()).toBe(true);
  expect([...document.querySelectorAll('.toast.error')].at(-1).textContent).toContain('Download unavailable');
});
