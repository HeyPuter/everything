import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openVoiceoverDialog } from '../src/ui/voiceover-dialog.js';
import { EditorStore } from '../src/model/store.js';
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
    super();this.stream = stream;this.state = 'inactive';this.mimeType = 'audio/webm';
    for (const track of stream.getTracks()) track.addEventListener('ended', () => {
      if (this.state !== 'inactive' && stream.getTracks().every(t => t.readyState === 'ended')) this.stop();
    });
  }
  start() {
    if (this.stream.getTracks().every(t => t.readyState === 'ended')) throw new DOMException('Stream ended', 'NotSupportedError');
    this.state = 'recording';
  }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded take'], { type: 'audio/webm' }) });this.dispatchEvent(new Event('stop')); });
  }
}
let stream, dialog, contexts, clearMeter;
class AudioContext {
  constructor() { this.state = 'running';contexts.push(this); }
  createMediaStreamSource(source) { this.stream = source;return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { getFloatTimeDomainData() {} }; }
  close() { this.state = 'closed';return Promise.resolve(); }
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const start = () => dialog.el.querySelector('[aria-label="Start recording"]');
const retry = () => dialog.el.querySelector('.vo-message button');
const state = () => dialog.el.querySelector('.vo-body').dataset.state;
function context() {
  const project = fixture();onMain(project, clip('video', 0, 10));
  const store = new EditorStore(project);store.seek(2000000);
  return { store, player: { play: vi.fn(), pause: vi.fn() }, actions: {
    importFiles: vi.fn(async files => [{ id: 'take', name: files[0].name, duration: 1000000 }]), addAsset: vi.fn(),
  } };
}
beforeEach(() => {
  vi.useFakeTimers();contexts = [];
  stream = new Stream([new Track('audio')]);
  vi.stubGlobal('MediaRecorder', Recorder);vi.stubGlobal('MediaStream', Stream);vi.stubGlobal('AudioContext', AudioContext);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []) } });
  clearMeter = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, clearRect: clearMeter });
});
afterEach(() => { dialog?.close();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren(); });

it.each(['idle', 'countdown'])('recognizes a lost microphone while %s, releases its meter, and retries without a late recording', async before => {
  const ctx = context();dialog = openVoiceoverDialog(ctx);await settle();
  if (before === 'countdown') start().click();
  stream.getAudioTracks()[0].endExternally();await settle();
  expect(state()).toBe('idle');expect(start().disabled).toBe(true);
  expect(dialog.el.querySelector('.vo-countdown').textContent).toBe('');
  expect(dialog.el.querySelector('.vo-message').textContent).toContain('microphone stopped');
  expect(contexts.map(c => c.state)).toEqual(['closed']);
  expect(clearMeter).toHaveBeenCalledExactlyOnceWith(0, 0, 300, 10);
  stream = new Stream([new Track('audio')]);retry().click();await settle();
  expect(start().disabled).toBe(false);
  expect(dialog.el.querySelector('.vo-message').hidden).toBe(true);
  expect(contexts.map(c => c.state)).toEqual(['closed', 'running']);
  await vi.advanceTimersByTimeAsync(4000);
  expect(state()).toBe('idle');
  expect(ctx.player.play).not.toHaveBeenCalled();expect(ctx.actions.importFiles).not.toHaveBeenCalled();
  dialog.close();expect(contexts.every(c => c.state === 'closed')).toBe(true);
});

it('ignores late enumeration after the microphone ended and a retry opened another one', async () => {
  let finish;
  navigator.mediaDevices.enumerateDevices.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  dialog = openVoiceoverDialog(context());await settle();
  expect(contexts).toHaveLength(0);
  stream.getAudioTracks()[0].endExternally();await settle();
  expect(start().disabled).toBe(true);
  stream = new Stream([new Track('audio')]);retry().click();await settle();
  finish([{ kind: 'audioinput', deviceId: 'old-device', label: 'Old device' }]);await settle();
  expect(contexts).toHaveLength(1);expect(contexts[0].stream).toBe(stream);
  expect(dialog.el.querySelector('#vo-mic').textContent).not.toContain('Old device');
  expect(start().disabled).toBe(false);
});

it('ignores an ended event from a replaced microphone', async () => {
  dialog = openVoiceoverDialog(context());await settle();const old = stream;
  stream = new Stream([new Track('audio')]);
  dialog.el.querySelector('#vo-mic').dispatchEvent(new Event('change'));await settle();
  old.getAudioTracks()[0].endExternally();await settle();
  expect(start().disabled).toBe(false);
  expect(dialog.el.querySelector('.vo-message').hidden).toBe(true);
  expect(contexts.map(c => c.state)).toEqual(['closed', 'running']);
  expect(stream.getAudioTracks()[0].readyState).toBe('live');
});

it('does not enable or meter a microphone that already ended when access resolved', async () => {
  stream.getAudioTracks()[0].stop();dialog = openVoiceoverDialog(context());await settle();
  expect(start().disabled).toBe(true);expect(retry()).not.toBeNull();expect(contexts).toHaveLength(0);
  expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  expect(dialog.el.querySelector('.vo-status').textContent).toBe('');
});

it('saves an active take once and closes its meter when the microphone ends', async () => {
  const ctx = context();dialog = openVoiceoverDialog(ctx);await settle();start().click();
  await vi.advanceTimersByTimeAsync(4000);expect(state()).toBe('recording');
  stream.getAudioTracks()[0].endExternally();await settle();
  expect(state()).toBe('idle');expect(start().disabled).toBe(true);
  expect(contexts.map(c => c.state)).toEqual(['closed']);
  expect(ctx.player.play).toHaveBeenCalledTimes(1);expect(ctx.player.pause).toHaveBeenCalledTimes(1);
  expect(ctx.actions.importFiles).toHaveBeenCalledTimes(1);expect(ctx.actions.addAsset).toHaveBeenCalledTimes(1);
  expect(ctx.actions.addAsset.mock.calls[0][1]).toEqual({ start: 2000000 });
  expect(retry()).not.toBeNull();
});

it('releases a microphone lost while its take is saving without importing twice', async () => {
  const ctx = context();let finish;
  ctx.actions.importFiles.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  dialog = openVoiceoverDialog(ctx);await settle();start().click();await vi.advanceTimersByTimeAsync(4000);
  dialog.el.querySelector('[aria-label="Stop recording"]').click();await settle();
  stream.getAudioTracks()[0].endExternally();await settle();
  expect(state()).toBe('saving');expect(contexts.map(c => c.state)).toEqual(['closed']);
  finish([{ id: 'take', name: 'Take', duration: 1000000 }]);await settle();
  expect(state()).toBe('idle');expect(start().disabled).toBe(true);expect(retry()).not.toBeNull();
  expect(ctx.actions.importFiles).toHaveBeenCalledTimes(1);
});

it('ignores microphone events after the dialog closes', async () => {
  const ctx = context();dialog = openVoiceoverDialog(ctx);await settle();dialog.close();
  stream.getAudioTracks()[0].endExternally();await settle();
  expect(document.querySelector('dialog')).toBeNull();expect(contexts.map(c => c.state)).toEqual(['closed']);
  expect(ctx.actions.importFiles).not.toHaveBeenCalled();
});
