/**
 * Speed > Curve: variable speed over the clip. A grid of curve presets
 * (with small curve drawings) and an editor with speed on a log axis
 * (0.1x..10x) against the clip's timeline time.
 *
 * Editor: click to add a point and drag to shape the curve; the end points
 * only move up and down. Drag a point off the editor or double-click it to
 * remove it. Keyboard: Page Up / Page Down (or Home / End) pick a point,
 * arrow keys move it (Shift for bigger steps), + or Insert adds one,
 * Delete removes it. The playhead shows as a vertical line.
 *
 * Applying or editing a curve keeps the footage the clip plays, so the
 * clip's timeline length follows the curve. A drag is one undo step and
 * keeps the source length it started with.
 */
import '../../styles/speed.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import {
  CURVE_PRESETS, CURVE_MIN, CURVE_MAX, POINT_GAP, MAX_POINTS, curveTable, presetOf, presetPoints, hasCurve, sourceSpan,
} from '../../model/speed-curve.js';
import { activeRamp } from '../../model/speed-ramps.js';
import { choiceGrid, propSection, uidFor, secs } from './common.js';

const LMIN = Math.log(CURVE_MIN);
const LMAX = Math.log(CURVE_MAX);
const GRID = [0.1, 0.2, 0.5, 1, 2, 5, 10];
const PAD_L = 34; // room for the speed labels
const PAD_R = 10;
const PAD_Y = 10;
const HIT = 11;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtX = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(2));
const cssVar = (el, name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** Small drawing of a curve for the preset tiles (log speed, 1x line dashed). */
export function curveGlyph(points) {
  const W = 56;
  const H = 32;
  const y = (v) => H - 3 - ((Math.log(v) - LMIN) / (LMAX - LMIN)) * (H - 6);
  let d = '';
  if (points) {
    const v = curveTable(points).speed;
    for (let i = 0; i <= 40; i++) d += `${i ? 'L' : 'M'}${((i / 40) * W).toFixed(1)} ${y(v(i / 40)).toFixed(1)}`;
  } else d = `M0 ${y(1)}L${W} ${y(1)}`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'speed-glyph');
  svg.setAttribute('aria-hidden', 'true');
  const base = document.createElementNS(ns, 'path');
  base.setAttribute('d', `M0 ${y(1)}L${W} ${y(1)}`);
  base.setAttribute('class', 'speed-glyph-base');
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', d);
  line.setAttribute('class', 'speed-glyph-line');
  svg.append(base, line);
  return svg;
}

/** Points to start a custom curve from: flat at the clip's speed with a middle point to drag. */
function customStart(clip) {
  if (hasCurve(clip)) return clip.speedCurve.map((p) => ({ ...p }));
  const v = clamp(clip.speed || 1, CURVE_MIN, CURVE_MAX);
  return [{ t: 0, v }, { t: 0.5, v }, { t: 1, v }];
}

