// Repair DC Offset: per-channel mean subtraction, as an effect (so it can be
// a favorite and run in batches) listed directly in the Effects menu.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect } from '../src/effects/index.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { applyFavoriteToState } from '../src/batch/process.js';
import { MENUS } from '../src/ui/menus.js';
import { fakeApp } from './fx-helpers.js';

const sine = (n, f, amp, dc) => Float32Array.from({ length: n }, (_, i) => dc + amp * Math.sin((2 * Math.PI * f * i) / 1000));
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;

describe('Repair DC Offset', () => {
  const def = getEffect('dcOffset');

  it('is a parameterless offline effect listed at the top of the Effects menu', () => {
    expect(def.name).toBe('Repair DC Offset');
    expect(def.kind).toBe(null);
    expect(def.params).toEqual([]);
    expect(MENUS.find((m) => m.label === 'Effects').submenu).toContain('fx.dcOffset');
  });

  it('removes each channel\'s own offset and keeps the waveform', async () => {
    const l = sine(4000, 7, 0.3, 0.12);
    const r = sine(4000, 11, 0.2, -0.05);
    const [ol, or] = await def.process({ channels: [l, r], rate: 1000, values: {} });
    expect(Math.abs(mean(ol))).toBeLessThan(1e-6);
    expect(Math.abs(mean(or))).toBeLessThan(1e-6);
    for (let i = 0; i < 4000; i += 97) {
      expect(ol[i]).toBeCloseTo(l[i] - 0.12, 4);
      expect(or[i]).toBeCloseTo(r[i] + 0.05, 4);
    }
  });

  it('a NaN or infinite sample stays where it is instead of spreading over the channel', async () => {
    const l = sine(4000, 7, 0.3, 0.12);
    l[100] = NaN;
    l[200] = Infinity;
    const [ol] = await def.process({ channels: [l], rate: 1000, values: {} });
    expect(Number.isNaN(ol[100])).toBe(true);
    expect(ol[200]).toBe(Infinity);
    const rest = ol.filter((_, i) => i !== 100 && i !== 200);
    expect(rest.every(Number.isFinite)).toBe(true);
    expect(ol[0]).toBeCloseTo(l[0] - 0.12, 3);
  });

  it('runs from fx.dcOffset without a dialog as one undo step on the selection', async () => {
    const app = fakeApp();
    installEffectCommands(app);
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(sine(2000, 5, 0.2, 0.25))] });
    app.active = doc;
    expect(app.commands.label('fx.dcOffset')).toBe('Repair DC Offset');
    doc.setSelection(1000, 2000);
    await app.commands.run('fx.dcOffset');
    const out = doc.state.channels[0].toArray(0, 2000);
    expect(mean(out.subarray(1000))).toBeCloseTo(0, 5);
    expect(mean(out.subarray(0, 1000))).toBeCloseTo(0.25, 2);
    doc.history.undo();
    expect(mean(doc.state.channels[0].toArray(1000, 2000))).toBeCloseTo(0.25, 2);
  });

  it('works as a batch favorite', async () => {
    const state = { sampleRate: 1000, channels: [Channel.fromSamples(sine(1000, 3, 0.1, -0.2))], markers: [] };
    const fav = { id: 'f', name: 'Repair DC Offset', action: { type: 'effect', effect: 'dcOffset', values: {} } };
    const lazy = async () => {
      throw new Error('no chain needed');
    };
    const next = await applyFavoriteToState(fav, state, { applyChain: lazy });
    expect(mean(next.channels[0].toArray(0, 1000))).toBeCloseTo(0, 5);
  });
});
