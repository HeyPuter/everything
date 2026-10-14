/**
 * Temporary dimensions shown for a single selected element. Each one can
 * be clicked and typed to move the element: { a, b, value, apply(doc, mm) }.
 */
import { add, scale, sub, norm, dist } from '../core/geom.js';
import { wallAxis, openingSize } from '../core/model.js';

export function temporaryDimensions(doc, el) {
  if (el.kind === 'wall') {
    const L = dist(el.a, el.b);
    if (L < 1) return [];
    const ax = wallAxis(doc, el);
    const off = scale(ax.n, ax.half);
    return [
      {
        a: add(el.a, off),
        b: add(el.b, off),
        value: L,
        offsetPx: 20,
        apply: (d, mm) => {
          if (mm <= 1) return;
          d.update(el.id, { b: add(el.a, scale(norm(sub(el.b, el.a)), mm)) });
        },
      },
    ];
  }
  if (el.kind === 'door' || el.kind === 'window' || el.kind === 'opening') {
    const host = doc.get(el.hostId);
    if (!host) return [];
    const ax = wallAxis(doc, host);
    const { width } = openingSize(doc, el);
    const side = scale(ax.n, ax.half);
    const P = (u) => add(add(ax.a, scale(ax.dir, u)), side);
    const left = el.t - width / 2;
    const right = ax.length - el.t - width / 2;
    const clampT = (t) => Math.max(width / 2, Math.min(ax.length - width / 2, t));
    return [
      { a: P(0), b: P(left), value: left, offsetPx: 16, apply: (d, mm) => d.update(el.id, { t: clampT(mm + width / 2) }) },
      { a: P(el.t + width / 2), b: P(ax.length), value: right, offsetPx: 16, apply: (d, mm) => d.update(el.id, { t: clampT(ax.length - mm - width / 2) }) },
    ];
  }
  return [];
}
