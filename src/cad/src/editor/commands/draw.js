/**
 * Drawing commands: lines, polylines, circles, arcs, shapes, curves, points.
 */
import { opts } from '../input.js';
import { formatLinear } from '../../core/units.js';
import { splineFromFitPoints } from '../../core/geom/index.js';
import { TAU, norm, dist, angleOf, polar, circle3, arc3, tangentBulge, endTangent, polygonPoints, circleTTR } from './util.js';

const COLLINEAR = 'The three points are in line (or repeated). Pick a point off that line.';

const line = (ed, a, b) => ed.make('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });

export const LINE = {
  name: 'LINE',
  aliases: ['L'],
  label: 'Line',
  icon: 'line',
  async run(ed) {
    let first = await ed.getPoint('First point (Enter to continue from the last point)');
    if (!first) {
      if (!ed.lastLineEnd) return;
      first = ed.lastLineEnd;
    }
    const pts = [first];
    const ids = [];
    for (;;) {
      const prev = pts.at(-1);
      const options = pts.length >= 3 ? opts('Close', 'Undo') : opts('Undo');
      const r = await ed.getPoint('Next point', { base: prev, options, preview: (p) => [line(ed, prev, p)] });
      if (r === null) break;
      if (r.option === 'undo') {
        if (ids.length) {
          const id = ids.pop();
          ed.commit('Undo segment', () => ed.drawing.remove(id));
        }
        if (pts.length > 1) pts.pop();
        ed.lastLineEnd = pts.at(-1);
        continue;
      }
      if (r.option === 'close') {
        ed.commit('Line', () => ids.push(ed.drawing.add(line(ed, prev, first)).id));
        ed.lastLineEnd = first;
        break;
      }
      ed.commit('Line', () => ids.push(ed.drawing.add(line(ed, prev, r)).id));
      pts.push(r);
      ed.lastLineEnd = r;
    }
  },
};

export const XLINE = {
  name: 'XLINE',
  aliases: ['XL'],
  label: 'Construction line',
  icon: 'xline',
  async run(ed) {
    const r = await ed.getPoint('Point', { options: opts('Hor', 'Ver', 'Ang') });
    if (!r) return;
    let fixed = null;
    if (r.option === 'hor') fixed = 0;
    else if (r.option === 'ver') fixed = Math.PI / 2;
    else if (r.option === 'ang') {
      const a = await ed.getAngle('Angle of construction line', { default: 0 });
      if (a === null || a.option) return;
      fixed = a;
    }
    if (fixed !== null) {
      for (;;) {
        const p = await ed.getPoint('Through point', {
          preview: (c) => [ed.make('xline', { x: c.x, y: c.y, dx: Math.cos(fixed), dy: Math.sin(fixed) })],
        });
        if (!p || p.option) return;
        ed.commit('Construction line', () => ed.drawing.add(ed.make('xline', { x: p.x, y: p.y, dx: Math.cos(fixed), dy: Math.sin(fixed) })));
      }
    }
    const base = r;
    const mk = (c) => {
      const l = dist(base, c);
      return l < 1e-12 ? null : ed.make('xline', { x: base.x, y: base.y, dx: (c.x - base.x) / l, dy: (c.y - base.y) / l });
    };
    for (;;) {
      const p = await ed.getPoint('Through point', { base, preview: (c) => [mk(c)].filter(Boolean) });
      if (!p || p.option) return;
      const e = mk(p);
      if (e) ed.commit('Construction line', () => ed.drawing.add(e));
    }
  },
};

export const RAY = {
  name: 'RAY',
  label: 'Ray',
  icon: 'ray',
  async run(ed) {
    const base = await ed.getPoint('Start point');
    if (!base || base.option) return;
    const mk = (c) => {
      const l = dist(base, c);
      return l < 1e-12 ? null : ed.make('ray', { x: base.x, y: base.y, dx: (c.x - base.x) / l, dy: (c.y - base.y) / l });
    };
    for (;;) {
      const p = await ed.getPoint('Through point', { base, preview: (c) => [mk(c)].filter(Boolean) });
      if (!p || p.option) return;
      const e = mk(p);
      if (e) ed.commit('Ray', () => ed.drawing.add(e));
    }
  },
};

export const PLINE = {
  name: 'PLINE',
  aliases: ['PL', 'POLYLINE'],
  label: 'Polyline',
  icon: 'polyline',
  async run(ed) {
    const first = await ed.getPoint('Start point');
    if (!first || first.option) return;
    const drawing = ed.drawing;
    const verts = [{ x: first.x, y: first.y, b: 0 }];
    let arcMode = false;
    let width = ed.plineWidth ?? 0;
    const build = (extra, closed = false) => {
      const all = extra ? verts.concat([extra]) : verts;
      const pts = [];
      for (const v of all) pts.push(v.x, v.y, v.b);
      return ed.make('polyline', { pts, closed, width });
    };
    // Escape keeps the segments drawn so far, as LINE does (unless the
    // drawing itself was switched or closed).
    const keepOnCancel = () => {
      if (verts.length >= 2 && ed.doc?.drawing === drawing) ed.commit('Polyline', () => ed.drawing.add(build(null)));
    };
    const arcBulge = (p) => {
      const last = verts.at(-1);
      const t = endTangent(verts) ?? { x: 1, y: 0 };
      return tangentBulge(last, t.x, t.y, p);
    };
    // No arc leaves along the tangent and ends straight behind it (it would
    // be a circle of infinite radius).
    const behind = (p) => {
      const last = verts.at(-1);
      const t = endTangent(verts) ?? { x: 1, y: 0 };
      const cx = p.x - last.x,
        cy = p.y - last.y;
      const cl = Math.hypot(cx, cy);
      return cl > 1e-12 && Math.abs(t.x * cy - t.y * cx) <= 1e-9 * cl && t.x * cx + t.y * cy < 0;
    };
    const rejectBehind = (p) => {
      if (!arcMode || !behind(p)) return false;
      ed.ui.log('The arc cannot end straight behind its start direction.', 'error');
      return true;
    };
    for (;;) {
      const last = verts.at(-1);
      const options = arcMode ? opts('Line', 'Close', 'Undo', 'Width') : opts('Arc', 'Close', 'Undo', 'Width');
      if (verts.length < 2) options.splice(1, 1);
      let r;
      try {
        r = await ed.getPoint(arcMode ? 'Arc end point' : 'Next point', {
          base: last,
          options,
          preview: (p) => {
            const b = arcMode && !behind(p) ? arcBulge(p) : 0;
            const tmp = verts.map((v) => ({ ...v }));
            tmp[tmp.length - 1].b = b;
            const pts = [];
            for (const v of tmp) pts.push(v.x, v.y, v.b);
            pts.push(p.x, p.y, 0);
            return [ed.make('polyline', { pts, closed: false, width })];
          },
        });
      } catch (err) {
        keepOnCancel();
        throw err;
      }
      if (r === null) break;
      if (r.option === 'arc') {
        arcMode = true;
        continue;
      }
      if (r.option === 'line') {
        arcMode = false;
        continue;
      }
      if (r.option === 'undo') {
        if (verts.length > 1) {
          verts.pop();
          verts.at(-1).b = 0;
        }
        continue;
      }
      if (r.option === 'width') {
        let w;
        try {
          w = await ed.getDistance('Width', { default: width });
        } catch (err) {
          keepOnCancel();
          throw err;
        }
        if (typeof w === 'number' && w >= 0) width = ed.plineWidth = w;
        else if (typeof w === 'number') ed.ui.log('The width cannot be negative.', 'error');
        continue;
      }
      if (r.option === 'close') {
        if (rejectBehind(first)) continue;
        if (arcMode) last.b = arcBulge(first);
        const pts = [];
        for (const v of verts) pts.push(v.x, v.y, v.b);
        ed.commit('Polyline', () => ed.drawing.add(ed.make('polyline', { pts, closed: true, width })));
        return;
      }
      if (rejectBehind(r)) continue;
      last.b = arcMode ? arcBulge(r) : 0;
      verts.push({ x: r.x, y: r.y, b: 0 });
    }
    if (verts.length >= 2) ed.commit('Polyline', () => ed.drawing.add(build(null)));
  },
};

export const RECTANG = {
  name: 'RECTANG',
  aliases: ['REC', 'RECTANGLE'],
  label: 'Rectangle',
  icon: 'rectangle',
  async run(ed) {
    // The fillet radius stays for later rectangles until it is set back to zero.
    let fillet = ed.rectFillet ?? 0;
    if (fillet > 0) ed.ui.log(`Current fillet radius: ${formatLinear(fillet, ed.header)}`, 'muted');
    let a = await ed.getPoint('First corner', { options: opts('Fillet') });
    for (;;) {
      if (!a) return;
      if (a.option === 'fillet') {
        const r = await ed.getDistance('Fillet radius for rectangles', { default: ed.rectFillet ?? 0 });
        if (typeof r === 'number') fillet = ed.rectFillet = Math.max(0, r);
        a = await ed.getPoint('First corner', { options: opts('Fillet') });
        continue;
      }
      if (a.option) return;
      break;
    }
    const rect = (b) => {
      const x0 = Math.min(a.x, b.x),
        x1 = Math.max(a.x, b.x),
        y0 = Math.min(a.y, b.y),
        y1 = Math.max(a.y, b.y);
      const w = x1 - x0,
        h = y1 - y0;
      const r = Math.min(fillet, w / 2, h / 2);
      if (r > 1e-12) {
        const k = Math.tan(Math.PI / 8);
        return ed.make('polyline', {
          pts: [x0 + r, y0, 0, x1 - r, y0, k, x1, y0 + r, 0, x1, y1 - r, k, x1 - r, y1, 0, x0 + r, y1, k, x0, y1 - r, 0, x0, y0 + r, k],
          closed: true,
          width: 0,
        });
      }
      return ed.make('polyline', { pts: [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], closed: true, width: 0 });
    };
    for (;;) {
      const b = await ed.getPoint('Other corner', { base: a, rubber: false, options: opts('Dimensions'), preview: (p) => [rect(p)] });
      if (!b) return;
      if (b.option === 'dimensions') {
        const w = await positiveDistance(ed, 'Length', ed.rectW ?? 10);
        if (w === null) return;
        const h = await positiveDistance(ed, 'Width', ed.rectH ?? 10);
        if (h === null) return;
        ed.rectW = w;
        ed.rectH = h;
        const c = await ed.getPoint('Pick the side for the other corner', {
          base: a,
          rubber: false,
          preview: (p) => [rect({ x: a.x + Math.sign(p.x - a.x || 1) * w, y: a.y + Math.sign(p.y - a.y || 1) * h })],
        });
        if (!c || c.option) return;
        const q = { x: a.x + Math.sign(c.x - a.x || 1) * w, y: a.y + Math.sign(c.y - a.y || 1) * h };
        ed.commit('Rectangle', () => ed.drawing.add(rect(q)));
        return;
      }
      if (Math.abs(b.x - a.x) < 1e-12 || Math.abs(b.y - a.y) < 1e-12) {
        ed.ui.log('The rectangle needs a width and a height.', 'error');
        continue;
      }
      ed.commit('Rectangle', () => ed.drawing.add(rect(b)));
      return;
    }
  },
};

/** Ask for a distance greater than zero; null when cancelled. */
async function positiveDistance(ed, prompt, def) {
  for (;;) {
    const d = await ed.getDistance(prompt, { default: def });
    if (typeof d !== 'number') return null;
    if (d > 0) return d;
    ed.ui.log(`The ${prompt.toLowerCase()} must be greater than zero.`, 'error');
  }
}

export const POLYGON = {
  name: 'POLYGON',
  aliases: ['POL'],
  label: 'Polygon',
  icon: 'polygon',
  async run(ed) {
    const n = await ed.getNumber('Number of sides', { default: ed.polySides ?? 6, min: 3, max: 1024 });
    if (!Number.isFinite(n)) return;
    const sides = Math.round(n);
    ed.polySides = sides;
    const c = await ed.getPoint('Center of polygon', { options: opts('Edge') });
    if (!c) return;
    if (c.option === 'edge') {
      const a = await ed.getPoint('First endpoint of edge');
      if (!a || a.option) return;
      const mk = (b) => {
        const len = dist(a, b);
        const ang = angleOf(a, b);
        const R = len / (2 * Math.sin(Math.PI / sides));
        const ctr = polar(polar(a, ang, len / 2), ang + Math.PI / 2, len / (2 * Math.tan(Math.PI / sides)));
        const a0 = angleOf(ctr, a);
        return ed.make('polyline', { pts: polygonPoints(ctr, sides, R, a0, false), closed: true, width: 0 });
      };
      const preview = (p) => (dist(a, p) > 1e-12 ? [mk(p)] : []);
      const why = 'The edge must have a length.';
      const b = await pointAwayFrom(ed, 'Second endpoint of edge', a, { preview }, why);
      if (!b) return;
      ed.commit('Polygon', () => ed.drawing.add(mk(b)));
      return;
    }
    const mode = await ed.getKeyword('Placement', [
      { key: 'I', label: 'Inscribed in circle', value: 'i' },
      { key: 'C', label: 'Circumscribed about circle', value: 'c' },
    ], ed.polyMode ?? 'i');
    if (!mode) return;
    ed.polyMode = mode;
    const mk = (p) => ed.make('polyline', { pts: polygonPoints(c, sides, dist(c, p), angleOf(c, p), mode === 'c'), closed: true, width: 0 });
    const preview = (p) => (dist(c, p) > 1e-12 ? [mk(p)] : []);
    const r = await pointAwayFrom(ed, 'Radius of circle', c, { preview });
    if (!r) return;
    ed.commit('Polygon', () => ed.drawing.add(mk(r)));
  },
};

export const CIRCLE = {
  name: 'CIRCLE',
  aliases: ['C'],
  label: 'Circle',
  icon: 'circle',
  async run(ed, args) {
    let mode = args?.mode;
    let c;
    if (!mode) {
      c = await ed.getPoint('Center point', { options: [...opts('3P', '2P'), { key: 'T', label: 'Ttr (tangent tangent radius)', value: 'ttr' }] });
      if (!c) return;
      mode = c.option || 'cr';
    }
    if (mode === '3p') {
      const a = await ed.getPoint('First point on circle');
      if (!a || a.option) return;
      const b = await ed.getPoint('Second point on circle', { base: a });
      if (!b || b.option) return;
      const mk = (p) => {
        const k = circle3(a, b, p);
        return k ? [ed.make('circle', k)] : [];
      };
      for (;;) {
        const p = await ed.getPoint('Third point on circle', { base: b, preview: mk });
        if (!p || p.option) return;
        const k = circle3(a, b, p);
        if (k) {
          ed.commit('Circle', () => ed.drawing.add(ed.make('circle', k)));
          return;
        }
        ed.ui.log(COLLINEAR, 'error');
      }
    }
    if (mode === '2p') {
      const a = await ed.getPoint('First end point of diameter');
      if (!a || a.option) return;
      const mk = (p) => ed.make('circle', { cx: (a.x + p.x) / 2, cy: (a.y + p.y) / 2, r: dist(a, p) / 2 });
      const preview = (p) => (dist(a, p) > 1e-12 ? [mk(p)] : []);
      const why = 'The diameter must be greater than zero.';
      const b = await pointAwayFrom(ed, 'Second end point of diameter', a, { preview }, why);
      if (!b) return;
      ed.commit('Circle', () => ed.drawing.add(mk(b)));
      return;
    }
    if (mode === 'ttr') {
      const filter = (e) => ['line', 'circle', 'arc'].includes(e.type);
      const e1 = await ed.getEntity('First tangent object (line, circle or arc)', { filter });
      if (!e1 || e1.option) return;
      const e2 = await ed.getEntity('Second tangent object', { filter });
      if (!e2 || e2.option) return;
      const r = await ed.getDistance('Radius of circle', { default: ed.lastRadius ?? 10 });
      if (typeof r !== 'number' || r <= 0) return;
      const k = circleTTR(e1.ent, e1, e2.ent, e2, r);
      if (!k) {
        ed.ui.log('No circle with that radius touches both objects.', 'error');
        return;
      }
      ed.lastRadius = r;
      ed.commit('Circle', () => ed.drawing.add(ed.make('circle', k)));
      return;
    }
    if (!c || c.option) {
      c = await ed.getPoint('Center point');
      if (!c || c.option) return;
    }
    let diameter = mode === 'cd';
    for (;;) {
      const mk = (p) => ed.make('circle', { cx: c.x, cy: c.y, r: diameter ? dist(c, p) / 2 : dist(c, p) });
      const r = await ed.getDistance(diameter ? 'Diameter of circle' : 'Radius of circle', {
        base: c,
        default: ed.lastRadius !== undefined ? (diameter ? ed.lastRadius * 2 : ed.lastRadius) : undefined,
        options: diameter ? opts('Radius') : opts('Diameter'),
        preview: (p) => (dist(c, p) > 1e-12 ? [mk(p)] : []),
      });
      if (r === null) return;
      if (r.option === 'diameter') {
        diameter = true;
        continue;
      }
      if (r.option === 'radius') {
        diameter = false;
        continue;
      }
      const rad = diameter ? r / 2 : r;
      if (!(rad > 0)) {
        ed.ui.log('The radius must be greater than zero.', 'error');
        continue;
      }
      ed.lastRadius = rad;
      ed.commit('Circle', () => ed.drawing.add(ed.make('circle', { cx: c.x, cy: c.y, r: rad })));
      return;
    }
  },
};

export const ARC = {
  name: 'ARC',
  aliases: ['A'],
  label: 'Arc',
  icon: 'arc',
  async run(ed, args) {
    const mode = args?.mode;
    if (mode === 'cse') return arcCenterFirst(ed);
    const s = await ed.getPoint('Start point', { options: opts('Center') });
    if (!s) return;
    if (s.option === 'center') return arcCenterFirst(ed);
    if (mode === 'sce') return arcStartCenter(ed, s);
    if (mode === 'ser') return arcStartEndRadius(ed, s);
    const m = await ed.getPoint('Second point', { base: s, options: opts('Center', 'End') });
    if (!m) return;
    if (m.option === 'center') return arcStartCenter(ed, s);
    if (m.option === 'end') return arcStartEndRadius(ed, s);
    const mk = (p) => {
      const a = arc3(s, m, p);
      return a ? [ed.make('arc', a)] : [];
    };
    for (;;) {
      const e = await ed.getPoint('End point', { base: m, preview: mk });
      if (!e || e.option) return;
      const a = arc3(s, m, e);
      if (a) {
        ed.commit('Arc', () => ed.drawing.add(ed.make('arc', a)));
        return;
      }
      ed.ui.log(COLLINEAR, 'error');
    }
  },
};

async function arcCenterFirst(ed) {
  const c = await ed.getPoint('Center point');
  if (!c || c.option) return;
  const s = await pointAwayFrom(ed, 'Start point', c);
  if (s) return finishCenterArc(ed, c, s);
}

async function arcStartCenter(ed, s) {
  const c = await pointAwayFrom(ed, 'Center point', s);
  if (c) return finishCenterArc(ed, c, s);
}

const ZERO_RADIUS = 'The radius must be greater than zero.';

/** Ask for a point that is not on `base` (a zero size); null when cancelled. */
async function pointAwayFrom(ed, prompt, base, opts = {}, why = ZERO_RADIUS) {
  for (;;) {
    const p = await ed.getPoint(prompt, { ...opts, base });
    if (!p || p.option) return null;
    if (dist(base, p) > 1e-12) return p;
    ed.ui.log(why, 'error');
  }
}

async function finishCenterArc(ed, c, s) {
  const r = dist(c, s);
  const a0 = angleOf(c, s);
  const mk = (p) => ed.make('arc', { cx: c.x, cy: c.y, r, start: norm(a0), end: norm(angleOf(c, p)) });
  const e = await ed.getPoint('End point (hold the direction counter-clockwise)', { base: c, preview: (p) => [mk(p)] });
  if (!e || e.option) return;
  ed.commit('Arc', () => ed.drawing.add(mk(e)));
}

async function arcStartEndRadius(ed, s) {
  let e;
  for (;;) {
    e = await ed.getPoint('End point', { base: s });
    if (!e || e.option) return;
    if (dist(s, e) > 1e-12) break;
    ed.ui.log('The end point must differ from the start point.', 'error');
  }
  const mk = (p) => {
    const r = Math.max(dist(s, e) / 2, dist(s, p));
    // Centre on the left of start->end for a counter-clockwise minor arc.
    const mx = (s.x + e.x) / 2,
      my = (s.y + e.y) / 2;
    const half = dist(s, e) / 2;
    const h = Math.sqrt(Math.max(0, r * r - half * half));
    const ux = (e.x - s.x) / (2 * half),
      uy = (e.y - s.y) / (2 * half);
    const cx = mx - uy * h,
      cy = my + ux * h;
    return ed.make('arc', { cx, cy, r, start: norm(Math.atan2(s.y - cy, s.x - cx)), end: norm(Math.atan2(e.y - cy, e.x - cx)) });
  };
  for (;;) {
    const r = await ed.getDistance('Radius', { base: s, preview: (p) => [mk(p)] });
    if (typeof r !== 'number') return;
    // A radius under half the chord cannot reach both ends.
    if (r >= dist(s, e) / 2 - 1e-9) {
      ed.commit('Arc', () => ed.drawing.add(mk(polar(s, 0, r))));
      return;
    }
    ed.ui.log(`The radius must be at least ${formatLinear(dist(s, e) / 2, ed.header)}.`, 'error');
  }
}

const AXIS = 'The axis must have a length.';

export const ELLIPSE = {
  name: 'ELLIPSE',
  aliases: ['EL'],
  label: 'Ellipse',
  icon: 'ellipse',
  async run(ed, args) {
    let arc = args?.mode === 'arc';
    let center = args?.mode === 'center';
    let c, mx, my, axis0;
    if (!center) {
      const a = await ed.getPoint(arc ? 'Axis end point of elliptical arc' : 'Axis end point', { options: arc ? opts('Center') : opts('Arc', 'Center') });
      if (!a) return;
      if (a.option === 'arc') {
        arc = true;
        return ELLIPSE.run(ed, { mode: 'arc' });
      }
      if (a.option === 'center') center = true;
      else {
        const b = await pointAwayFrom(ed, 'Other end point of axis', a, {}, AXIS);
        if (!b) return;
        c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        mx = b.x - c.x;
        my = b.y - c.y;
        axis0 = angleOf(c, a);
      }
    }
    if (center) {
      c = await ed.getPoint('Center of ellipse');
      if (!c || c.option) return;
      const e = await pointAwayFrom(ed, 'Axis end point', c, {}, AXIS);
      if (!e) return;
      mx = e.x - c.x;
      my = e.y - c.y;
      axis0 = angleOf(c, e);
    }
    const major = Math.hypot(mx, my);
    if (major < 1e-12) return;
    const mkFull = (d) => {
      let ratio = d / major;
      let ax = mx,
        ay = my;
      if (ratio > 1) {
        // The second distance is the longer axis: swap.
        ax = (-my / major) * d;
        ay = (mx / major) * d;
        ratio = 1 / ratio;
      }
      return ed.make('ellipse', { cx: c.x, cy: c.y, mx: ax, my: ay, ratio: Math.max(1e-6, ratio), start: 0, end: TAU });
    };
    const perp = (p) => Math.abs((-(my / major)) * (p.x - c.x) + (mx / major) * (p.y - c.y));
    // A typed value is the distance itself; a picked point counts by its distance from the major axis.
    let d;
    for (;;) {
      const preview = (p) => (perp(p) > 1e-12 ? [mkFull(perp(p))] : []);
      const pickD = await ed._ask('distance', 'Distance to other axis', { base: c, preview });
      if (pickD === null || pickD.option) return;
      d = typeof pickD === 'number' ? pickD : perp(pickD);
      if (d > 1e-12) break;
      ed.ui.log(AXIS, 'error');
    }
    const full = mkFull(d);
    if (!arc) {
      ed.commit('Ellipse', () => ed.drawing.add(full));
      return;
    }
    const L = Math.hypot(full.mx, full.my);
    const ux = full.mx / L,
      uy = full.my / L;
    const paramOf = (p) => {
      const x = (p.x - c.x) * ux + (p.y - c.y) * uy;
      const y = -(p.x - c.x) * uy + (p.y - c.y) * ux;
      return norm(Math.atan2(y / full.ratio, x));
    };
    // Typed angles count from the first axis end point; picked points by their direction.
    const param = (r) => paramOf(typeof r === 'number' ? polar(c, axis0 + r, 1) : r);
    const s = await ed._ask('angle', 'Start angle', { base: c });
    if (s === null || s.option) return;
    const t0 = param(s);
    const preview = (p) => [{ ...full, start: t0, end: paramOf(p) }];
    const e = await ed._ask('angle', 'End angle', { base: c, preview });
    if (e === null || e.option) return;
    ed.commit('Elliptical arc', () => ed.drawing.add({ ...full, start: t0, end: param(e) }));
  },
};

export const SPLINE = {
  name: 'SPLINE',
  aliases: ['SPL'],
  label: 'Spline',
  icon: 'spline',
  async run(ed) {
    const fit = [];
    const first = await ed.getPoint('First point');
    if (!first || first.option) return;
    fit.push(first.x, first.y);
    const mk = (extra, closed = false) => {
      const f = extra ? fit.concat([extra.x, extra.y]) : fit.slice();
      if (f.length < 4) return null;
      try {
        // No curve (null) when every fit point is the same.
        const s = splineFromFitPoints(f, closed);
        return s ? ed.make('spline', { ...s, fit: f, closed }) : null;
      } catch {
        return null;
      }
    };
    for (;;) {
      const last = { x: fit.at(-2), y: fit.at(-1) };
      const options = fit.length >= 6 ? opts('Close', 'Undo') : opts('Undo');
      const r = await ed.getPoint('Next point (Enter to finish)', { base: last, options, preview: (p) => [mk(p)].filter(Boolean) });
      if (r === null) break;
      if (r.option === 'undo') {
        if (fit.length > 2) fit.splice(-2, 2);
        continue;
      }
      if (r.option === 'close') {
        const e = mk(null, true);
        if (e) ed.commit('Spline', () => ed.drawing.add(e));
        return;
      }
      fit.push(r.x, r.y);
    }
    const e = mk(null);
    if (e) ed.commit('Spline', () => ed.drawing.add(e));
  },
};

export const POINT = {
  name: 'POINT',
  aliases: ['PO'],
  label: 'Point',
  icon: 'point',
  async run(ed) {
    for (;;) {
      const p = await ed.getPoint('Specify a point (Esc to finish)');
      if (!p || p.option) return;
      ed.commit('Point', () => ed.drawing.add(ed.make('point', { x: p.x, y: p.y })));
    }
  },
};

export const DONUT = {
  name: 'DONUT',
  aliases: ['DO'],
  label: 'Donut',
  icon: 'donut',
  async run(ed) {
    let inner, outer;
    for (;;) {
      inner = await ed.getDistance('Inside diameter', { default: ed.donutIn ?? 5 });
      if (typeof inner !== 'number') return;
      if (inner >= 0) break;
      ed.ui.log('The inside diameter cannot be negative.', 'error');
    }
    for (;;) {
      const def = Math.max(ed.donutOut ?? 10, inner * 2);
      outer = await ed.getDistance('Outside diameter', { default: def });
      if (typeof outer !== 'number') return;
      if (outer > inner) break;
      ed.ui.log('The outside diameter must be larger than the inside diameter.', 'error');
    }
    ed.donutIn = inner;
    ed.donutOut = outer;
    const r = (inner + outer) / 4;
    const w = (outer - inner) / 2;
    const mk = (c) => ed.make('polyline', { pts: [c.x - r, c.y, 1, c.x + r, c.y, 1], closed: true, width: w });
    for (;;) {
      const c = await ed.getPoint('Center of donut (Enter to finish)', { preview: (p) => [mk(p)] });
      if (!c || c.option) return;
      ed.commit('Donut', () => ed.drawing.add(mk(c)));
    }
  },
};

const MAX_CLOUD_ARCS = 2000;

export const REVCLOUD = {
  name: 'REVCLOUD',
  label: 'Revision cloud',
  icon: 'revcloud',
  async run(ed) {
    const arcLen = await positiveDistance(ed, 'Arc length', ed.cloudArc ?? 5);
    if (arcLen === null) return;
    ed.cloudArc = arcLen;
    const a = await ed.getPoint('First corner');
    if (!a || a.option) return;
    // Longer arcs when the cloud would need too many (a slip such as 0.01
    // for 10 freezes the preview and bloats the drawing).
    const stepFor = (b) => {
      const perimeter = 2 * (Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
      return Math.max(arcLen, perimeter / MAX_CLOUD_ARCS);
    };
    const mk = (b) => {
      const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      // Clockwise in screen space keeps the scallops outward.
      const area = (b.x - a.x) * (b.y - a.y);
      const order = area > 0 ? corners : corners.slice().reverse();
      const step = stepFor(b);
      const pts = [];
      for (let i = 0; i < 4; i++) {
        const p = order[i],
          q = order[(i + 1) % 4];
        const len = dist(p, q);
        const n = Math.max(1, Math.round(len / step));
        // Counter-clockwise travel with positive bulges puts the scallops outside.
        for (let k = 0; k < n; k++) pts.push(p.x + ((q.x - p.x) * k) / n, p.y + ((q.y - p.y) * k) / n, 0.7);
      }
      return ed.make('polyline', { pts, closed: true, width: 0 });
    };
    const flat = (p) => Math.abs(p.x - a.x) <= 1e-9 || Math.abs(p.y - a.y) <= 1e-9;
    let b;
    for (;;) {
      const preview = (p) => (flat(p) ? [] : [mk(p)]);
      b = await ed.getPoint('Opposite corner', { base: a, rubber: false, preview });
      if (!b || b.option) return;
      if (!flat(b)) break;
      ed.ui.log('The cloud needs a width and a height.', 'error');
    }
    const step = stepFor(b);
    if (step > arcLen) {
      ed.ui.log(`Arc length increased to ${formatLinear(step, ed.header)} for this size.`, 'muted');
    }
    ed.commit('Revision cloud', () => ed.drawing.add(mk(b)));
  },
};
