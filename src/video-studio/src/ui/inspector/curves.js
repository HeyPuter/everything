/**
 * Color > Curves: luma (master) plus red, green and blue tone curves on a
 * square editor. Click to add a point, drag to move it, drag it off the
 * square or double-click it to delete; endpoints stay. Keyboard: Page Up /
 * Page Down choose a point, arrow keys move it (Shift for bigger steps),
 * + or Insert adds one, Delete removes it.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { CURVE_CHANNELS, monotoneCurve, isIdentityCurve } from '../../model/color.js';
import { uidFor, keepFocus } from './common.js';
import { gradeSection, editGrade } from './color-common.js';

const IDENTITY = [[0, 0], [1, 1]];
const PAD = 8; // CSS px inside the square so the end points are fully visible
const HIT = 11; // CSS px grab radius
const GAP = 0.01; // minimum x distance between points

const pointsOf = (clip, ch) => {
  const p = clip?.grade?.curves?.[ch];
  return Array.isArray(p) && p.length >= 2 ? p : IDENTITY;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function curvesTab(view, state = {}) {
  let ch = CURVE_CHANNELS.some((c) => c.id === state.curveChannel) ? state.curveChannel : 'master';
  let sel = -1; // selected point index (keyboard and highlight)
  let drag = null; // { index, removing }
  const channel = () => CURVE_CHANNELS.find((c) => c.id === ch);

  // Channel picker.
  const chBtns = CURVE_CHANNELS.map((c) => {
    const b = h('button', { type: 'button', role: 'radio', dataset: { ch: c.id }, style: { '--dot': c.color } }, h('span.curve-dot', { 'aria-hidden': 'true' }), c.label);
    b.addEventListener('click', () => pick(c.id));
    return b;
  });
  const chGroup = h('div.segmented.curve-channels', { role: 'radiogroup', 'aria-label': 'Curve' }, chBtns);
  chGroup.addEventListener('keydown', (e) => {
    const i = CURVE_CHANNELS.findIndex((c) => c.id === ch);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % CURVE_CHANNELS.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + CURVE_CHANNELS.length) % CURVE_CHANNELS.length;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    pick(CURVE_CHANNELS[j].id);
    chBtns[j].focus();
  });
  const resetCurve = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Reset this curve', 'data-tip': 'Reset this curve' }, icon('rotateLeft', 14));
  // The button turns off once the curve is straight; focus goes to the curve.
  resetCurve.addEventListener('click', () => keepFocus(() => {
    editGrade(view, `Reset ${channel().label.toLowerCase()} curve`, (g) => {
      if (!g.curves[ch]) return false;
      delete g.curves[ch];
    });
    sel = -1;
  }, () => canvas));

  // Editor.
  const helpId = uidFor('curve-help');
  const canvas = h('canvas.curve-canvas', { tabindex: '0', role: 'application', 'aria-roledescription': 'curve editor', 'aria-describedby': helpId });
  const readout = h('div.curve-readout', { 'aria-live': 'polite' });
  const help = h('p.curve-help', { id: helpId }, 'Click to add a point and drag to shape the curve. Drag a point off the square or double-click it to remove it.');
  const ctx2d = canvas.getContext('2d');

  const size = () => {
    const w = canvas.clientWidth || 260;
    return { w, hgt: canvas.clientHeight || w };
  };
  const toPx = ([x, y], { w, hgt }) => [PAD + x * (w - 2 * PAD), hgt - PAD - y * (hgt - 2 * PAD)];
  const fromPx = (px, py, { w, hgt }) => [(px - PAD) / (w - 2 * PAD), (hgt - PAD - py) / (hgt - 2 * PAD)];

  function draw() {
    if (!ctx2d) return;
    const s = size();
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(s.w * dpr) || canvas.height !== Math.round(s.hgt * dpr)) {
      canvas.width = Math.round(s.w * dpr);
      canvas.height = Math.round(s.hgt * dpr);
    }
    const g = ctx2d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, s.w, s.hgt);
    g.fillStyle = '#121214';
    g.fillRect(0, 0, s.w, s.hgt);
    // Grid in quarters and the neutral diagonal.
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const [x] = toPx([i / 4, 0], s);
      const [, y] = toPx([0, i / 4], s);
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, PAD);
      g.lineTo(Math.round(x) + 0.5, s.hgt - PAD);
      g.moveTo(PAD, Math.round(y) + 0.5);
      g.lineTo(s.w - PAD, Math.round(y) + 0.5);
      g.stroke();
    }
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(...toPx([0, 0], s));
    g.lineTo(...toPx([1, 1], s));
    g.stroke();
    g.setLineDash([]);
    const clip = view.clip;
    const plot = (pts, color, width, alpha) => {
      const f = monotoneCurve(pts);
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i <= 128; i++) {
        const x = i / 128;
        const [px, py] = toPx([x, clamp(f(x), 0, 1)], s);
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
      g.globalAlpha = 1;
    };
    // The other changed curves, faintly.
    for (const c of CURVE_CHANNELS) {
      if (c.id === ch) continue;
      const pts = pointsOf(clip, c.id);
      if (!isIdentityCurve(pts)) plot(pts, c.color, 1, 0.35);
    }
    const pts = visiblePoints();
    plot(pts, channel().color, 2, 1);
    pts.forEach((p, i) => {
      const [px, py] = toPx(p, s);
      g.beginPath();
      g.arc(px, py, i === sel ? 5 : 4, 0, Math.PI * 2);
      g.fillStyle = i === sel ? channel().color : '#121214';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = channel().color;
      g.stroke();
    });
  }

  /** Points as drawn: while dragging a point off the square it is shown removed. */
  function visiblePoints() {
    const pts = pointsOf(view.clip, ch);
    return drag?.removing ? pts.filter((_, i) => i !== drag.index) : pts;
  }

  function updateReadout() {
    const pts = pointsOf(view.clip, ch);
    const p = pts[sel];
    readout.textContent = p ? `Point ${sel + 1} of ${pts.length}: input ${Math.round(p[0] * 255)}, output ${Math.round(p[1] * 255)}` : `${channel().label} curve, ${pts.length} points`;
  }

  function write(pts, { final = true, label = 'Edit curve' } = {}) {
    editGrade(view, `${label} (${channel().label.toLowerCase()})`, (g) => {
      // Extra points on the diagonal stay (the user is about to drag them).
      if (pts.length <= 2 && isIdentityCurve(pts)) delete g.curves[ch];
      else g.curves[ch] = pts.map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
    }, { key: `curve-${ch}`, final });
  }

  /** Move point i to (x, y), kept between its neighbors. */
  function moved(pts, i, x, y) {
    const out = pts.map((p) => [...p]);
    const lo = i > 0 ? out[i - 1][0] + GAP : 0;
    const hi = i < out.length - 1 ? out[i + 1][0] - GAP : 1;
    out[i] = [clamp(x, lo, Math.max(lo, hi)), clamp(y, 0, 1)];
    return out;
  }

  function nearest(px, py) {
    const s = size();
    let best = -1;
    let bestD = HIT;
    pointsOf(view.clip, ch).forEach((p, i) => {
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

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    const [px, py] = local(e);
    let i = nearest(px, py);
    if (i < 0) {
      // A new point where the user clicked.
      const [x, y] = fromPx(px, py, size());
      const pts = pointsOf(view.clip, ch).map((p) => [...p]);
      const nx = clamp(x, 0, 1);
      if (pts.some((p) => Math.abs(p[0] - nx) < GAP)) return;
      pts.push([nx, clamp(y, 0, 1)]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex((p) => p[0] === nx);
      write(pts, { final: false, label: 'Add curve point' });
    }
    sel = i;
    drag = { index: i, removing: false };
    canvas.setPointerCapture?.(e.pointerId);
    draw();
    updateReadout();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const [px, py] = local(e);
      canvas.style.cursor = nearest(px, py) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    const [px, py] = local(e);
    const s = size();
    const pts = pointsOf(view.clip, ch);
    const end = drag.index === 0 || drag.index === pts.length - 1;
    const out = px < -30 || py < -30 || px > s.w + 30 || py > s.hgt + 30;
    drag.removing = out && !end && pts.length > 2;
    if (!drag.removing) {
      const [x, y] = fromPx(px, py, s);
      write(moved(pts, drag.index, x, y), { final: false, label: 'Move curve point' });
    }
    draw();
    updateReadout();
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.removing) {
      write(pointsOf(view.clip, ch).filter((_, i) => i !== d.index), { label: 'Remove curve point' });
      sel = -1;
    } else view.store.seal();
    draw();
    updateReadout();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const [px, py] = local(e);
    const i = nearest(px, py);
    const pts = pointsOf(view.clip, ch);
    if (i <= 0 || i >= pts.length - 1) return;
    write(pts.filter((_, k) => k !== i), { label: 'Remove curve point' });
    sel = -1;
  });
  canvas.addEventListener('keydown', (e) => {
    const pts = pointsOf(view.clip, ch);
    const step = e.shiftKey ? 0.05 : 1 / 255;
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      sel = sel < 0 ? 0 : (sel + (e.key === 'PageDown' ? 1 : -1) + pts.length) % pts.length;
    } else if (e.key === 'Home') sel = 0;
    else if (e.key === 'End') sel = pts.length - 1;
    else if (e.key.startsWith('Arrow')) {
      if (sel < 0) sel = 0;
      const [x, y] = pts[sel];
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
      write(moved(pts, sel, x + dx, y + dy), { final: false, label: 'Move curve point' });
    } else if (e.key === '+' || e.key === '=' || e.key === 'Insert') {
      // Halfway between the selected point and the next one, on the curve.
      const a = Math.max(0, Math.min(pts.length - 2, sel < 0 ? 0 : sel));
      const x = (pts[a][0] + pts[a + 1][0]) / 2;
      if (pts[a + 1][0] - pts[a][0] < GAP * 2) return;
      const next = [...pts.map((p) => [...p]), [x, clamp(monotoneCurve(pts)(x), 0, 1)]].sort((p, q) => p[0] - q[0]);
      write(next, { label: 'Add curve point' });
      sel = a + 1;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < pts.length - 1) {
      write(pts.filter((_, k) => k !== sel), { label: 'Remove curve point' });
      sel -= 1;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    draw();
    updateReadout();
  });
  canvas.addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow')) view.store.seal();
  });

  function paint() {
    chBtns.forEach((b) => {
      const on = b.dataset.ch === ch;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('changed', !isIdentityCurve(pointsOf(view.clip, b.dataset.ch)));
    });
    canvas.setAttribute('aria-label', `${channel().label} curve`);
    const cur = pointsOf(view.clip, ch);
    resetCurve.disabled = cur.length <= 2 && isIdentityCurve(cur);
    if (sel >= pointsOf(view.clip, ch).length) sel = -1;
    draw();
    updateReadout();
  }

  function pick(id) {
    ch = id;
    state.curveChannel = id;
    sel = -1;
    paint();
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (canvas.isConnected ? draw() : ro.disconnect())) : null;
  ro?.observe(canvas);
  paint();
  view.bind(paint);
  return h('div.curves-tab', gradeSection(view, {
    id: 'curves',
    title: 'Curves',
    children: [
      h('div.curve-head', chGroup, resetCurve),
      h('div.curve-box', canvas),
      readout,
      help,
    ],
    onReset: () => {
      editGrade(view, 'Reset curves', (g) => {
        g.curves = {};
      });
      sel = -1;
    },
  }));
}
