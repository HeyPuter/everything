/**
 * Straight-edged preset geometries from ECMA-376 Part 1 §20.1.10.56 (ST_ShapeType) and the preset shape
 * definitions it references, written from their guide formulas: adjustment defaults, the outline path
 * and the text rectangle. Coordinates are in the shape's own units (EMU); `adj` reads a resolved
 * adjustment value. Each returns { points, textRect } with the text rectangle as fractions of w and h.
 */
import { MORE_PRESET_GEOMETRIES } from './preset-geometries-more.js';
export { PRESET_CATEGORIES } from './preset-geometries-more.js';
const pin = (low, value, high) => Math.max(low, Math.min(high, value));
const degrees = angle => angle * Math.PI / 180;

export const PRESET_GEOMETRIES = {
  ...MORE_PRESET_GEOMETRIES,
  diamond: {
    defaults: {},
    build: (w, h) => ({ points: [['M', 0, h / 2], ['L', w / 2, 0], ['L', w, h / 2], ['L', w / 2, h], ['Z']], text: [w / 4, h / 4, w * 3 / 4, h * 3 / 4] }),
  },
  parallelogram: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), maxAdj = 100000 * w / ss, a = pin(0, adj('adj'), maxAdj), x2 = ss * a / 100000;
      const q2 = (1 + 5 * a / maxAdj) / 12, il = q2 * w, it = q2 * h;
      return { points: [['M', 0, h], ['L', x2, 0], ['L', w, 0], ['L', w - x2, h], ['Z']], text: [il, it, w - il, h - it] };
    },
  },
  trapezoid: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), maxAdj = 50000 * w / ss, a = pin(0, adj('adj'), maxAdj), x2 = ss * a / 100000;
      const il = w / 3 * a / maxAdj, it = h / 3 * a / maxAdj;
      return { points: [['M', 0, h], ['L', x2, 0], ['L', w - x2, 0], ['L', w, h], ['Z']], text: [il, it, w - il, h] };
    },
  },
  pentagon: {
    defaults: { hf: 105146, vf: 110557 },
    build: (w, h, adj) => {
      const swd2 = w / 2 * adj('hf') / 100000, shd2 = h / 2 * adj('vf') / 100000, svc = h / 2 * adj('vf') / 100000;
      const dx1 = swd2 * Math.cos(degrees(18)), dx2 = swd2 * Math.cos(degrees(306));
      const dy1 = shd2 * Math.sin(degrees(18)), dy2 = shd2 * Math.sin(degrees(306));
      const x1 = w / 2 - dx1, x2 = w / 2 - dx2, x3 = w / 2 + dx2, x4 = w / 2 + dx1, y1 = svc - dy1, y2 = svc - dy2;
      return { points: [['M', x1, y1], ['L', w / 2, 0], ['L', x4, y1], ['L', x3, y2], ['L', x2, y2], ['Z']], text: [x2, y1 * dx2 / dx1, x3, y2] };
    },
  },
  plus: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a = pin(0, adj('adj'), 50000), x1 = ss * a / 100000, x2 = w - x1, y2 = h - x1, wide = w - h > 0;
      return { points: [['M', 0, x1], ['L', x1, x1], ['L', x1, 0], ['L', x2, 0], ['L', x2, x1], ['L', w, x1], ['L', w, y2], ['L', x2, y2], ['L', x2, h], ['L', x1, h], ['L', x1, y2], ['L', 0, y2], ['Z']],
        text: wide ? [0, x1, w, y2] : [x1, 0, x2, h] };
    },
  },
  rightArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), a2 = pin(0, adj('adj2'), 100000 * w / ss);
      const dx1 = ss * a2 / 100000, x1 = w - dx1, dy1 = h * a1 / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1, x2 = x1 + y1 * dx1 / (h / 2);
      return { points: [['M', 0, y1], ['L', x1, y1], ['L', x1, 0], ['L', w, h / 2], ['L', x1, h], ['L', x1, y2], ['L', 0, y2], ['Z']], text: [0, y1, x2, y2] };
    },
  },
  leftArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), a2 = pin(0, adj('adj2'), 100000 * w / ss);
      const dx2 = ss * a2 / 100000, x2 = dx2, dy1 = h * a1 / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1, x1 = x2 - y1 * dx2 / (h / 2);
      return { points: [['M', 0, h / 2], ['L', x2, 0], ['L', x2, y1], ['L', w, y1], ['L', w, y2], ['L', x2, y2], ['L', x2, h], ['Z']], text: [x1, y1, w, y2] };
    },
  },
  upArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), a2 = pin(0, adj('adj2'), 100000 * h / ss);
      const dy2 = ss * a2 / 100000, y2 = dy2, dx1 = w * a1 / 200000, x1 = w / 2 - dx1, x2 = w / 2 + dx1, y1 = y2 - x1 * dy2 / (w / 2);
      return { points: [['M', 0, y2], ['L', w / 2, 0], ['L', w, y2], ['L', x2, y2], ['L', x2, h], ['L', x1, h], ['L', x1, y2], ['Z']], text: [x1, y1, x2, h] };
    },
  },
  leftRightArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), a2 = pin(0, adj('adj2'), 50000 * w / ss);
      const x2 = ss * a2 / 100000, x3 = w - x2, dy = h * a1 / 200000, y1 = h / 2 - dy, y2 = h / 2 + dy, dx1 = y1 * x2 / (h / 2);
      return { points: [['M', 0, h / 2], ['L', x2, 0], ['L', x2, y1], ['L', x3, y1], ['L', x3, 0], ['L', w, h / 2], ['L', x3, h], ['L', x3, y2], ['L', x2, y2], ['L', x2, h], ['Z']],
        text: [x2 - dx1, y1, x3 + dx1, y2] };
    },
  },
  star4: {
    defaults: { adj: 12500 },
    build: (w, h, adj) => {
      const a = pin(0, adj('adj'), 50000), iwd2 = w / 2 * a / 50000, ihd2 = h / 2 * a / 50000;
      const sdx = iwd2 * Math.cos(degrees(45)), sdy = ihd2 * Math.sin(degrees(45));
      const sx1 = w / 2 - sdx, sx2 = w / 2 + sdx, sy1 = h / 2 - sdy, sy2 = h / 2 + sdy;
      return { points: [['M', 0, h / 2], ['L', sx1, sy1], ['L', w / 2, 0], ['L', sx2, sy1], ['L', w, h / 2], ['L', sx2, sy2], ['L', w / 2, h], ['L', sx1, sy2], ['Z']], text: [sx1, sy1, sx2, sy2] };
    },
  },
};
