// The voiceover and Record dialogs must never leave a microphone on: streams
// that arrive after the dialog closed, or after a newer request, are stopped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openVoiceoverDialog } from '../src/ui/voiceover-dialog.js';
import { openRecordDialog } from '../src/ui/record-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture } from './helpers.js';

let streams;
let pending;

function fakeStream() {
  const track = { kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; }, getSettings: () => ({}) };
  return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
}

/** Resolve the oldest waiting getUserMedia call. */
function grant() {
  const next = pending.shift();
  const s = fakeStream();
  streams.push(s);
  next(s);
  return new Promise((r) => setTimeout(r, 0));
}

const live = () => streams.filter((s) => s.getTracks()[0].readyState === 'live').length;
const ctxFor = () => ({ store: new EditorStore(fixture()), player: { pause() {}, play() {}, playing: false }, actions: {} });

beforeEach(() => {
  streams = [];
  pending = [];
  globalThis.MediaRecorder = class {};
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => new Promise((r) => pending.push(r)),
      getDisplayMedia: () => new Promise((r) => pending.push(r)),
      enumerateDevices: async () => [],
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.MediaRecorder;
  delete navigator.mediaDevices;
  document.body.replaceChildren();
});

describe('Record voiceover dialog', () => {
  it('stops a microphone that opens after the dialog closed', async () => {
    const d = openVoiceoverDialog(ctxFor());
    expect(pending).toHaveLength(1);
    d.close();
    await grant();
    expect(live()).toBe(0);
  });

  it('copes with closing while the microphones are listed', async () => {
    navigator.mediaDevices.enumerateDevices = () => new Promise((r) => setTimeout(() => r([]), 20));
    const d = openVoiceoverDialog(ctxFor());
    await grant();
    d.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(live()).toBe(0);
  });

  it('keeps only the newest microphone when settings change quickly', async () => {
    const d = openVoiceoverDialog(ctxFor());
    const sw = document.querySelector('.voiceover-dialog [role=switch]');
    sw.click();
    sw.click();
    expect(pending).toHaveLength(3);
    await grant();
    await grant();
    await grant();
    expect(live()).toBe(1);
    d.close();
    expect(live()).toBe(0);
  });
});

describe('Record dialog', () => {
  it('opens the remembered microphone when the dialog starts in screen mode', async () => {
    setPref('record', { mode: 'screen', screenMic: true, micId: 'saved-mic' });
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      expect(getUserMedia).toHaveBeenCalledWith({ audio: {
        deviceId: { exact: 'saved-mic' }, echoCancellation: true, noiseSuppression: true,
      } });
      await grant();
      expect(live()).toBe(1);
    } finally { d.close(); }
    expect(live()).toBe(0);
  });

  it('stops a screen recording microphone that opens after the dialog closed', async () => {
    setPref('record', { mode: 'screen', screenMic: false });
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    await new Promise((r) => setTimeout(r, 0));
    [...document.querySelectorAll('.record-dialog [role=switch]')].find((x) => x.closest('.field, .switch-field, label')?.textContent.includes('Include microphone') || x.textContent.includes('Include microphone')).click();
    expect(pending).toHaveLength(1);
    d.close();
    await grant();
    expect(live()).toBe(0);
  });
});

