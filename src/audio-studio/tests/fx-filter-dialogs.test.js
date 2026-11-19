import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { fftCurve } from '../src/effects/defs/filter.js';
import { butterworth, cascadePhase, cascadeGroupDelay } from '../src/effects/defs/filter-math.js';
import { responseView } from '../src/effects/filter-editors.js';
import { fakeApp, filled } from './fx-helpers.js';
import '../src/effects/views/index.js';

const RATE = 48000;

function open(id, values) {
  const app = fakeApp();
  const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(filled(4800, 0.1)), Channel.fromSamples(filled(4800, 0.1))] });
  app.active = doc;
  const p = openEffectDialog(app, getEffect(id), { doc, values, routing: {} });
  const dlg = document.querySelector('.fx-dialog');
  const close = async () => {
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  };
  return { dlg, close };
}

describe('Filter and EQ dialogs', () => {
  it('Parametric Equalizer lists its bands in a table under the graph', async () => {
    const { dlg, close } = open('parametricEq');
    expect([...dlg.querySelectorAll('.fx-table-head')].map((e) => e.textContent)).toEqual(['HP', 'L', '1', '2', '3', '4', '5', 'H', 'LP']);
    expect([...dlg.querySelectorAll('.fx-table-row')].map((e) => e.textContent)).toEqual(['Frequency', 'Gain', 'Q / Slope', 'Band']);
    const hp = dlg.querySelector('.fx-band-toggle');
    expect(hp.getAttribute('aria-pressed')).toBe('false');
    hp.click();
    expect(hp.getAttribute('aria-pressed')).toBe('true');
    // The pass filters use slope menus in the Q row.
    expect(dlg.querySelectorAll('.fx-table select')).toHaveLength(2);
    // Graph handles are named like the table columns.
    expect([...dlg.querySelectorAll('.fx-eq .fx-handle span')].map((s) => s.textContent)).toEqual(['HP', 'L', '1', '2', '3', '4', '5', 'H', 'LP']);
    expect(dlg.querySelector('[data-section="Band 1"]:not(.fx-table-cell)')).toBeNull();
    expect([...dlg.querySelectorAll('.fx-radios label')].map((l) => l.textContent)).toEqual(['Q', 'Width', '30 dB', '96 dB']);
    await close();
  });

  it('Parametric Equalizer L and H bands switch between shelf and peak from the Q cell', async () => {
    const { dlg, close } = open('parametricEq', { lsOn: true });
    const [low, high] = dlg.querySelectorAll('.peq-shape');
    expect(low.getAttribute('aria-label')).toBe('Low type: Shelf');
    expect(low.getAttribute('aria-pressed')).toBe('false');
    expect(high.disabled).toBe(true);
    const q = () => dlg.querySelector('.fx-table-cell[data-section="Low Shelf"].peq-shelf-q .hot').textContent;
    const before = q();
    low.click();
    expect(low.getAttribute('aria-label')).toBe('Low type: Peak');
    expect(low.getAttribute('aria-pressed')).toBe('true');
    // The type changes, not the Q.
    expect(q()).toBe(before);
    low.click();
    expect(low.getAttribute('aria-label')).toBe('Low type: Shelf');
    await close();
  });

  it('FFT Filter draws its curve on a linear axis when Scale is Linear', async () => {
    const { dlg, close } = open('fftFilter', { curve: [{ f: 20, g: 0 }, { f: 10000, g: -12 }, { f: 20000, g: 0 }] });
    const left = () => parseFloat(dlg.querySelectorAll('.fx-curve .fx-point')[1].style.left);
    // 10 kHz sits about 90 % along a 20 Hz..20 kHz log axis, half way along a linear one.
    expect(left()).toBeCloseTo(90, 0);
    const linear = [...dlg.querySelectorAll('.fx-radios input')].find((i) => i.parentElement.textContent === 'Linear');
    linear.checked = true;
    linear.dispatchEvent(new Event('change'));
    expect(left()).toBeCloseTo(50, 0);
    await close();
  });

  it('a row of band sliders shares one labelled dB scale', async () => {
    const { dlg, close } = open('graphicEq10');
    const axis = dlg.querySelector('.fx-vsliders .fx-vaxis');
    expect(axis.querySelector('.fx-vlabel').textContent).toBe('dB');
    expect([...axis.querySelectorAll('.fx-vaxis-label')].map((e) => e.textContent)).toContain('0');
    await close();
  });

  it('Parametric Equalizer Range rescales the graph and Ultra-Quiet reaches the processor', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(filled(4800, 0.1))] });
    const p = openEffectDialog(app, getEffect('parametricEq'), { doc, values: { band3Gain: 12 } });
    const dlg = document.querySelector('.fx-dialog');
    const handle = () => [...dlg.querySelectorAll('.fx-eq .fx-handle')].find((b) => b.textContent === '3');
    const top30 = handle().style.top;
    const radio96 = [...dlg.querySelectorAll('.fx-radios input')].find((i) => i.parentElement.textContent === '96 dB');
    radio96.checked = true;
    radio96.dispatchEvent(new Event('change'));
    // +12 dB sits higher on a +/-15 dB graph than on a +/-48 dB one.
    expect(parseFloat(top30.match(/calc\(([\d.-]+)%/)[1])).toBeLessThan(parseFloat(handle().style.top.match(/calc\(([\d.-]+)%/)[1]));
    const box = [...dlg.querySelectorAll('.peq-bottom input[type=checkbox]')][0];
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('.peq-top .fx-vrange')).not.toBeNull();
    dlg.querySelector('.btn.primary').click();
    const values = await p;
    expect(values).toMatchObject({ range: 1, ultraQuiet: true });
    const { paramArray } = await import('../src/effects/registry.js');
    expect(paramArray(getEffect('parametricEq'), values)[36]).toBe(1);
  });

  it('Graphic Equalizers draw a vertical slider per band with short labels', async () => {
    for (const [id, n, first, last] of [['graphicEq10', 10, '<31', '>16k'], ['graphicEq30', 31, '<25', '>20k']]) {
      const def = getEffect(id);
      const bands = def.params.filter((p) => p.section === 'Bands').length;
      const { dlg, close } = open(id);
      const labels = [...dlg.querySelectorAll('.fx-vslider .fx-vlabel')].map((e) => e.textContent);
      expect(labels).toHaveLength(bands);
      expect(bands === n || id === 'graphicEq30').toBe(true);
      expect(labels[0]).toBe(first);
      expect(labels.at(-1)).toBe(last);
      // Bands first, then gain and accuracy.
      expect(dlg.querySelector('.fx-controls').firstElementChild.dataset.section).toBe('Bands');
      await close();
    }
  });

  it('Graphic Equalizer sliders span the Range, and shrinking it pulls bands in', async () => {
    const { dlg, close } = open('graphicEq10', { ...defaults(getEffect('graphicEq10')), band3: 10, band5: -3 });
    const slider = (i) => dlg.querySelectorAll('.fx-vslider input[type="range"]')[i];
    expect([slider(0).min, slider(0).max]).toEqual(['-24', '24']);
    const range = [...dlg.querySelectorAll('.geq-range .hot')][0];
    expect(range.textContent).toMatch(/48/);
    range.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = dlg.querySelector('.geq-range input');
    input.value = '12';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect([slider(0).min, slider(0).max]).toEqual(['-6', '6']);
    // +10 dB no longer fits: it sits at the +6 dB edge; -3 dB is kept.
    expect(slider(2).value).toBe('6');
    expect(slider(4).value).toBe('-3');
    expect(dlg.querySelector('.geq-gain .fx-label').textContent).toBe('Gain:');
    expect(dlg.querySelector('.geq-accuracy select, .geq-accuracy .fx-radios')).toBeTruthy();
    await close();
  });

  it('Notch Filter tabulates its notches and greys out gains fixed to the first', async () => {
    const { dlg, close } = open('notchFilter');
    expect(dlg.querySelectorAll('.fx-table-head')).toHaveLength(6);
    const gains = () => [...dlg.querySelectorAll('.fx-table .hot')].filter((b) => /Gain/.test(b.getAttribute('aria-label')));
    expect(gains().every((g) => !g.disabled)).toBe(true);
    const fix = [...dlg.querySelectorAll('.fx-bool input')].find((b) => b.parentElement.textContent.includes('Fix Gains'));
    fix.checked = true;
    fix.dispatchEvent(new Event('change'));
    expect(gains().map((g) => g.disabled)).toEqual([false, true, true, true, true, true]);
    await close();
  });

  it('Scientific Filter switches its graph between magnitude, phase and group delay', async () => {
    const { dlg, close } = open('scientificFilter');
    expect([...dlg.querySelectorAll('.fx-sci-views label')].map((l) => l.textContent)).toEqual(['Frequency Response (dB)', 'Phase (deg)', 'Group Delay (ms)']);
    const ranges = [...dlg.querySelectorAll('input[type=range]')];
    const high = ranges.find((r) => r.getAttribute('aria-label') === 'High Cutoff');
    const ripple = ranges.find((r) => r.getAttribute('aria-label') === 'Passband Ripple');
    expect(high.disabled).toBe(true);
    expect(ripple.disabled).toBe(true);
    await close();
  });

  it('Scientific Filter designs by transition bandwidth', async () => {
    const { scientificOrderFor, scientificTransition } = await import('../src/effects/defs/filter.js');
    const base = { ...defaults(getEffect('scientificFilter')), cutoff: 1000, stopAtten: 40 };
    // Butterworth falls 6 dB per octave per order: 40 dB one octave up needs order 7.
    expect(scientificOrderFor({ ...base, transition: 1000 }, RATE)).toEqual({ order: 7, met: true });
    expect(scientificOrderFor({ ...base, transition: 3000 }, RATE).order).toBeLessThan(5);
    expect(scientificOrderFor({ ...base, transition: 50 }, RATE)).toEqual({ order: 8, met: false });
    // Chebyshev is steeper than Butterworth.
    expect(scientificOrderFor({ ...base, type: 1, transition: 1000 }, RATE).order).toBeLessThan(7);
    // The reverse: order 4 is down 40 dB at about 3.16 kHz, 2.16 kHz past the cutoff.
    const w = scientificTransition({ ...base, order: 4 }, RATE);
    expect(w).toBeGreaterThan(1800);
    expect(w).toBeLessThan(2400);
    const { dlg, close } = open('scientificFilter', { ...defaults(getEffect('scientificFilter')), type: 0, cutoff: 1000 });
    const radio = [...dlg.querySelectorAll('.fx-radios input')].find((i) => i.parentElement.textContent === 'Transition Bandwidth');
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    const ranges = [...dlg.querySelectorAll('input[type=range]')];
    expect(ranges.find((r) => r.getAttribute('aria-label') === 'Order').disabled).toBe(true);
    expect(ranges.find((r) => r.getAttribute('aria-label') === 'Transition Bandwidth').disabled).toBe(false);
    expect(dlg.querySelector('.fx-sci-design').textContent).toBe('Order 7 is down 40 dB within 1000 Hz');
    await close();
  });

  it('Notch Filter offers Ultra-Quiet as processor param 21', async () => {
    const def = getEffect('notchFilter');
    expect(def.params.findIndex((p) => p.id === 'ultraQuiet')).toBe(21);
    const { dlg, close } = open('notchFilter');
    expect([...dlg.querySelectorAll('label.check')].some((l) => l.textContent === 'Ultra-Quiet')).toBe(true);
    await close();
  });

  it('computes phase and group delay of a filter design', () => {
    const lp = butterworth(RATE, 1000, 2, false);
    const [ph] = cascadePhase(lp, [1000], RATE);
    expect(ph).toBeCloseTo(-90, 0);
    const gd = cascadeGroupDelay(lp, [100, 1000, 10000], RATE);
    expect(gd[0]).toBeGreaterThan(0.1);
    expect(gd[1]).toBeGreaterThan(gd[2]);
    const view = responseView('delay', lp, [100, 1000], RATE);
    expect(view.top).toBeGreaterThan(Math.max(...view.values));
  });

  it('FFT Filter smooths its curve with Spline Curves and folds advanced settings away', async () => {
    const pts = [{ f: 20, g: 0 }, { f: 1000, g: -24 }, { f: 20000, g: 0 }];
    const plain = fftCurve({ curve: pts, spline: false });
    expect(plain).toEqual(pts);
    const smooth = fftCurve({ curve: pts, spline: true });
    expect(smooth.length).toBeGreaterThan(100);
    const near = (f) => smooth.reduce((a, b) => (Math.abs(Math.log(b.f / f)) < Math.abs(Math.log(a.f / f)) ? b : a));
    expect(near(1000).g).toBeCloseTo(-24, 0);
    // Between points the eased curve differs from straight lines.
    const def = getEffect('fftFilter');
    const at = (v) => def.response({ ...defaults(def), curve: pts, ...v }, [200], RATE)[0];
    expect(Math.abs(at({ spline: true }) - at({ spline: false }))).toBeGreaterThan(1);
    expect(def.data({ ...defaults(def), curve: pts, spline: true })[0].id).not.toBe(def.data({ ...defaults(def), curve: pts, spline: false })[0].id);
    const { dlg, close } = open('fftFilter');
    expect(dlg.querySelector('.fx-eq')).toBeNull();
    expect(dlg.querySelector('.fx-curve')).not.toBeNull();
    expect(dlg.querySelector('details[data-section="Advanced"]').open).toBe(false);
    expect(dlg.querySelector('.fx-controls').lastElementChild.dataset.section).toBe('Advanced');
    await close();
  });
});
