// Parametric EQ editor: the frequency response graph (20 Hz..20 kHz on a log
// axis, +-18 dB) computed from the band biquads (eq-math.js), one draggable
// handle per band, and knob columns per band below.
//
// Handles: drag moves frequency and gain (cuts: frequency only; Shift for
// fine), wheel changes Q on the bells, double-click or Delete resets the
// band. Keyboard: Left/Right frequency (1/12 octave, Shift 1/48), Up/Down
// gain (0.5 dB, Shift 0.1), Page Up/Down Q.

import { h } from '../../lib/dom.js';
import { clamp } from '../../lib/util.js';
import { cssVar } from '../../ui/theme.js';
import { EFFECTS, effectParamDef } from '../catalog.js';
import { formatParam } from '../../lib/params.js';
import * as E from '../../model/edits.js';
import { EQ_BANDS, eqFilters, eqResponseDb, biquad, biquadDb, bandActive, BUTTERWORTH_Q } from './eq-math.js';
import { paramControl, groupParams, createCanvas } from './controls.js';

const F_LO = 20;
const F_HI = 20000;
const DB = 18;
const PAD = { l: 30, r: 8, t: 8, b: 18 };
/** Band colors (data colors, like channel colors). */
const BAND_COLORS = { hp: '#8d9aa6', low: '#e8925a', m1: '#e3b84f', m2: '#5cbf8a', high: '#53a4dc', lp: '#9474dc' };
const GRID_F = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const fLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export function createEqEditor(ctx) {
  const { ctl, track, slotId } = ctx;
  const params = EFFECTS.eq.params;
  let slot = ctx.slot;
  let focusBand = null;

  // ---------------------------------------------------------------- geometry
  const geo = { w: 0, h: 0 };
  const fx = (f) => PAD.l + (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * (geo.w - PAD.l - PAD.r);
  const xf = (x) => F_LO * (F_HI / F_LO) ** clamp((x - PAD.l) / Math.max(1, geo.w - PAD.l - PAD.r), 0, 1);
  const dy = (db) => PAD.t + ((DB - db) / (2 * DB)) * (geo.h - PAD.t - PAD.b);
  const yd = (y) => DB - ((y - PAD.t) / Math.max(1, geo.h - PAD.t - PAD.b)) * 2 * DB;

  // ---------------------------------------------------------------- drawing
  const graph = createCanvas('eqg-canvas', (g, w, hh) => {
    geo.w = w;
    geo.h = hh;
    const p = slot.params;
    const grid = cssVar('--grid-line');
    const bar = cssVar('--grid-bar');
    const text = cssVar('--ruler-text');
    g.fillStyle = cssVar('--grid-bg');
    g.fillRect(0, 0, w, hh);
    g.lineWidth = 1;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.fillStyle = text;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    for (const f of GRID_F) {
      const x = Math.round(fx(f)) + 0.5;
      g.strokeStyle = grid;
      g.beginPath();
      g.moveTo(x, PAD.t);
      g.lineTo(x, hh - PAD.b);
      g.stroke();
      g.fillText(fLabel(f), x, hh - 5);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let db = -DB; db <= DB; db += 6) {
      const y = Math.round(dy(db)) + 0.5;
      g.strokeStyle = db === 0 ? bar : grid;
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(w - PAD.r, y);
      g.stroke();
      g.fillText(db > 0 ? `+${db}` : String(db), PAD.l - 5, y);
    }
    const n = Math.max(2, Math.round((w - PAD.l - PAD.r) / 2));
    const filters = eqFilters(p);
    // The focused band's own curve.
    if (focusBand) {
      const b = EQ_BANDS.find((x) => x.key === focusBand);
      if (bandActive(b, p)) {
        const c = biquad(b.type, p[b.freq], b.gain ? p[b.gain] : 0, b.q ? p[b.q] : BUTTERWORTH_Q);
        g.strokeStyle = BAND_COLORS[b.key];
        g.globalAlpha = 0.7;
        g.beginPath();
        for (let i = 0; i <= n; i++) {
          const x = PAD.l + (i / n) * (w - PAD.l - PAD.r);
          const y = dy(clamp(biquadDb(c, xf(x)), -DB - 4, DB + 4));
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    // Total response, filled toward 0 dB.
    const zero = dy(0);
    const ys = [];
    for (let i = 0; i <= n; i++) ys.push(dy(clamp(eqResponseDb(p, xf(PAD.l + (i / n) * (w - PAD.l - PAD.r)), filters), -DB - 4, DB + 4)));
    g.fillStyle = cssVar('--accent-soft');
    g.save();
    g.beginPath();
    g.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, hh - PAD.t - PAD.b);
    g.clip();
    g.beginPath();
    g.moveTo(PAD.l, zero);
    ys.forEach((y, i) => g.lineTo(PAD.l + (i / n) * (w - PAD.l - PAD.r), y));
    g.lineTo(w - PAD.r, zero);
    g.closePath();
    g.fill();
    g.strokeStyle = cssVar('--accent');
    g.lineWidth = 2;
    g.beginPath();
    ys.forEach((y, i) => {
      const x = PAD.l + (i / n) * (w - PAD.l - PAD.r);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    g.restore();
    placeHandles();
  });
  graph.canvas.dataset.w = '560';
  graph.canvas.dataset.h = '220';

  // ---------------------------------------------------------------- handles
  const handles = EQ_BANDS.map((b, n) => {
    const el = h('div.eqg-handle', { role: 'slider', tabindex: '0', 'aria-label': b.label, 'aria-valuemin': '20', 'aria-valuemax': '20000', style: { '--band': BAND_COLORS[b.key] }, dataset: { band: b.key } }, String(n + 1));
    return { b, el };
  });
  const handleLayer = h('div.eqg-handles', ...handles.map((x) => x.el));
  const readout = h('div.eqg-readout', { 'aria-hidden': 'true' });
  const box = h('div.eqg', graph.canvas, handleLayer, readout);

  function bandText(b, p = slot.params) {
    const parts = [formatParam(effectParamDef('eq', b.freq), p[b.freq])];
    if (b.gain) parts.push(formatParam(effectParamDef('eq', b.gain), p[b.gain]));
    if (b.q) parts.push(`Q ${p[b.q].toFixed(2)}`);
    if (!bandActive(b, p)) parts.push(b.gain ? 'flat' : 'off');
    return parts.join(', ');
  }

  function placeHandles() {
    const p = slot.params;
    for (const { b, el } of handles) {
      const x = fx(p[b.freq]);
      const y = b.gain ? dy(p[b.gain]) : dy(0);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.classList.toggle('inactive', !bandActive(b, p));
      el.setAttribute('aria-valuenow', String(Math.round(p[b.freq])));
      el.setAttribute('aria-valuetext', `${b.label}: ${bandText(b, p)}`);
      el.title = `${b.label}: ${bandText(b, p)}. Drag to move${b.q ? ', wheel for Q' : ''}, double-click to reset.`;
    }
    if (focusBand) {
      const b = EQ_BANDS.find((x) => x.key === focusBand);
      readout.textContent = `${b.label}: ${bandText(b, p)}`;
      readout.hidden = false;
    } else readout.hidden = true;
  }

  // Band edits: one gesture per drag; keyboard and wheel gestures end after a pause.
  const bandEdit = (proj, v) => {
    let next = proj;
    for (const [k, val] of Object.entries(v)) next = E.setSlotParam(next, track, slotId, k, val);
    return next;
  };
  let gesture = null;
  let endTimer = 0;
  const begin = (b) => {
    if (gesture?.band === b.key) return;
    end();
    gesture = { band: b.key, ...ctl.gesture(`EQ ${b.label}`, bandEdit, { label: () => `${ctl.label(track)} EQ ${b.label}`, target: { kind: 'fx', track, slot: slotId, param: b.gain || b.freq } }) };
    gesture.onStart();
  };
  const input = (b, changes) => {
    begin(b);
    const p = slot.params;
    const clean = {};
    for (const [k, v] of Object.entries(changes)) {
      const d = effectParamDef('eq', k);
      clean[k] = clamp(v, d.min, d.max);
    }
    // Merge with the other params of this band so a gesture keeps both axes.
    const all = { [b.freq]: p[b.freq], ...(b.gain ? { [b.gain]: p[b.gain] } : {}), ...(b.q ? { [b.q]: p[b.q] } : {}), ...clean };
    gesture.onInput(all);
  };
  function end() {
    clearTimeout(endTimer);
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    g.onEnd();
  }
  const endSoon = () => {
    clearTimeout(endTimer);
    endTimer = setTimeout(end, 450);
  };
  const resetBand = (b) => {
    const changes = { [b.freq]: effectParamDef('eq', b.freq).def };
    if (b.gain) changes[b.gain] = 0;
    if (b.q) changes[b.q] = effectParamDef('eq', b.q).def;
    input(b, changes);
    end();
  };

  for (const { b, el } of handles) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      el.setPointerCapture?.(e.pointerId);
      const rect = box.getBoundingClientRect();
      let lastX = e.clientX;
      let lastY = e.clientY;
      let x = fx(slot.params[b.freq]);
      let y = b.gain ? dy(slot.params[b.gain]) : 0;
      el.classList.add('dragging');
      const move = (ev) => {
        const k = ev.shiftKey ? 0.2 : 1;
        x += (ev.clientX - lastX) * k;
        y += (ev.clientY - lastY) * k;
        lastX = ev.clientX;
        lastY = ev.clientY;
        const c = { [b.freq]: xf(clamp(x, PAD.l, rect.width - PAD.r)) };
        if (b.gain) c[b.gain] = Math.round(clamp(yd(y), -DB, DB) * 10) / 10;
        input(b, c);
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        end();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetBand(b);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (!b.q) return;
        e.preventDefault();
        input(b, { [b.q]: slot.params[b.q] * (e.deltaY < 0 ? 1.08 : 1 / 1.08) ** (e.shiftKey ? 0.25 : 1) });
        endSoon();
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const p = slot.params;
      const fine = e.shiftKey;
      const oct = fine ? 1 / 48 : 1 / 12;
      let c = null;
      switch (e.key) {
        case 'ArrowLeft':
          c = { [b.freq]: p[b.freq] * 2 ** -oct };
          break;
        case 'ArrowRight':
          c = { [b.freq]: p[b.freq] * 2 ** oct };
          break;
        case 'ArrowUp':
          if (b.gain) c = { [b.gain]: Math.round((p[b.gain] + (fine ? 0.1 : 0.5)) * 10) / 10 };
          break;
        case 'ArrowDown':
          if (b.gain) c = { [b.gain]: Math.round((p[b.gain] - (fine ? 0.1 : 0.5)) * 10) / 10 };
          break;
        case 'PageUp':
          if (b.q) c = { [b.q]: p[b.q] * 1.12 };
          break;
        case 'PageDown':
          if (b.q) c = { [b.q]: p[b.q] / 1.12 };
          break;
        case 'Delete':
        case 'Backspace':
          resetBand(b);
          e.preventDefault();
          e.stopPropagation();
          return;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (c) {
        input(b, c);
        endSoon();
      }
    });
    const focusOn = () => {
      focusBand = b.key;
      graph.redraw();
    };
    const focusOff = () => {
      if (focusBand === b.key && document.activeElement !== el) {
        focusBand = null;
        graph.redraw();
      }
    };
    el.addEventListener('focus', focusOn);
    el.addEventListener('pointerenter', focusOn);
    el.addEventListener('blur', () => {
      end();
      focusOff();
    });
    el.addEventListener('pointerleave', focusOff);
  }

  // ---------------------------------------------------------------- knobs
  const controls = [];
  const cols = [];
  for (const [group, defs] of groupParams(params)) {
    const band = EQ_BANDS.find((b) => b.label === group);
    const col = h('div.fxw-group', { style: band ? { '--band': BAND_COLORS[band.key] } : null }, h('h4.fxw-group-title', h('span.fxw-band-dot', { 'aria-hidden': 'true', hidden: !band }), group));
    const row = h('div.fxw-group-body');
    for (const d of defs) {
      const c = paramControl(ctx, d, slot.params[d.id], { size: 28 });
      controls.push(c);
      row.append(c.el);
    }
    col.append(row);
    cols.push(col);
  }
  const knobs = h('div.fxw-groups.eq', ...cols);
  const el = h('div.fxw-eq', box, knobs);

  return {
    el,
    width: 680,
    update(next) {
      slot = next;
      for (const c of controls) c.set(slot.params[c.def.id]);
      graph.redraw();
      placeHandles();
    },
    mounted() {
      graph.redraw();
      placeHandles();
    },
    destroy() {
      end();
      graph.destroy();
    },
  };
}