describe('pending screen selection', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const choose = (dialog) => [...dialog.el.querySelectorAll('button')].find((b) => b.textContent.includes('Choose what to share')).click();
  function screen() {
    const track = Object.assign(new EventTarget(), {
      kind: 'video', readyState: 'live',
      stop() { this.readyState = 'ended'; }, getSettings: () => ({}),
    });
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
    streams.push(stream);
    return stream;
  }
  beforeEach(() => {
    setPref('record', { mode: 'screen', screenMic: false });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  });

  it('waits for the selected microphone before enabling screen recording', async () => {
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      choose(d);
      pending.shift()(screen());
      await flush();
      const record = d.el.querySelector('.vo-record');
      expect(record.disabled).toBe(false);
      [...d.el.querySelectorAll('[role=switch]')].find((x) => x.closest('.field, .switch-field, label')?.textContent.includes('Include microphone') || x.textContent.includes('Include microphone')).click();
      expect(pending).toHaveLength(1);
      expect(record.disabled).toBe(true);
      record.click();
      expect(d.el.querySelector('.rec-body').dataset.state).toBe('idle');
      await grant();
      expect(record.disabled).toBe(false);
      record.click();
      expect(d.el.querySelector('.rec-body').dataset.state).toBe('countdown');
    } finally { d.close(); }
    expect(live()).toBe(0);
  });

  it('keeps recording disabled until the newest microphone request settles', async () => {
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      choose(d);
      pending.shift()(screen());
      await flush();
      const mic = [...d.el.querySelectorAll('[role=switch]')].find((x) => x.closest('.field, .switch-field, label')?.textContent.includes('Include microphone') || x.textContent.includes('Include microphone'));
      mic.click();
      mic.click();
      mic.click();
      expect(pending).toHaveLength(2);
      await grant();
      expect(d.el.querySelector('.vo-record').disabled).toBe(true);
      expect(live()).toBe(1); // only the shared screen; the obsolete microphone was stopped
      await grant();
      expect(d.el.querySelector('.vo-record').disabled).toBe(false);
      expect(live()).toBe(2);
    } finally { d.close(); }
    expect(live()).toBe(0);
  });

  it('stops a screen granted to a closed dialog even if another dialog opened', async () => {
    const first = openRecordDialog(ctxFor(), { mode: 'screen' });
    choose(first);
    const resolve = pending.shift();
    first.close();
    const second = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      resolve(screen());
      await flush();
      expect(live()).toBe(0);
      expect(second.el.querySelector('video').srcObject).toBeFalsy();
    } finally { second.close(); }
  });

  it('discards a screen granted after switching to the camera', async () => {
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      choose(d);
      const resolve = pending.shift();
      [...d.el.querySelectorAll('button')].find((b) => b.textContent === 'Camera').click();
      resolve(screen());
      await flush();
      expect(live()).toBe(0);
      expect(d.el.querySelector('video').srcObject).toBeFalsy();
    } finally { d.close(); }
  });

  it('keeps the latest selection when screen requests finish out of order', async () => {
    const d = openRecordDialog(ctxFor(), { mode: 'screen' });
    try {
      choose(d);
      choose(d);
      const older = pending.shift();
      const newer = pending.shift();
      const selected = screen();
      newer(selected);
      await flush();
      older(screen());
      await flush();
      expect(live()).toBe(1);
      expect(d.el.querySelector('video').srcObject).toBe(selected);
      d.close();
      expect(live()).toBe(0);
    } finally { d.close(); }
  });
});

describe('recorders when the device goes away', () => {
  /** A MediaRecorder that stops by itself when end() is called, as when its tracks end. */
  class FakeRecorder extends EventTarget {
    constructor(stream, opts) {
      super();
      this.state = 'inactive';
      this.mimeType = opts?.mimeType || 'video/webm';
    }
    start() {
      this.state = 'recording';
    }
    _finish() {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(['last']) });
        this.dispatchEvent(new Event('stop'));
      }, 0);
    }
    stop() {
      this._finish();
    }
    end() {
      this.ondataavailable?.({ data: new Blob(['take']) });
      this._finish();
    }
  }

  it.each([
    ['camera or screen', async () => new (await import('../src/media/capture.js')).VideoRecorder()],
    ['microphone', async () => new (await import('../src/media/voiceover.js')).VoiceRecorder()],
  ])('keeps the %s take recorded before the recorder stopped by itself', async (_, make) => {
    globalThis.MediaRecorder = FakeRecorder;
    MediaRecorder.isTypeSupported = () => false;
    const rec = await make();
    const interrupted = vi.fn();
    rec.onInterrupted = interrupted;
    rec.start({});
    rec.recorder.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(interrupted).toHaveBeenCalledTimes(1);
    const blob = await rec.stop();
    expect(await blob.text()).toBe('takelast');
  });

  it('does not report a stop the user asked for, or a canceled take', async () => {
    globalThis.MediaRecorder = FakeRecorder;
    MediaRecorder.isTypeSupported = () => false;
    const { VideoRecorder } = await import('../src/media/capture.js');
    const rec = new VideoRecorder();
    const interrupted = vi.fn();
    rec.onInterrupted = interrupted;
    rec.start({});
    expect(await (await rec.stop()).text()).toBe('last');
    rec.start({});
    rec.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(interrupted).not.toHaveBeenCalled();
  });
});

describe('take names', () => {
  it('numbers the next take after the highest one, so a deleted take is not named twice', async () => {
    const { nextTakeNumber } = await import('../src/media/capture.js');
    const assets = { a: { name: 'Voiceover 2.webm' }, b: { name: 'Voiceover 10.webm' }, c: { name: 'Camera recording 3.webm' }, d: { name: 'Voiceover notes.mp3' } };
    expect(nextTakeNumber(assets, 'Voiceover')).toBe(11);
    expect(nextTakeNumber(assets, 'Camera recording')).toBe(4);
    expect(nextTakeNumber(assets, 'Screen recording')).toBe(1);
    expect(nextTakeNumber({ a: { name: 'Voiceover 2' } }, 'Voiceover')).toBe(3);
  });
});
