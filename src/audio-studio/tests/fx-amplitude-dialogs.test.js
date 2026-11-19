import { describe, it, expect } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, defaults, slotSpec, effectLatency } from '../src/effects/index.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { curveSegments } from '../src/effects/dyn-editors.js';
import { FxHost } from '../src/engine/fxhost.js';
import { fakeApp, filled } from './fx-helpers.js';
import '../src/effects/views/index.js';

const RATE = 48000;

function open(id) {
  const app = fakeApp();
  const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(filled(4800, 0.1)), Channel.fromSamples(filled(4800, 0.1))] });
  app.active = doc;
  const p = openEffectDialog(app, getEffect(id), { doc, routing: {} });
  const dlg = document.querySelector('.fx-dialog');
  const close = async () => {
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  };
  return { app, dlg, close };
}

const sine = (n, f, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE));

/** Runs `def` with `values` over a signal in a fresh FxHost and returns its last readout. */
function readout(id, values, sig) {
  const def = getEffect(id);
  const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), RATE);
  const chain = host.sync([slotSpec(def, { ...defaults(def), ...values }, { key: 'k' })]);
  for (let at = 0; at < sig.length; at += 128) {
    const n = Math.min(128, sig.length - at);
    host.run(chain, [sig.slice(at, at + n), sig.slice(at, at + n)], n);
  }
  return host.readouts()[0]?.[1];
}

