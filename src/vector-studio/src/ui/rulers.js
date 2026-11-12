/**
 * Rulers along the top and left of the canvas. Zero is the active
 * artboard's top-left (artboard rulers). Dragging from a ruler creates a
 * guide; the pointer position shows as a tick on both rulers.
 */
import { h } from '../lib/dom.js';
import { UNITS } from '../lib/units.js';

const SIZE = 18;

/** A "nice" tick step in document units for the zoom. */
export function tickStep(zoom, unitFactor) {
  const targetPx = 60;
  const raw = targetPx / zoom / unitFactor;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

export function createRulers(app, host) {
  const top = h('canvas.ruler.ruler-top', { 'aria-hidden': 'true' });
  const left = h('canvas.ruler.ruler-left', { 'aria-hidden': 'true' });
  const corner = h('div.ruler-corner', { 'aria-hidden': 'true' });
  const tickX = h('div.ruler-tick.x', { 'aria-hidden': 'true', hidden: true });
  const tickY = h('div.ruler-tick.y', { 'aria-hidden': 'true', hidden: true });
  host.append(top, left, corner, tickX, tickY);
  let pointer = null;
  let palette = null;
  window.addEventListener('themechange', () => {
    palette = null;
  });
  let frame = 0;

  const draw = () => {
    frame = 0;
    const ed = app.editor;
    const show = Boolean(ed?.viewOptions.rulers);
    host.classList.toggle('has-rulers', show);
    if (!show) return;
    const v = ed.view;
    const dpr = v.dpr || 1;
    // Colors are cached per theme; reading styles on every pointer move forces style recalculation.
    if (!palette) {
      const cs = getComputedStyle(host);
      palette = { bg: cs.getPropertyValue('--ruler-bg').trim() || '#2b2b2b', fg: cs.getPropertyValue('--ruler-fg').trim() || '#999', accent: cs.getPropertyValue('--accent').trim() || '#3b82f6' };
    }
    const { bg, fg } = palette;
    const unit = ed.doc.root.units || 'pt';
    const factor = UNITS[unit]?.factor || 1;
    // Artboard rulers measure from the active artboard; app.rulerOrigin can switch to global rulers.
    const origin = app.rulerOrigin?.(ed) || ed.artboard() || { x: 0, y: 0 };
    const rotated = Boolean(v.rotation);
    for (const [cv, horizontal] of [
      [top, true],
      [left, false],
    ]) {
      const w = horizontal ? v.width : SIZE;
      const hh = horizontal ? SIZE : v.height;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(hh * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${hh}px`;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, hh);
      ctx.fillStyle = fg;
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      ctx.font = '9px Inter, system-ui, sans-serif';
      if (rotated) continue;
      const step = tickStep(v.zoom, factor);
      const stepPt = step * factor;
      const len = horizontal ? w : hh;
      // Document coordinate at screen 0 and per-pixel.
      const d0 = horizontal ? v.toDoc(0, 0).x - origin.x : v.toDoc(0, 0).y - origin.y;
      const d1 = horizontal ? v.toDoc(len, 0).x - origin.x : v.toDoc(0, len).y - origin.y;
      const startTick = Math.floor(d0 / stepPt) * stepPt;
      ctx.beginPath();
      // Count the ticks rather than adding the step to a coordinate: far from the origin the step
      // can be lost in float precision, and the loop would never end. At most one tick per pixel.
      const ticks = Math.min(
        Math.floor((d1 + stepPt - startTick) / (stepPt / 10)),
        Math.ceil(len) + 20,
      );
      for (let k = 0; k <= ticks; k++) {
        const d = startTick + (k * stepPt) / 10;
        const s = horizontal ? v.toScreen(d + origin.x, 0).x : v.toScreen(0, d + origin.y).y;
        const major = k % 10 === 0;
        const mid = k % 5 === 0;
        const tl = major ? SIZE : mid ? 6 : 3;
        const p = Math.round(s) + 0.5;
        if (horizontal) {
          ctx.moveTo(p, SIZE);
          ctx.lineTo(p, SIZE - tl);
        } else {
          ctx.moveTo(SIZE, p);
          ctx.lineTo(SIZE - tl, p);
        }
        if (major) {
          const label = String(Number((d / factor).toFixed(2)));
          if (horizontal) ctx.fillText(label, p + 3, 9);
          else {
            ctx.save();
            ctx.translate(9, p + 3);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label, 0, 0);
            ctx.restore();
          }
        }
      }
      ctx.stroke();
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // Drag out a guide.
  const startGuide = (axis) => (e) => {
    const ed = app.editor;
    if (!ed || ed.viewOptions.lockGuides) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const canvasRect = app.canvasHost.getBoundingClientRect();
    let pos = null;
    const move = (ev) => {
      const p = ed.view.toDoc(ev.clientX - canvasRect.left, ev.clientY - canvasRect.top);
      pos = axis === 'x' ? p.x : p.y;
      ed.alignmentGuides = { lines: axis === 'x' ? [{ x1: pos, y1: -1e6, x2: pos, y2: 1e6 }] : [{ x1: -1e6, y1: pos, x2: 1e6, y2: pos }], labels: [] };
      ed.emit('overlay');
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      ed.alignmentGuides = null;
      // Released over the rulers, the panels or the status bar, or the system took the touch:
      // no guide.
      const inside = ev.clientX > canvasRect.left && ev.clientY > canvasRect.top && ev.clientX < canvasRect.right && ev.clientY < canvasRect.bottom;
      if (pos != null && inside && ev.type === 'pointerup') {
        ed.doc.transact('Add Guide', () => ed.doc.updateRoot({ guides: [...(ed.doc.root.guides || []), { axis, pos }] }));
        if (!ed.viewOptions.guides) ed.setViewOption('guides', true);
      }
      ed.emit('overlay');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  // The top ruler makes horizontal guides (constant y); the left one vertical guides.
  for (const [el, axis] of [
    [top, 'y'],
    [left, 'x'],
  ]) {
    el.addEventListener('pointerdown', startGuide(axis));
    // Touch screens move a finger's press to the nearest element that takes
    // clicks (the document tabs, the canvas); a mouse listener makes the thin
    // rulers count as one, so a finger on a ruler drags out a guide.
    el.addEventListener('mousedown', () => {});
  }
  corner.addEventListener('dblclick', () => app.editor && app.editor.setViewOption('rulers', true));

  return {
    refresh: schedule,
    // The pointer tick is a positioned element, so pointer moves never repaint the rulers.
    setPointer: (p) => {
      pointer = p;
      const show = Boolean(p && app.editor?.viewOptions.rulers);
      tickX.hidden = tickY.hidden = !show;
      if (!show) return;
      tickX.style.transform = `translateX(${p.sx}px)`;
      tickY.style.transform = `translateY(${p.sy}px)`;
    },
  };
}
