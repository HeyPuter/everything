// Loaded convolution impulses are kept on the device and restored after a reload.
import { describe, it, expect, beforeEach } from 'vitest';
import { setImpulseBackend, memoryBackend, idbBackend, saveImpulse, storedImpulses, restoreImpulses, forgetImpulse, MAX_KEPT } from '../src/storage/impulses.js';
import { loadedImpulse, loadedImpulseNames } from '../src/effects/defs/reverb-impulses.js';
import { convolutionImpulse, LOADED_IMPULSE } from '../src/effects/defs/reverb.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { fakeApp, filled } from './fx-helpers.js';
import '../src/effects/views/index.js';
import { abortingIndexedDB, settleWithin } from './helpers/aborting-idb.js';

const ir = (n, k = 1) => ({ rate: 24000, channels: [Float32Array.from({ length: n }, (_, i) => (i === 0 ? k : Math.exp(-i / 200) * Math.sin(i)))] });

beforeEach(() => setImpulseBackend(memoryBackend()));

describe('stored impulses', () => {
  it('keeps the newest few and restores them into the reverbs', async () => {
    for (let i = 0; i < MAX_KEPT + 2; i++) expect(await saveImpulse(`room${i}.wav`, ir(800 + i), 1000 + i)).toBe(true);
    const list = await storedImpulses();
    expect(list.map((r) => r.name)).toEqual(Array.from({ length: MAX_KEPT }, (_, i) => `room${MAX_KEPT + 1 - i}.wav`));
    expect(list[0].channels[0]).toBeInstanceOf(Float32Array);
    const names = await restoreImpulses();
    expect(names[0]).toBe(`room${MAX_KEPT + 1}.wav`);
    expect(loadedImpulseNames()[0]).toBe(`room${MAX_KEPT + 1}.wav`);
    expect(loadedImpulse(`room${MAX_KEPT + 1}.wav`).channels[0].length).toBe(800 + MAX_KEPT + 1);
    // A restored impulse is what the reverb uses, not the fallback hall.
    const v = { ...defaults(getEffect('convolutionReverb')), impulse: LOADED_IMPULSE, impulseName: `room${MAX_KEPT + 1}.wav` };
    expect(convolutionImpulse(v, 48000).ir[0]).toBe(1);
    await forgetImpulse(`room${MAX_KEPT + 1}.wav`);
    expect((await storedImpulses()).length).toBe(MAX_KEPT - 1);
  });

  it('settles when an IndexedDB transaction aborts (storage full) instead of hanging', async () => {
    const saved = globalThis.indexedDB;
    globalThis.indexedDB = abortingIndexedDB();
    try {
      setImpulseBackend(idbBackend());
      expect(await settleWithin(saveImpulse('a.wav', ir(10)))).toEqual({ value: false });
      expect(await settleWithin(storedImpulses())).toEqual({ value: [] });
    } finally {
      globalThis.indexedDB = saved;
    }
  });

  it('never throws when the storage fails', async () => {
    setImpulseBackend({ getAll: async () => { throw new Error('blocked'); }, put: async () => { throw new Error('blocked'); }, delete: async () => {} });
    expect(await saveImpulse('a.wav', ir(10))).toBe(false);
    expect(await storedImpulses()).toEqual([]);
    expect(await restoreImpulses()).toEqual([]);
  });

  it('lets the dialog switch between the impulses on this device', async () => {
    await saveImpulse('hall.wav', ir(900), 1);
    await saveImpulse('plate.wav', ir(700), 2);
    await restoreImpulses();
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(4800, 0.1))] });
    app.active = doc;
    let last = null;
    const p = openEffectDialog(app, getEffect('convolutionReverb'), { doc, values: { ...defaults(getEffect('convolutionReverb')), impulse: LOADED_IMPULSE, impulseName: 'hall.wav' }, onChange: (v) => (last = v) });
    const dlg = [...document.querySelectorAll('.fx-dialog')].at(-1);
    const files = dlg.querySelector('.rv-impulse-files');
    expect(files.hidden).toBe(false);
    expect([...files.options].map((o) => o.value).slice(0, 2)).toEqual(['plate.wav', 'hall.wav']);
    expect(files.value).toBe('hall.wav');
    files.value = 'plate.wav';
    files.dispatchEvent(new Event('change'));
    expect(last.impulseName).toBe('plate.wav');
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});
