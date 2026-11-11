/**
 * Time ruler drawn on a canvas the width of the viewport; redrawn on scroll
 * and zoom. Tick spacing adapts from single frames to minutes.
 */
import { US, rulerLabel } from '../../lib/time.js';

const SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Major tick interval in microseconds so labels are at least minPx apart. */
export function tickInterval(pps, fps, minPx = 72) {
  for (const f of [1, 2, 5, 10, 15]) {
    const sec = f / fps;
    if (f < fps && sec * pps >= minPx) return { major: Math.round(sec * US), frames: true, minorDiv: f === 1 ? 1 : f >= 10 ? 5 : f };
  }
  for (const s of SECONDS) {
    if (s * pps >= minPx) return { major: s * US, frames: false, minorDiv: s === 1 ? Math.min(fps, 10) : s % 5 === 0 ? 5 : s };
  }
  return { major: 3600 * US, frames: false, minorDiv: 6 };
}

export function drawRuler(canvas, { scrollLeft, width, pps, pad, fps, colors, markers = [], range = null, startLabelX = 3 }) {
  const dpr = globalThis.devicePixelRatio || 1;
  const h = canvas.clientHeight || 24;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${width}px`;
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, h);
  const { major, frames, minorDiv } = tickInterval(pps, fps);
  const minor = major / Math.max(1, minorDiv);
  const t0 = Math.max(0, ((scrollLeft - pad) / pps) * US);
  const t1 = ((scrollLeft + width - pad) / pps) * US;
  const first = Math.floor(t0 / minor) * minor;
  // In/out range: a tinted band with brackets at both ends.
  if (range) {
    const xa = pad + (range.in / US) * pps - scrollLeft;
    const xb = pad + (range.out / US) * pps - scrollLeft;
    if (xb > -4 && xa < width + 4) {
      g.fillStyle = colors.range || 'rgba(79,143,247,0.22)';
      g.fillRect(xa, 0, xb - xa, h);
      g.fillStyle = colors.rangeEdge || '#4f8ff7';
      g.fillRect(xa, 0, 2, h);
      g.fillRect(xa, 0, 6, 2);
      g.fillRect(xa, h - 2, 6, 2);
      g.fillRect(xb - 2, 0, 2, h);
      g.fillRect(xb - 6, 0, 6, 2);
      g.fillRect(xb - 6, h - 2, 6, 2);
    }
  }
  g.font = '500 10px Inter, system-ui, sans-serif';
  g.textBaseline = 'top';
  g.lineWidth = 1;
  for (let t = first; t <= t1 + minor; t += minor) {
    const x = Math.round(pad + (t / US) * pps - scrollLeft) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.strokeStyle = isMajor ? colors.major : colors.minor;
    g.beginPath();
    g.moveTo(x, isMajor ? h - 10 : h - 5);
    g.lineTo(x, h);
    g.stroke();
    if (isMajor) {
      g.fillStyle = colors.text;
      // The first label starts clear of the playhead handle, which rests on time 0.
      g.fillText(rulerLabel(Math.round(t), fps, frames), x + (t === 0 ? startLabelX : 3), 4);
    }
  }
  for (const m of markers) {
    const x = pad + (m.time / US) * pps - scrollLeft;
    if (x < -8 || x > width + 8) continue;
    g.fillStyle = m.color || colors.marker;
    g.beginPath();
    g.moveTo(x - 4, h - 10);
    g.lineTo(x + 4, h - 10);
    g.lineTo(x + 4, h - 4);
    g.lineTo(x, h);
    g.lineTo(x - 4, h - 4);
    g.closePath();
    g.fill();
    if (m.label && pps > 4) {
      g.font = '600 10px Inter, system-ui, sans-serif';
      const label = m.label.length > 24 ? `${m.label.slice(0, 23)}…` : m.label;
      const tw = g.measureText(label).width;
      g.fillStyle = colors.labelBg || 'rgba(0,0,0,0.55)';
      g.fillRect(x + 6, h - 14, tw + 6, 12);
      g.fillStyle = m.color || colors.marker;
      g.fillText(label, x + 9, h - 13);
    }
  }
}