export function speedCurvePanel(view) {
  const { store, actions } = view;
  let sel = -1;
  let drag = null; // { index, removing }
  let run = null; // { span } for the edit run in progress (drag or key presses)
  let custom = false; // "Custom" picked on a curve that still matches a preset

  const current = () => (hasCurve(view.clip) ? view.clip.speedCurve : null);

  // ---- Presets -------------------------------------------------------------
  const items = [
    { id: null, label: 'None', preview: curveGlyph(null) },
    ...CURVE_PRESETS.map((p) => ({ id: p.id, label: p.label, preview: curveGlyph(p.points) })),
    { id: 'custom', label: 'Custom', preview: h('span.speed-custom-icon', icon('pencil', 16)) },
  ];
  const presetValue = () => {
    const pts = current();
    if (!pts) return null;
    return (!custom && presetOf(pts)) || 'custom';
  };
  const grid = choiceGrid({
    label: 'Speed curve presets',
    className: 'speed-preset-grid',
    items,
    value: presetValue(),
    onPick: (id) => {
      sel = -1;
      custom = id === 'custom';
      if (id === null) {
        actions.setSpeedCurve(view.id, null, { label: 'Remove speed curve' });
        announce('Constant speed');
      } else if (id === 'custom') {
        if (!current()) actions.setSpeedCurve(view.id, customStart(view.clip), { label: 'Custom speed curve' });
        announce('Custom curve. Drag the points to shape it.');
      } else {
        actions.setSpeedCurve(view.id, presetPoints(id), { label: 'Speed curve', dropRamp: true });
        announce(`${CURVE_PRESETS.find((p) => p.id === id).label} curve, ${secs(view.clip?.duration || 0)}`);
      }
      store.seal();
    },
  });

  // ---- Editor ----------------------------------------------------------------
  const helpId = uidFor('speed-curve-help');
  const canvas = h('canvas.speed-curve-canvas', { tabindex: '0', role: 'application', 'aria-roledescription': 'speed curve editor', 'aria-label': 'Speed curve', 'aria-describedby': helpId });
  const readout = h('div.speed-curve-readout', { 'aria-live': 'polite' });
  const help = h('p.speed-curve-help', { id: helpId }, 'Click to add a point and drag to shape the curve. Drag a point off the editor or double-click it to remove it. Up is faster.');
  // Which velocity ramp the curve came from, if any (see speed-ramps.js).
  const origin = h('p.speed-ramp-origin', icon('speed', 14), h('span'));
  const durNow = h('output.speed-curve-dur');
  const durSrc = h('span');
  const g = canvas.getContext('2d');

  const size = () => {
    const w = canvas.clientWidth || 280;
    return { w, hgt: canvas.clientHeight || Math.round(w * 0.6) };
  };
  const yOf = (v, s) => PAD_Y + (1 - (Math.log(v) - LMIN) / (LMAX - LMIN)) * (s.hgt - 2 * PAD_Y);
  const xOf = (t, s) => PAD_L + t * (s.w - PAD_L - PAD_R);
  const toPx = (p, s) => [xOf(p.t, s), yOf(p.v, s)];
  const fromPx = (px, py, s) => ({
    t: (px - PAD_L) / (s.w - PAD_L - PAD_R),
    v: Math.exp(LMIN + (1 - (py - PAD_Y) / (s.hgt - 2 * PAD_Y)) * (LMAX - LMIN)),
  });

  /** Points as drawn: while dragging a point off the editor it is shown removed. */
  const visible = () => {
    const pts = current();
    if (!pts) return null;
    return drag?.removing ? pts.filter((_, i) => i !== drag.index) : pts;
  };

  function draw() {
    if (!g) return;
    const s = size();
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(s.w * dpr) || canvas.height !== Math.round(s.hgt * dpr)) {
      canvas.width = Math.round(s.w * dpr);
      canvas.height = Math.round(s.hgt * dpr);
    }
    const accent = cssVar(canvas, '--accent', '#4f8ff7');
    const text3 = cssVar(canvas, '--text-3', '#8d8d96');
    const line = cssVar(canvas, '--border-strong', '#44444a');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, s.w, s.hgt);
    g.fillStyle = cssVar(canvas, '--bg-input', '#18181a');
    g.fillRect(0, 0, s.w, s.hgt);
    // Speed grid on the log axis, 1x stronger.
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of GRID) {
      const y = Math.round(yOf(v, s)) + 0.5;
      g.strokeStyle = line;
      g.globalAlpha = v === 1 ? 0.9 : 0.45;
      g.setLineDash(v === 1 ? [] : [2, 4]);
      g.beginPath();
      g.moveTo(PAD_L, y);
      g.lineTo(s.w - PAD_R, y);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = text3;
      g.fillText(`${v}x`, PAD_L - 6, y);
    }
    g.setLineDash([]);
    const pts = visible();
    const clip = view.clip;
    if (pts) {
      const v = curveTable(pts).speed;
      const y1 = yOf(1, s);
      // Area against 1x: above is faster, below slower.
      g.beginPath();
      g.moveTo(xOf(0, s), y1);
      const N = 160;
      for (let i = 0; i <= N; i++) g.lineTo(xOf(i / N, s), yOf(v(i / N), s));
      g.lineTo(xOf(1, s), y1);
      g.closePath();
      g.fillStyle = accent;
      g.globalAlpha = 0.14;
      g.fill();
      g.globalAlpha = 1;
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = xOf(i / N, s);
        const y = yOf(v(i / N), s);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.stroke();
      pts.forEach((p, i) => {
        const [x, y] = toPx(p, s);
        g.beginPath();
        g.arc(x, y, i === sel ? 5.5 : 4.5, 0, Math.PI * 2);
        g.fillStyle = i === sel ? accent : cssVar(canvas, '--bg-panel', '#222224');
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = accent;
        g.stroke();
      });
    } else {
      // No curve: the flat constant speed, dimmed.
      const y = yOf(clamp(clip?.speed || 1, CURVE_MIN, CURVE_MAX), s);
      g.strokeStyle = text3;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(xOf(0, s), y);
      g.lineTo(xOf(1, s), y);
      g.stroke();
    }
    drawPlayhead(s);
  }

  function drawPlayhead(s = size()) {
    const clip = view.clip;
    if (!clip || !g) return;
    const local = store.time - clip.start;
    if (local < 0 || local > clip.duration) return;
    const x = Math.round(xOf(local / clip.duration, s)) + 0.5;
    g.strokeStyle = cssVar(canvas, '--playhead', '#ffffff');
    g.globalAlpha = 0.8;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, PAD_Y / 2);
    g.lineTo(x, s.hgt - PAD_Y / 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  function updateReadout() {
    const clip = view.clip;
    if (!clip) return;
    const pts = current();
    const p = pts?.[sel];
    if (p) readout.textContent = `Point ${sel + 1} of ${pts.length}: ${secs(p.t * clip.duration)} into the clip, ${fmtX(p.v)}x`;
    else if (pts) readout.textContent = `${pts.length} points. Speed from ${fmtX(curveTable(pts).vmin)}x to ${fmtX(curveTable(pts).vmax)}x.`;
    else readout.textContent = 'Constant speed. Pick a preset or Custom to shape the speed.';
    durNow.textContent = secs(clip.duration);
    durSrc.textContent = secs(sourceSpan(clip));
  }

  /** Write points (one undo step per run of edits). */
  function write(pts, { final = false, label = 'Edit speed curve' } = {}) {
    const clip = view.clip;
    if (!clip) return;
    run ||= { span: sourceSpan(clip) };
    const clean = pts.map((p) => {
      const q = { t: Math.round(p.t * 1e5) / 1e5, v: Math.round(p.v * 1e4) / 1e4 };
      if (Number.isFinite(p.k)) q.k = p.k;
      return q;
    });
    actions.setSpeedCurve(view.id, clean, { label, key: 'speed-curve', span: run.span });
    if (final) endRun();
  }
  const endRun = () => {
    run = null;
    store.seal();
  };

  /** Move point i to (t, v): ends keep their time, others stay between neighbors. */
  function moved(pts, i, t, v) {
    const out = pts.map((p) => ({ ...p }));
    const last = out.length - 1;
    const lo = i === 0 ? 0 : i === last ? 1 : out[i - 1].t + POINT_GAP;
    const hi = i === 0 ? 0 : i === last ? 1 : out[i + 1].t - POINT_GAP;
    const q = { t: clamp(t, lo, Math.max(lo, hi)), v: clamp(v, CURVE_MIN, CURVE_MAX) };
    // A moved point takes an automatic tangent again (except the ends of a split piece, which keep theirs).
    if ((i === 0 || i === last) && Number.isFinite(out[i].k)) q.k = out[i].k;
    out[i] = q;
    return out;
  }

  function nearest(px, py) {
    const pts = current();
    if (!pts) return -1;
    const s = size();
    let best = -1;
    let bestD = HIT;
    pts.forEach((p, i) => {
      const [x, y] = toPx(p, s);
      const d = Math.hypot(x - px, y - py);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  /** Points with one more at t, on the curve (or at speed v when given). */
  function withPoint(pts, t, v) {
    const at = clamp(t, POINT_GAP, 1 - POINT_GAP);
    if (pts.length >= MAX_POINTS || pts.some((p) => Math.abs(p.t - at) < POINT_GAP)) return null;
    const out = [...pts.map((p) => ({ ...p })), { t: at, v: clamp(v ?? curveTable(pts).speed(at), CURVE_MIN, CURVE_MAX) }];
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || view.found?.track.locked) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    const [px, py] = local(e);
    if (!current()) {
      // Clicking the flat line starts a custom curve.
      write(customStart(view.clip), { label: 'Custom speed curve' });
      custom = true;
    }
    let i = nearest(px, py);
    if (i < 0) {
      const p = fromPx(px, py, size());
      const next = withPoint(current(), p.t, p.v);
      if (!next) return;
      write(next, { label: 'Add speed point' });
      i = next.findIndex((q) => Math.abs(q.t - clamp(p.t, POINT_GAP, 1 - POINT_GAP)) < 1e-9);
    }
    sel = i;
    drag = { index: i, removing: false };
    canvas.setPointerCapture?.(e.pointerId);
    draw();
    updateReadout();
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    if (!drag) {
      canvas.style.cursor = nearest(px, py) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    const s = size();
    const pts = current();
    if (!pts) return;
    const end = drag.index === 0 || drag.index === pts.length - 1;
    const out = px < -30 || py < -30 || px > s.w + 30 || py > s.hgt + 30;
    drag.removing = out && !end && pts.length > 2;
    if (!drag.removing) {
      const p = fromPx(px, py, s);
      write(moved(pts, drag.index, p.t, p.v), { label: 'Move speed point' });
    }
    draw();
    updateReadout();
  });
  const finish = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.removing) {
      write(current().filter((_, i) => i !== d.index), { label: 'Remove speed point', final: true });
      sel = -1;
      announce('Point removed');
    } else endRun();
    draw();
    updateReadout();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('dblclick', (e) => {
    const pts = current();
    if (!pts) return;
    const i = nearest(...local(e));
    if (i <= 0 || i >= pts.length - 1) return;
    write(pts.filter((_, k) => k !== i), { label: 'Remove speed point', final: true });
    sel = -1;
    announce('Point removed');
  });
  canvas.addEventListener('keydown', (e) => {
    if (view.found?.track.locked) return;
    let pts = current();
    const keys = ['PageDown', 'PageUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', 'Insert', 'Delete', 'Backspace'];
    if (!keys.includes(e.key)) return;
    if (!pts) {
      if (e.key === 'Delete' || e.key === 'Backspace') return;
      write(customStart(view.clip), { label: 'Custom speed curve', final: true });
      custom = true;
      pts = current();
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') sel = sel < 0 ? 0 : (sel + (e.key === 'PageDown' ? 1 : -1) + pts.length) % pts.length;
    else if (e.key === 'Home') sel = 0;
    else if (e.key === 'End') sel = pts.length - 1;
    else if (e.key.startsWith('Arrow')) {
      if (sel < 0) sel = 0;
      const p = pts[sel];
      const dt = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
      const f = e.shiftKey ? 1.25 : 1.05;
      const v = e.key === 'ArrowUp' ? p.v * f : e.key === 'ArrowDown' ? p.v / f : p.v;
      write(moved(pts, sel, p.t + dt, v), { label: 'Move speed point' });
    } else if (e.key === '+' || e.key === '=' || e.key === 'Insert') {
      // Halfway between the selected point and the next one, on the curve.
      const a = clamp(sel < 0 ? 0 : sel, 0, pts.length - 2);
      const next = withPoint(pts, (pts[a].t + pts[a + 1].t) / 2);
      if (!next) return;
      write(next, { label: 'Add speed point', final: true });
      sel = a + 1;
      announce('Point added');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < pts.length - 1) {
      write(pts.filter((_, k) => k !== sel), { label: 'Remove speed point', final: true });
      sel -= 1;
      announce('Point removed');
    } else return;
    e.preventDefault();
    e.stopPropagation();
    draw();
    updateReadout();
  });
  canvas.addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow') && run) endRun();
  });
  canvas.addEventListener('blur', () => {
    if (run && !drag) endRun();
  });

  function paint() {
    const pts = current();
    if (!pts) custom = false;
    if (sel >= (pts?.length || 0)) sel = -1;
    grid.set(presetValue());
    const ramp = activeRamp(view.clip);
    origin.hidden = !ramp;
    if (ramp) origin.lastChild.textContent = ramp.tweaked ? `${ramp.ramp.label} ramp, edited` : `${ramp.ramp.label} ramp`;
    canvas.setAttribute('aria-label', pts ? `Speed curve, ${pts.length} points` : 'Speed curve, constant speed');
    draw();
    updateReadout();
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (canvas.isConnected ? draw() : ro.disconnect())) : null;
  ro?.observe(canvas);
  paint();
  view.bind(paint);
  view.bind(() => {
    if (!drag) draw();
  }, { time: true });

  const info = h('dl.insp-kv', h('dt', 'Duration'), h('dd', durNow), h('dt', 'Footage'), h('dd', durSrc));
  return h('div.speed-curve-panel',
    propSection('Curve presets', [grid.el]),
    propSection('Speed curve', [origin, h('div.speed-curve-box', canvas), readout, info, help], {
      onReset: () => {
        sel = -1;
        custom = false;
        actions.setSpeedCurve(view.id, null, { label: 'Remove speed curve' });
        store.seal();
        announce('Speed curve removed');
      },
    }),
  );
}
