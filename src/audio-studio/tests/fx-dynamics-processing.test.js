// Dynamics Processing: the drawn transfer curve (param type 'transfer'), its
// WASM processor (kind 39) with live readouts, and the curve editor.
import { describe, it, expect } from 'vitest';
import { instance } from './fx-wasm.js';
import { getEffect, defaults, slotSpec, effectLatency } from '../src/effects/index.js';
import { curveOutput, splineOutput, transferPoints } from '../src/effects/defs/amplitude.js';
import { dynamicsProcessingEditor, invertCurve } from '../src/effects/dyn-editors.js';
import { coerce, normalizeValues } from '../src/effects/params.js';
import { autoEditor } from '../src/effects/editors.js';
import { Emitter } from '../src/lib/emitter.js';

const RATE = 48000;
const def = getEffect('dynamicsProcessing');

function sine(n, f, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / RATE);
  return out;
}

const peak = (x, a = 0) => {
  let m = 0;
  for (let i = a; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};

/** Runs a slot spec over mono input in worklet-sized blocks; returns { out, readout }. */
function run(spec, input) {
  const x = instance();
  const h = x.fx_new(spec.kind, RATE, 1);
  for (const d of spec.data) {
    const ptr = x.mem_alloc(d.values.length * 4);
    new Float32Array(x.memory.buffer, ptr, d.values.length).set(d.values);
    x.fx_data(h, d.slot, ptr, d.values.length);
  }
  spec.params.forEach((v, i) => x.fx_set(h, i, v));
  x.fx_reset(h);
  const buf = x.mem_alloc(128 * 4);
  const out = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += 128) {
    const m = Math.min(128, input.length - at);
    new Float32Array(x.memory.buffer, buf, m).set(input.subarray(at, at + m));
    x.fx_process(h, buf, m);
    out.set(new Float32Array(x.memory.buffer, buf, m), at);
  }
  const rp = x.mem_alloc(16 * 4);
  const n = x.fx_readout(h, rp, 16);
  const readout = new Float32Array(x.memory.buffer, rp, n).slice();
  return { out, readout, latency: x.fx_latency(h) };
}

