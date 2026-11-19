import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/catalog.js';
import '../src/effects/views/index.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, paramArray, slotSpec } from '../src/effects/registry.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { normalizeValues } from '../src/effects/params.js';
import { extractorBand, phaseCurve } from '../src/effects/defs/stereo.js';
import { dsp } from '../src/audio/dsp.js';
import { fakeApp, filled } from './fx-helpers.js';

function setup() {
  const app = fakeApp();
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(4800, 0.1)), Channel.fromSamples(filled(4800, 0.1))] });
  app.active = doc;
  return { app, doc };
}

const level = (x, f, rate = 48000) => {
  let s = 0;
  let c = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i] * Math.sin((2 * Math.PI * f * i) / rate);
    c += x[i] * Math.cos((2 * Math.PI * f * i) / rate);
  }
  return (2 * Math.hypot(s, c)) / x.length;
};

describe('center channel extractor', () => {
  it('reports the band of each frequency range', () => {
    expect(extractorBand({ range: 1 })).toEqual([80, 8000]);
    expect(extractorBand({ range: 4, lowFreq: 5000, highFreq: 300 })).toEqual([300, 5000]);
    expect(extractorBand({ range: 0 }, 44100)[1]).toBe(22050);
  });
  it('removes a custom-positioned source in WASM', async () => {
    const d = await dsp();
    const def = getEffect('centerChannelExtractor');
    const n = 48000;
    const a = ((0.5 + 1) * Math.PI) / 4;
    const tone = (f, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / 48000);
    const l = Float32Array.from({ length: n }, (_, i) => tone(1000, i) * Math.cos(a) + tone(3000, i));
    const r = Float32Array.from({ length: n }, (_, i) => tone(1000, i) * Math.sin(a) + tone(3000, i));
    const v = normalizeValues(def, { target: 4, pan: 50, centerLevel: -48, sideLevel: 0 });
    const [ol] = d.runEffect(def.kind, 48000, [l, r], paramArray(def, v));
    const tail = ol.subarray(24000);
    expect(level(tail, 1000)).toBeLessThan(0.02);
    expect(level(tail, 3000)).toBeGreaterThan(0.25);
  });
  it('enables the custom position controls only for a custom target', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('centerChannelExtractor'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    expect([...dlg.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Extraction', 'Discrimination']);
    const pan = [...dlg.querySelectorAll('input[type=range]')].find((s) => s.getAttribute('aria-label') === 'Pan');
    expect(pan.disabled).toBe(true);
    const target = [...dlg.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Extract');
    target.value = '4';
    target.dispatchEvent(new Event('change'));
    expect(pan.disabled).toBe(false);
    expect(dlg.querySelectorAll('.cce-levels .fx-vrange')).toHaveLength(2);
    dlg.querySelector('.btn.primary').click();
    expect((await p).target).toBe(4);
  });
});

describe('center channel extractor custom range', () => {
  it('starts from the band in use when switched to Custom', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('centerChannelExtractor'), { doc, values: { range: 2 } });
    const dlg = document.querySelector('.fx-dialog');
    const range = [...dlg.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Frequency Range');
    range.value = '4';
    range.dispatchEvent(new Event('change'));
    dlg.querySelector('.btn.primary').click();
    const v = await p;
    expect([v.range, v.lowFreq, v.highFreq]).toEqual([4, 150, 10000]);
  });
});

describe('graphic phase shifter', () => {
  it('clamps the curve to the chosen range', () => {
    const pts = [{ f: 20, g: 300 }, { f: 20000, g: -300 }];
    expect(phaseCurve({ curve: pts, range: 180 }).map((p) => p.g)).toEqual([180, -180]);
    expect(phaseCurve({ curve: pts, range: 360 }).map((p) => p.g)).toEqual([300, -300]);
  });
  it('samples spline curves densely and passes through the points', () => {
    const pts = [{ f: 20, g: 0 }, { f: 632.5, g: 90 }, { f: 20000, g: 0 }];
    const out = phaseCurve({ curve: pts, range: 180, spline: true, scale: 0 });
    expect(out.length).toBeGreaterThan(100);
    const mid = out.reduce((best, p) => (Math.abs(p.f - 632.5) < Math.abs(best.f - 632.5) ? p : best));
    expect(mid.g).toBeCloseTo(90, 0);
    expect(slotSpec(getEffect('graphicPhaseShifter'), { curve: pts, spline: true }).data[0].values.length).toBe(out.length * 2);
  });
  it('switches the graph range and scale', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('graphicPhaseShifter'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    const plot = () => dlg.querySelector('.gps-plot');
    const first = plot();
    const r360 = [...dlg.querySelectorAll('.fx-radio input')].find((i) => i.value === '360');
    r360.checked = true;
    r360.dispatchEvent(new Event('change'));
    expect(plot()).not.toBe(first);
    const handle = plot().querySelector('.fx-point');
    expect(handle.getAttribute('aria-valuetext')).toMatch(/20 Hz/);
    dlg.querySelector('.btn.primary').click();
    expect((await p).range).toBe(360);
  });
});
