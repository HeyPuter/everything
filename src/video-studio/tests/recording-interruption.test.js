import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openRecordDialog } from '../src/ui/record-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture } from './helpers.js';

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
beforeEach(() => {
  stream = new Stream([new Track('video'), new Track('audio')]);
  vi.stubGlobal('MediaRecorder', Recorder);vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => [] } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  setPref('record', { mode: 'camera', countdown: false, micId: '', addToTimeline: false });
});
afterEach(() => { dialog?.close();dialog = null;vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function openCamera() {
  const actions = { importFiles: vi.fn(async files => [{ id: 'asset_recorded', name: files[0].name, duration: 1000000 }]), addAsset: vi.fn() };
  dialog = openRecordDialog({ store: new EditorStore(fixture()), actions }, { mode: 'camera' });
  return actions;
}

it.each(['recording', 'paused'])('saves and stops a %s camera take when video ends but its microphone remains live', async state => {
  const actions = openCamera();await flush();
  dialog.el.querySelector('[aria-label="Start recording"]').click();
  if (state === 'paused') dialog.el.querySelector('[aria-label="Pause recording"]').click();
  expect(dialog.el.querySelector('.rec-body').dataset.state).toBe(state);
  stream.getVideoTracks()[0].endExternally();await flush();
  expect(actions.importFiles).toHaveBeenCalledTimes(1);
  expect(dialog.el.querySelector('.rec-body').dataset.state).toBe('idle');
  expect(dialog.el.querySelector('.vo-message').textContent).toContain('camera stopped');
  expect(stream.getAudioTracks()[0].readyState).toBe('ended');
});

it('disables a camera lost while idle and lets Try again acquire a new one', async () => {
  const actions = openCamera();await flush();const old = stream;
  old.getVideoTracks()[0].endExternally();await flush();
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(true);
  expect(old.getTracks().every(t => t.readyState === 'ended')).toBe(true);
  expect(actions.importFiles).not.toHaveBeenCalled();
  stream = new Stream([new Track('video'), new Track('audio')]);
  dialog.el.querySelector('.vo-message button').click();await flush();
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(false);
  expect(dialog.el.querySelector('video').srcObject).toBe(stream);
  expect(dialog.el.querySelector('.vo-message').hidden).toBe(true);
});

it('cancels countdown when its camera ends and does not start a late audio-only take', async () => {
  vi.useFakeTimers();setPref('record', { mode: 'camera', countdown: true, micId: '' });
  const actions = openCamera();await vi.advanceTimersByTimeAsync(0);
  dialog.el.querySelector('[aria-label="Start recording"]').click();
  expect(dialog.el.querySelector('.rec-body').dataset.state).toBe('countdown');
  stream.getVideoTracks()[0].endExternally();await vi.advanceTimersByTimeAsync(4000);
  expect(dialog.el.querySelector('.rec-body').dataset.state).toBe('idle');
  expect(dialog.el.querySelector('.rec-countdown').textContent).toBe('');
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(true);
  expect(stream.getTracks().every(t => t.readyState === 'ended')).toBe(true);
  expect(actions.importFiles).not.toHaveBeenCalled();
});

it('ignores an old camera ended event after a replacement camera is ready', async () => {
  openCamera();await flush();const old = stream;
  stream = new Stream([new Track('video'), new Track('audio')]);
  const resolution = dialog.el.querySelector('#rec-res');resolution.value = '1080';resolution.dispatchEvent(new Event('change'));
  await flush();old.getVideoTracks()[0].endExternally();await flush();
  expect(dialog.el.querySelector('video').srcObject).toBe(stream);
  expect(stream.getTracks().every(t => t.readyState === 'live')).toBe(true);
  expect(dialog.el.querySelector('[aria-label="Start recording"]').disabled).toBe(false);
  expect(dialog.el.querySelector('.vo-message').hidden).toBe(true);
});

it('imports only once when the camera and microphone end together', async () => {
  const actions = openCamera();await flush();dialog.el.querySelector('[aria-label="Start recording"]').click();
  for (const track of stream.getTracks()) track.endExternally();await flush();
  expect(actions.importFiles).toHaveBeenCalledTimes(1);
  expect(dialog.el.querySelector('.rec-body').dataset.state).toBe('idle');
});