describe('Dynamics Processing', () => {
  it('is registered as a realtime effect with readouts and a transfer curve', () => {
    expect(def.kind).toBe(39);
    expect(def.realtime).toBe(true);
    expect(def.readout).toBe(true);
    expect(def.params[0].type).toBe('transfer');
    const spec = slotSpec(def, defaults(def));
    expect(spec.readout).toBe(true);
    expect(spec.data[0].slot).toBe(0);
    expect(Array.from(spec.data[0].values)).toEqual([-100, -100, -20, -20, 0, Math.fround(-13.3)]);
  });

  it('evaluates the curve like the processor (flat gain below, last slope above)', () => {
    const pts = [{ x: -100, y: -100 }, { x: -20, y: -20 }, { x: 0, y: -10 }];
    expect(curveOutput(pts, -50)).toBeCloseTo(-50);
    expect(curveOutput(pts, -10)).toBeCloseTo(-15);
    expect(curveOutput(pts, 4)).toBeCloseTo(-8);
    expect(curveOutput(pts, -120)).toBeCloseTo(-120);
    expect(def.transfer({ ...defaults(def), makeup: 3 }, -10)).toBeCloseTo(-20 + (10 * 6.7) / 20 + 3, 1);
  });

  it('keeps transfer curves sorted with ends pinned to the input range', () => {
    const p = def.params[0];
    expect(coerce(p, [{ x: -10, y: -12 }, { x: -60, y: -60 }, { x: -5, y: 9 }])).toEqual([
      { x: -100, y: -60 },
      { x: -10, y: -12 },
      { x: 0, y: 0 },
    ]);
    expect(coerce(p, 'junk')).toEqual(p.default);
    expect(normalizeValues(def, {}).curve).toEqual(p.default);
  });

  it('compresses with the default curve and reports level and gain', () => {
    const v = { ...defaults(def), lookahead: 0 };
    const { out, readout } = run(slotSpec(def, v), sine(RATE / 2, 1000, 0.5));
    const outDb = 20 * Math.log10(peak(out, RATE / 4));
    // -6 dBFS in; 3:1 above -20 dBFS -> about -15.3 dBFS out.
    expect(outDb).toBeGreaterThan(-16);
    expect(outDb).toBeLessThan(-14.5);
    expect(readout.length).toBe(3);
    expect(readout[0]).toBeCloseTo(-6, 0);
    expect(readout[1]).toBeLessThan(-8.5);
  });

  it('reports the look-ahead latency it declares', () => {
    for (const lookahead of [0, 2, 7.3, 20]) {
      const v = { ...defaults(def), lookahead };
      const { latency } = run(slotSpec(def, v), new Float32Array(256));
      expect(latency).toBe(effectLatency(def, v, RATE));
    }
  });

  it('bends Spline Curves smoothly through the points without overshooting', () => {
    const pts = [{ x: -100, y: -100 }, { x: -40, y: -40 }, { x: -20, y: -24 }, { x: 0, y: -22 }];
    for (const p of pts) expect(splineOutput(pts, p.x)).toBeCloseTo(p.y, 6);
    let prev = -Infinity;
    for (let x = -100; x <= 0; x += 0.5) {
      const y = splineOutput(pts, x);
      // Monotone and inside each segment's range: no overshoot.
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      const k = pts.findIndex((p) => p.x >= x);
      if (k > 0) expect(y).toBeLessThanOrEqual(pts[k].y + 1e-9);
      prev = y;
    }
    // Smooth where the straight curve has a corner: between the lines' values at -30.
    expect(splineOutput(pts, -30)).not.toBeCloseTo(curveOutput(pts, -30), 2);
    // Two points: the same straight line.
    expect(splineOutput([{ x: -100, y: -100 }, { x: 0, y: -10 }], -50)).toBeCloseTo(curveOutput([{ x: -100, y: -100 }, { x: 0, y: -10 }], -50));
  });

  it('sends the sampled spline to the processor and compresses along it', () => {
    const v = { ...defaults(def), lookahead: 0, spline: true };
    const dense = transferPoints(v);
    expect(dense.length).toBeGreaterThan(150);
    expect(slotSpec(def, v).data[0].values.length).toBe(dense.length * 2);
    expect(slotSpec(def, v).data[0].id).not.toBe(slotSpec(def, { ...v, spline: false }).data[0].id);
    const { out } = run(slotSpec(def, v), sine(RATE / 2, 1000, 0.5));
    const outDb = 20 * Math.log10(peak(out, RATE / 4));
    const want = def.transfer(v, -6);
    expect(outDb).toBeGreaterThan(want - 1);
    expect(outDb).toBeLessThan(want + 1);
  });

  it('applies every preset without errors', () => {
    for (const p of def.presets) {
      const { out } = run(slotSpec(def, { ...defaults(def), ...p.values }), sine(9600, 300, 0.8));
      expect(out.every(Number.isFinite), p.name).toBe(true);
    }
  });
});

