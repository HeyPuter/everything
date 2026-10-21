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
