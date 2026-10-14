// Compressor and limiter editors: the static transfer curve (input dB on x,
// output dB on y) next to the knobs. The curve follows every parameter change.

import { h } from '../../lib/dom.js';
import { cssVar } from '../../ui/theme.js';
import { EFFECTS } from '../catalog.js';
import { compressorOut, limiterOut } from './dynamics-math.js';
import { paramControl, createCanvas } from './controls.js';

const LO = -60;
const HI = 6;

export function createDynamicsEditor(ctx) {
  const type = ctx.slot.type;
  let slot = ctx.slot;
  const curve = (x) => (type === 'limiter' ? limiterOut(x, slot.params) : compressorOut(x, slot.params));

  const graph = createCanvas('dyn-canvas', (g, w, hh) => {
    const pad = { l: 26, r: 6, t: 6, b: 18 };
    const iw = w - pad.l - pad.r;
    const ih = hh - pad.t - pad.b;
    const X = (db) => pad.l + ((db - LO) / (HI - LO)) * iw;
    const Y = (db) => pad.t + (1 - (db - LO) / (HI - LO)) * ih;
    g.fillStyle = cssVar('--grid-bg');
    g.fillRect(0, 0, w, hh);
    g.lineWidth = 1;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.fillStyle = cssVar('--ruler-text');
    for (let db = -60; db <= 0; db += 12) {
      g.strokeStyle = db === 0 ? cssVar('--grid-bar') : cssVar('--grid-line');
      const x = Math.round(X(db)) + 0.5;
      const y = Math.round(Y(db)) + 0.5;
      g.beginPath();
      g.moveTo(x, pad.t);
      g.lineTo(x, pad.t + ih);
      g.moveTo(pad.l, y);
      g.lineTo(pad.l + iw, y);
      g.stroke();
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.fillText(String(db), x, hh - 5);
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(String(db), pad.l - 4, y);
    }
    // Unity line.
    g.strokeStyle = cssVar('--grid-bar');
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(X(LO), Y(LO));
    g.lineTo(X(HI), Y(HI));
    g.stroke();
    g.setLineDash([]);
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, iw, ih);
    g.clip();
    // Threshold (or ceiling) marker and the knee span.
    const p = slot.params;
    const mark = type === 'limiter' ? p.ceiling : p.threshold;
    if (type !== 'limiter' && p.knee > 0) {
      g.fillStyle = cssVar('--accent-soft');
      g.fillRect(X(p.threshold - p.knee / 2), pad.t, X(p.threshold + p.knee / 2) - X(p.threshold - p.knee / 2), ih);
    }
    g.strokeStyle = cssVar('--warn');
    g.beginPath();
    if (type === 'limiter') {
      g.moveTo(pad.l, Math.round(Y(mark)) + 0.5);
      g.lineTo(pad.l + iw, Math.round(Y(mark)) + 0.5);
    } else {
      g.moveTo(Math.round(X(mark)) + 0.5, pad.t);
      g.lineTo(Math.round(X(mark)) + 0.5, pad.t + ih);
    }
    g.stroke();
    g.strokeStyle = cssVar('--accent');
    g.lineWidth = 2;
    g.beginPath();
    const n = Math.max(2, Math.round(iw / 2));
    for (let i = 0; i <= n; i++) {
      const x = LO + ((HI - LO) * i) / n;
      const y = Y(curve(x));
      if (i) g.lineTo(X(x), y);
      else g.moveTo(X(x), y);
    }
    g.stroke();
    g.restore();
  });
  graph.canvas.dataset.w = '200';
  graph.canvas.dataset.h = '200';
  const caption = h('p.fxw-caption');
  const controls = EFFECTS[type].params.map((d) => paramControl(ctx, d, slot.params[d.id], { size: 36 }));
  const knobs = h('div.fxw-grid', ...controls.map((c) => c.el));
  const el = h('div.fxw-dyn', h('figure.dyn-graph', graph.canvas, caption), knobs);

  const describe = () => {
    const p = slot.params;
    if (type === 'limiter') caption.textContent = `Output never exceeds ${p.ceiling.toFixed(1)} dB.`;
    else caption.textContent = `Above ${Math.round(p.threshold)} dB, every ${p.ratio.toFixed(1)} dB in gives 1 dB out.`;
    graph.canvas.setAttribute('aria-hidden', 'true');
  };
  describe();

  return {
    el,
    width: 520,
    update(next) {
      slot = next;
      for (const c of controls) c.set(slot.params[c.def.id]);
      describe();
      graph.redraw();
    },
    mounted: () => graph.redraw(),
    destroy: () => graph.destroy(),
  };
}