describe('transfer curve editor', () => {
  function ctxFor(values) {
    const subs = new Set();
    const engine = new Emitter();
    const closers = [];
    const ctx = {
      values,
      def,
      app: { engine },
      doc: null,
      set(id, v) {
        ctx.values = { ...ctx.values, [id]: v };
        subs.forEach((f) => f(ctx.values));
      },
      subscribe: (f) => subs.add(f),
      onClose: (f) => closers.push(f),
      onReadout: (fn) => engine.on('fx-readout', (list) => list.has('preview:dynamicsProcessing') && fn(list.get('preview:dynamicsProcessing'))),
    };
    return { ctx, engine, close: () => closers.forEach((f) => f()) };
  }

  it('is chosen automatically and draws one handle per point', () => {
    const editor = autoEditor(def);
    expect(editor).toBeTypeOf('function');
    const { ctx, close } = ctxFor(normalizeValues(def, {}));
    const el = editor(ctx);
    const handles = el.querySelectorAll('.fx-point');
    expect(handles).toHaveLength(3);
    expect(handles[1].getAttribute('aria-valuetext')).toBe('Input -20.0 dB, output -20.0 dB');
    // Changing the curve from outside (a preset) re-lays the handles.
    ctx.set('curve', [{ x: -100, y: -100 }, { x: -50, y: -60 }, { x: -10, y: -10 }, { x: 0, y: -1 }]);
    expect(el.querySelectorAll('.fx-point')).toHaveLength(4);
    close();
  });

  it('has a Spline Curves switch beside the point tools', () => {
    const { ctx, close } = ctxFor(normalizeValues(def, {}));
    const el = dynamicsProcessingEditor()(ctx);
    const box = [...el.querySelectorAll('.fx-dp-tools label')].find((l) => l.textContent === 'Spline Curves').querySelector('input');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(ctx.values.spline).toBe(true);
    ctx.set('spline', false);
    expect(box.checked).toBe(false);
    close();
  });

  it('meters the output beside the curve while audio plays', () => {
    const { ctx, close } = ctxFor(normalizeValues(def, {}));
    let feed = null;
    ctx.onLevels = (fn) => (feed = fn);
    const el = dynamicsProcessingEditor()(ctx);
    const meter = el.querySelector('.fx-dp-top .fx-dp-meter');
    expect(meter.getAttribute('aria-label')).toBe('Out');
    feed([0.5, 0.5], [0.25, 0.5]);
    expect(Number(meter.getAttribute('aria-valuenow'))).toBeCloseTo(-6, 0);
    feed(null, null);
    expect(Number(meter.getAttribute('aria-valuenow'))).toBe(-60);
    close();
  });

  it('inverts the curve: a compressor becomes the matching expander', () => {
    const comp = [{ x: -100, y: -100 }, { x: -20, y: -20 }, { x: 0, y: -10 }];
    const inv = invertCurve(comp);
    expect(inv).toEqual([{ x: -100, y: -100 }, { x: -20, y: -20 }, { x: -10, y: 0 }, { x: 0, y: 0 }]);
    // Twice is the original where it was invertible.
    expect(invertCurve([{ x: -100, y: -100 }, { x: -20, y: -20 }, { x: 0, y: 0 }])).toEqual([{ x: -100, y: -100 }, { x: -20, y: -20 }, { x: 0, y: 0 }]);
    // A gate's flat floor turns into a step; points stay strictly ordered.
    const gate = invertCurve([{ x: -100, y: -100 }, { x: -51, y: -100 }, { x: -50, y: -50 }, { x: 0, y: 0 }]);
    for (let k = 1; k < gate.length; k++) expect(gate[k].x).toBeGreaterThan(gate[k - 1].x);
    expect(gate[1]).toEqual({ x: -99.9, y: -51 });
    const { ctx, close } = ctxFor(normalizeValues(def, { curve: comp }));
    const el = dynamicsProcessingEditor()(ctx);
    el.querySelector('[aria-label="Invert the curve"]').click();
    expect(ctx.values.curve).toEqual(inv);
    close();
  });

  it('edits points with the keyboard and shows live readouts', () => {
    const { ctx, engine, close } = ctxFor(normalizeValues(def, {}));
    const el = autoEditor(def)(ctx);
    const mid = el.querySelectorAll('.fx-point')[1];
    mid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(ctx.values.curve[1].y).toBeCloseTo(-20.1);
    mid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(ctx.values.curve).toHaveLength(2);
    const status = el.querySelector('.fx-transfer-status');
    expect(status.textContent).toMatch(/Play audio/);
    engine.emit('fx-readout', new Map([['preview:dynamicsProcessing', Float32Array.of(-12, -3.5, 0)]]));
    expect(status.textContent).toBe('Level -12.0 dB, gain -3.5 dB');
    close();
  });
});

describe('FxHost readouts', () => {
  it('reads every slot that reports readings, keyed by slot key', async () => {
    const { FxHost } = await import('../src/engine/fxhost.js');
    const { wasmBytes } = await import('./fx-wasm.js');
    const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), RATE);
    const chain = host.sync([slotSpec(def, { ...defaults(def), lookahead: 0 }, { key: 'rack:s1' }), slotSpec(getEffect('amplify'), defaults(getEffect('amplify')), { key: 'rack:s2' })]);
    const sig = sine(4096, 500, 0.5);
    for (let at = 0; at < sig.length; at += 128) host.run(chain, [sig.slice(at, at + 128), sig.slice(at, at + 128)], 128);
    const list = host.readouts();
    expect(list.map(([k]) => k)).toEqual(['rack:s1']);
    expect(list[0][1][0]).toBeCloseTo(-6, 0);
  });
});