describe('Amplitude and Compression dialogs', () => {
  it('Amplify frames its gain sliders', async () => {
    const { dlg, close } = open('amplify');
    expect(dlg.querySelector('[data-section="Gain"] > legend').textContent).toBe('Gain');
    expect([...dlg.querySelectorAll('[data-section="Gain"] .fx-label')].map((l) => l.textContent)).toEqual(['Left:', 'Right:']);
    await close();
  });

  it('Dynamics lays out gate, compressor, expander and limiter as knob columns with switches and meters', async () => {
    const { app, dlg, close } = open('dynamics');
    expect(dlg.classList.contains('fx-wide')).toBe(true);
    const cols = [...dlg.querySelectorAll('.fx-column')].map((c) => [...c.querySelectorAll('.fx-group')].map((g) => g.dataset.section));
    expect(cols).toEqual([['AutoGate'], ['Compressor'], ['Expander', 'Limiter']]);
    expect(dlg.querySelectorAll('[data-section="Compressor"] .knob')).toHaveLength(6);
    expect(dlg.querySelector('[data-section="AutoGate"] > legend input[type=checkbox]').checked).toBe(false);
    expect(dlg.querySelector('[data-section="AutoGate"]').classList.contains('off')).toBe(true);
    expect(dlg.querySelector('.fx-editor')).toBeNull();
    // Readouts drive the section meters.
    app.engine.emit('fx-readout', new Map([['preview:dynamics', Float32Array.of(0, -6, 0, -2)]]));
    expect(dlg.querySelector('[data-section="Compressor"] [role=meter]').getAttribute('aria-valuenow')).toBe('-6');
    expect(dlg.querySelector('[data-section="AutoGate"] [role=meter]').getAttribute('aria-valuenow')).toBe('0');
    await close();
  });

  it('Dynamics reports gate, compressor and limiter activity and honours the limiter release', () => {
    const loud = sine(48000, 500, 0.9);
    const r = readout('dynamics', { compOn: true, threshold: -30, ratio: 4, limOn: true, limThreshold: -12 }, loud);
    expect(r).toHaveLength(4);
    expect(r[1]).toBeLessThan(-10); // compressor working
    expect(r[3]).toBeLessThan(-0.5); // limiter working
    const gated = readout('dynamics', { gateOn: true, gateThreshold: -20, compOn: false }, sine(48000, 500, 0.001));
    expect(gated[0]).toBeLessThan(0.1);
    expect(getEffect('dynamics').params.findIndex((p) => p.id === 'limRelease')).toBe(19);
  });

  it('Dynamics Processing has Dynamics and Settings tabs, point tools and a segment table', async () => {
    const { dlg, close } = open('dynamicsProcessing');
    expect([...dlg.querySelectorAll('[role=tab]')].map((t) => t.textContent)).toEqual(['Dynamics', 'Settings']);
    const pages = dlg.querySelectorAll('[role=tabpanel]');
    expect(pages[0].querySelector('.fx-transfer-curve')).not.toBeNull();
    expect(pages[1].querySelector('[data-section="Detector"]')).not.toBeNull();
    const rows = () => [...dlg.querySelectorAll('.fx-dp-table tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows()).toHaveLength(2);
    expect(rows()[0][2]).toBe('Compressor');
    dlg.querySelector('[aria-label="Add a point"]').click();
    expect(rows()).toHaveLength(3);
    dlg.querySelector('[aria-label="Reset the curve"]').click();
    expect(rows()).toHaveLength(2);
    await close();
  });

  it('describes transfer curve segments', () => {
    const segs = curveSegments([{ x: -100, y: -100 }, { x: -60, y: -80 }, { x: -20, y: -20 }, { x: 0, y: -15 }]);
    expect(segs.map((s) => s.type)).toEqual(['Compressor', 'Expander', 'Compressor']);
    expect(segs[0].ratio).toBeCloseTo(4);
    expect(segs[0].threshold).toBe('Above -20.00 dB');
    expect(segs[1].threshold).toBe('Below -20.00 dB');
    expect(curveSegments([{ x: -100, y: -100 }, { x: 0, y: 0 }])[0].type).toBe('Neutral');
    expect(curveSegments([{ x: -100, y: -100 }, { x: -10, y: -10 }, { x: 0, y: -10 }])[0].type).toBe('Limiter');
  });

  it('DeEsser draws its band with a reduction meter fed by the readout', async () => {
    const { app, dlg, close } = open('deesser');
    expect(dlg.querySelector('.fx-band')).not.toBeNull();
    expect(dlg.querySelectorAll('.fx-radios input')).toHaveLength(2);
    app.engine.emit('fx-readout', new Map([['preview:deesser', Float32Array.of(-7.5)]]));
    expect(dlg.querySelector('.fx-band-meter [role=meter]').getAttribute('aria-valuenow')).toBe('-7.5');
    const handle = dlg.querySelector('.fx-band .fx-handle');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(6500);
    await close();
  });

  for (const id of ['singleBandCompressor', 'hardLimiter']) {
    it(`${id} shows input, gain reduction and output meters beside its transfer graph`, async () => {
      const { app, dlg, close } = open(id);
      const meters = [...dlg.querySelectorAll('.fx-tr-meters [role=meter]')];
      expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual(['In', 'GR', 'Out']);
      expect(dlg.querySelector('.fx-transfer-meters .fx-transfer')).not.toBeNull();
      app.engine.emit('fx-readout', new Map([[`preview:${id}`, Float32Array.of(-4, -8.5, -12)]]));
      expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['-4', '-8.5', '-12']);
      await close();
    });
  }

  it('Gain Envelope labels its points with times in the selection and its grid with levels', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(filled(RATE * 4, 0.1))] });
    app.active = doc;
    doc.setSelection(RATE, RATE * 3);
    const p = openEffectDialog(app, getEffect('gainEnvelope'), { doc, values: { envelope: [{ t: 0, v: 1 }, { t: 0.5, v: 2 }, { t: 1, v: 1 }] } });
    const dlg = document.querySelector('.fx-dialog');
    const points = [...dlg.querySelectorAll('.fx-envelope .fx-point')];
    // The middle point sits half way through the 1..3 s selection.
    expect(points[1].getAttribute('aria-valuetext')).toBe('2.00 s, 200 %');
    expect(getEffect('gainEnvelope').params[0].ticks).toEqual([1, 2, 3]);
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });

  it('Single-band Compressor and Hard Limiter report their gain reduction', () => {
    const comp = readout('singleBandCompressor', { threshold: -30, ratio: 4, knee: 0 }, sine(48000, 1000, 0.316));
    expect(comp[0]).toBeCloseTo(-10, 0);
    expect(comp[1]).toBeLessThan(-12);
    const lim = readout('hardLimiter', { ceiling: -6 }, sine(24000, 1000, 1));
    expect(lim[1]).toBeCloseTo(-6, 0);
    expect(lim[2]).toBeLessThan(-5.8);
  });

  it('DeEsser reports its gain reduction', () => {
    const r = readout('deesser', { threshold: -40 }, sine(24000, 7000, 0.5));
    expect(r).toHaveLength(1);
    expect(r[0]).toBeLessThan(-3);
  });

  it('Multiband Compressor shows crossovers, band strips with solo and bypass, and live band meters', async () => {
    const { app, dlg, close } = open('multibandCompressor');
    expect(dlg.querySelectorAll('.fx-xover')).toHaveLength(3);
    const strips = dlg.querySelectorAll('.fx-mb-strip');
    expect(strips).toHaveLength(4);
    const solo = strips[1].querySelector('.fx-mb-toggle.solo');
    solo.click();
    expect(solo.getAttribute('aria-pressed')).toBe('true');
    expect(strips[1].querySelectorAll('.hot')).toHaveLength(5);
    expect(dlg.querySelector('[data-section="Low Band"]')).toBeNull(); // band settings live in the strips
    app.engine.emit('fx-readout', new Map([['preview:multibandCompressor', Float32Array.of(-10, -3, -20, 0, -30, 0, -40, 0, -1)]]));
    expect(strips[0].querySelectorAll('[role=meter]')[1].getAttribute('aria-valuenow')).toBe('-3');
    // Output Gain is a fader with an output meter beside the graph, not a frame of its own.
    expect(dlg.querySelector('.fx-mb-top .fx-mb-output .fx-vmeter')).not.toBeNull();
    expect(dlg.querySelector('[data-section="Output"]')).toBeNull();
    expect(dlg.querySelector('.fx-columns').style.getPropertyValue('--cols')).toBe('2');
    await close();
  });

  it('Multiband Compressor thresholds have graph handles and ride on the input meters', async () => {
    const { dlg, close } = open('multibandCompressor');
    const handles = dlg.querySelectorAll('.fx-mb-thresh');
    expect(handles).toHaveLength(4);
    expect(handles[2].getAttribute('aria-valuenow')).toBe('-18');
    handles[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    expect(handles[2].getAttribute('aria-valuenow')).toBe('-15');
    const strip = dlg.querySelectorAll('.fx-mb-strip')[2];
    expect(strip.querySelector('.hot').textContent).toMatch(/-15/);
    // The input meter marks the threshold (0 dB at the top, -60 at the bottom) and has a dB scale.
    expect(strip.querySelector('.fx-mb-thresh-mark').style.top).toBe('25%');
    expect(strip.querySelector('.fx-lm-scale').textContent).toContain('-48');
    await close();
  });

  it('Multiband Compressor links band controls and sets the limiter attack', async () => {
    const { dlg, close } = open('multibandCompressor');
    const hot = (b, role) => dlg.querySelectorAll('.fx-mb-strip')[b].querySelectorAll('.hot')[role];
    const box = [...dlg.querySelectorAll('label.check')].find((l) => l.textContent.includes('Link Band Controls')).querySelector('input');
    expect([...dlg.querySelectorAll('[data-section="Limiter"] .fx-label')].map((l) => l.textContent)).toEqual(['Threshold:', 'Margin:', 'Attack:', 'Release:']);
    expect([...dlg.querySelectorAll('[data-section="Options"] label.check')].map((l) => l.textContent)).toContain('Spectrum on Input');
    box.click();
    // Threshold up 6 dB on the low band moves every band 6 dB.
    hot(0, 0).focus();
    for (let i = 0; i < 60; i++) hot(0, 0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const thresholds = [0, 1, 2, 3].map((b) => hot(b, 0).textContent);
    expect(new Set(thresholds).size).toBe(1);
    expect(thresholds[0]).toMatch(/-12/);
    await close();
  });

  it('Multiband Compressor limiter attack is its lookahead when brickwall', () => {
    const def = getEffect('multibandCompressor');
    expect(def.params.findIndex((p) => p.id === 'limAttack')).toBe(38);
    expect(effectLatency(def, { ...defaults(def), limAttack: 20 }, RATE)).toBe(959);
    expect(effectLatency(def, { ...defaults(def), limAttack: 20, brickwall: false }, RATE)).toBe(0);
    expect(effectLatency(def, defaults(def), RATE)).toBe(239);
  });

  it('Multiband Compressor reports band levels and reduction', () => {
    const r = readout('multibandCompressor', { band1Threshold: -40, band1Ratio: 8 }, sine(48000, 60, 0.7));
    expect(r).toHaveLength(9);
    expect(r[0]).toBeGreaterThan(-10); // low band input level
    expect(r[1]).toBeLessThan(-3); // low band reduction
    expect(r[7]).toBeGreaterThan(-0.5); // high band barely touched
  });

  it('Tube-modeled Compressor shows input, reduction and output meters', () => {
    const r = readout('tubeCompressor', { threshold: -30, ratio: 4 }, sine(24000, 500, 0.8));
    expect(r).toHaveLength(3);
    expect(r[0]).toBeGreaterThan(-3);
    expect(r[1]).toBeLessThan(-5);
  });

  it('Hard Limiter offers true peak detection with its extra latency', async () => {
    const def = getEffect('hardLimiter');
    expect(effectLatency(def, { truePeak: 1 }, RATE) - effectLatency(def, { truePeak: 0 }, RATE)).toBe(8);
    const { dlg, close } = open('hardLimiter');
    const radios = [...dlg.querySelectorAll('.fx-radios label')].map((l) => l.textContent);
    expect(radios).toEqual(['Peak', 'True Peak']);
    // The detection choice comes first.
    expect(dlg.querySelector('.fx-controls .fx-row').textContent).toMatch(/Detection/);
    await close();
  });

  it('Speech Volume Leveler adds dynamic range and boost low signals, with advanced settings folded away', async () => {
    const { dlg, close } = open('speechVolumeLeveler');
    const labels = [...dlg.querySelectorAll('.fx-controls > .fx-params .fx-label, .fx-controls > .fx-params .fx-bool')].map((l) => l.textContent);
    expect(labels).toEqual(['Target Volume Level:', 'Leveling Amount:', 'Target Dynamic Range:', 'Boost Low Signals']);
    expect(dlg.querySelector('details[data-section="Advanced"]').open).toBe(false);
    expect(dlg.querySelector('.fx-editor')).toBeNull();
    await close();
  });

  it('Channel Mixer has a page per output channel', async () => {
    const { dlg, close } = open('channelMixer');
    expect([...dlg.querySelectorAll('[role=tab]')].map((t) => t.textContent)).toEqual(['L', 'R']);
    expect([...dlg.querySelectorAll('[role=tabpanel]')[0].querySelectorAll('.fx-label')].map((l) => l.textContent)).toEqual(['L:', 'R:']);
    await close();
  });

  it('Channel Mixer inverts each input on its own', async () => {
    const { dlg, close } = open('channelMixer');
    const [lInv, rInv] = dlg.querySelectorAll('[role=tabpanel]')[0].querySelectorAll('.cm-invert input');
    expect(lInv.checked).toBe(false);
    // R into L is 0 %: nothing to invert yet.
    expect(rInv.disabled).toBe(true);
    lInv.checked = true;
    lInv.dispatchEvent(new Event('change'));
    const values = () => [...dlg.querySelectorAll('[role=tabpanel]')[0].querySelectorAll('.hot')].map((x) => x.textContent);
    expect(values()[0]).toMatch(/^-100/);
    expect(dlg.querySelector('.fx-preset-select').value).not.toBe('Default');
    lInv.checked = false;
    lInv.dispatchEvent(new Event('change'));
    expect(values()[0]).toMatch(/^100/);
    await close();
  });

  it('Normalize greys out the target it does not use', async () => {
    const { dlg, close } = open('normalize');
    const hots = () => [...dlg.querySelectorAll('.hot')].filter((x) => !x.closest('[hidden]'));
    const unit = () => dlg.querySelector('.fx-radios input:checked').nextSibling.textContent;
    expect(unit()).toBe('dB');
    expect(hots().map((x) => x.textContent)).toEqual(['-1.0 dB', '0.0 %']);
    const pct = dlg.querySelectorAll('.fx-radios input')[1];
    pct.checked = true;
    pct.dispatchEvent(new Event('change'));
    expect(hots()[0].textContent).toBe('100.0 %');
    // Normalize To off greys the target, unit and equal-channels option; DC bias waits for its switch.
    const box = (text) => [...dlg.querySelectorAll('label.check input')].find((i) => i.closest('label').textContent.startsWith(text));
    expect(hots()[1].disabled).toBe(true);
    box('Normalize To').click();
    expect(box('Normalize All').disabled).toBe(true);
    expect([...dlg.querySelectorAll('.fx-radios input')].every((i) => i.disabled)).toBe(true);
    box('DC Bias').click();
    expect(hots()[1].disabled).toBe(false);
    await close();
  });
});

describe('live input spectrum', () => {
  it('follows the audio at the playhead while playing and rests when stopped', async () => {
    const { liveSpectrum } = await import('../src/effects/views/common.js');
    await import('../src/multitrack/align.js');
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(sine(48000, 1000, 0.5))] });
    const queue = [];
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => queue.push(fn);
    try {
      let frames = 0;
      const spec = liveSpectrum({ app, doc, onClose: () => {} }, { onFrame: () => frames++ });
      await new Promise((r) => setTimeout(r, 20));
      app.engine.position = 24000;
      app.emit('transport', 'playing');
      expect(spec.live()).toBe(true);
      queue.shift()();
      expect(frames).toBe(1);
      const k = Math.round((1000 * spec.size) / RATE);
      expect(spec.levels[k]).toBeGreaterThan(-12);
      expect(spec.levels[k * 4]).toBeLessThan(-60);
      app.emit('transport', 'stopped');
      expect(spec.levels[k]).toBe(-120);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });
});
