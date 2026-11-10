/**
 * Annotation commands: text, multiline text, dimensions, leaders, hatching.
 */
import { opts } from '../input.js';
import { closestPoint, intersectPrims, toPrims } from '../../core/geom/index.js';
import RBush from 'rbush';
import { findBoundary, toHatchLoops } from '../../core/hatch/boundary.js';
import { loopsToRings, pointInRing } from '../../core/hatch/fill.js';
import { getPattern, patternNames } from '../../core/hatch/patterns.js';
import { tessellate, transformEntity } from '../../core/geom/index.js';
import { insertMatrix } from '../../core/tessellate.js';
import { drawBands } from '../../core/display.js';
import { angleOf, loopFromEntity } from './util.js';
import { tableKey } from '../../core/schema.js';

const JUSTIFY = [
  { key: 'L', label: 'Left', value: 'left|baseline' },
  { key: 'C', label: 'Center', value: 'center|baseline' },
  { key: 'R', label: 'Right', value: 'right|baseline' },
  { key: 'M', label: 'Middle', value: 'center|middle' },
  { key: 'TL', label: 'Top left', value: 'left|top' },
  { key: 'TC', label: 'Top center', value: 'center|top' },
  { key: 'TR', label: 'Top right', value: 'right|top' },
  { key: 'ML', label: 'Middle left', value: 'left|middle' },
  { key: 'MC', label: 'Middle center', value: 'center|middle' },
  { key: 'MR', label: 'Middle right', value: 'right|middle' },
  { key: 'BL', label: 'Bottom left', value: 'left|bottom' },
  { key: 'BC', label: 'Bottom center', value: 'center|bottom' },
  { key: 'BR', label: 'Bottom right', value: 'right|bottom' },
];

export const TEXT = {
  name: 'TEXT',
  aliases: ['DT', 'DTEXT'],
  label: 'Single line text',
  icon: 'text',
  async run(ed) {
    let just = ed.textJustify ?? 'left|baseline';
    let p;
    for (;;) {
      p = await ed.getPoint(`Start point of text (justify: ${JUSTIFY.find((j) => j.value === just)?.label ?? 'Left'})`, { options: opts('Justify', 'Style') });
      if (!p) return;
      if (p.option === 'justify') {
        const j = await ed.getKeyword('Justification', JUSTIFY, just);
        if (j) just = ed.textJustify = j;
        continue;
      }
      if (p.option === 'style') {
        const names = [...ed.drawing.textStyles.keys()];
        const s = await ed.getString(`Text style name (${names.join(', ')})`, { default: ed.header.textStyle });
        // Style names ignore letter case, as in DXF and DWG.
        const key = s ? tableKey(ed.drawing.textStyles, s) : null;
        if (key) ed.commit('Text style', () => ed.drawing.setHeader({ textStyle: key }));
        else if (s) ed.ui.log(`There is no text style named "${s}".`, 'error');
        continue;
      }
      break;
    }
    const style = ed.drawing.textStyles.get(ed.header.textStyle);
    let h = style?.height > 0 ? style.height : null;
    if (!h) {
      h = await ed.getDistance('Height', { base: p, default: ed.header.textHeight });
      if (typeof h !== 'number' || h <= 0) return;
      if (h !== ed.header.textHeight) ed.commit('Text height', () => ed.drawing.setHeader({ textHeight: h }));
    }
    const rot = await ed.getAngle('Rotation angle of text', { base: p, default: ed.textRot ?? 0 });
    if (typeof rot !== 'number') return;
    ed.textRot = rot;
    const [halign, valign] = just.split('|');
    let pos = p;
    for (;;) {
      // New text takes the style's width factor and obliquing, like AutoCAD.
      const wf = style?.widthFactor > 0 ? style.widthFactor : 1;
      const base = ed.make('text', {
        x: pos.x,
        y: pos.y,
        h,
        rot,
        value: '',
        style: ed.header.textStyle,
        halign,
        valign,
        widthFactor: wf,
        oblique: style?.oblique || 0,
      });
      const value = await ed.editText({ anchor: pos, height: h, rot, multiline: false, onChange: (v) => ed.renderer.setPreview(v ? [{ ...base, value: v }] : []) });
      ed.renderer.setPreview([]);
      if (!value) return;
      ed.commit('Text', () => ed.drawing.add({ ...base, value }));
      // Next line goes below, like a typewriter.
      pos = { x: pos.x + Math.sin(rot) * h * 1.6667, y: pos.y - Math.cos(rot) * h * 1.6667 };
    }
  },
};

export const MTEXT = {
  name: 'MTEXT',
  aliases: ['T', 'MT'],
  label: 'Multiline text',
  icon: 'mtext',
  async run(ed) {
    const a = await ed.getPoint('First corner of the text box');
    if (!a || a.option) return;
    const box = (b) => ed.make('polyline', { pts: [a.x, a.y, 0, b.x, a.y, 0, b.x, b.y, 0, a.x, b.y, 0], closed: true, width: 0, linetype: 'Continuous' });
    let h = ed.header.textHeight;
    let b;
    for (;;) {
      b = await ed.getPoint('Opposite corner', { base: a, rubber: false, options: opts('Height'), preview: (p) => [box(p)] });
      if (!b) return;
      if (b.option === 'height') {
        const v = await ed.getDistance('Height', { default: h });
        if (typeof v === 'number' && v > 0) {
          h = v;
          ed.commit('Text height', () => ed.drawing.setHeader({ textHeight: h }));
        }
        continue;
      }
      break;
    }
    const x = Math.min(a.x, b.x),
      y = Math.max(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const base = ed.make('mtext', { x, y, h, rot: 0, value: '', style: ed.header.textStyle, width, attach: 'tl', lineSpacing: 1 });
    const value = await ed.editText({ anchor: { x, y }, height: h, rot: 0, multiline: true, width, onChange: (v) => ed.renderer.setPreview(v ? [{ ...base, value: v }] : [box(b)]) });
    ed.renderer.setPreview([]);
    if (!value) return;
    ed.commit('Multiline text', () => ed.drawing.add({ ...base, value }));
  },
};

const dimBase = (ed, fields) => ed.make('dimension', { style: ed.header.dimStyle, text: '', rot: 0, x3: 0, y3: 0, x4: 0, y4: 0, ...fields });

/** Two extension origins, either picked or taken from a line/arc/circle. */
async function dimOrigins(ed) {
  const p1 = await ed.getPoint('First extension line origin (Enter to select an object)');
  if (p1 === null) {
    const pick = await ed.getEntity('Select object to dimension', { filter: (e) => ['line', 'arc', 'polyline', 'circle'].includes(e.type) });
    if (!pick || pick.option) return null;
    const e = pick.ent;
    if (e.type === 'line') return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    if (e.type === 'arc') return [{ x: e.cx + e.r * Math.cos(e.start), y: e.cy + e.r * Math.sin(e.start) }, { x: e.cx + e.r * Math.cos(e.end), y: e.cy + e.r * Math.sin(e.end) }];
    if (e.type === 'circle') return Object.assign([{ x: e.cx - e.r, y: e.cy }, { x: e.cx + e.r, y: e.cy }], { circle: e });
    if (e.type === 'polyline') {
      // The segment under the pick.
      const p = e.pts;
      const n = p.length / 3;
      const near = closestPoint(e, pick.x, pick.y);
      let best = near?.prim?.seg ?? 0;
      if (near?.prim?.seg === undefined) {
        let bd = Infinity;
        for (let i = 0; i < (e.closed ? n : n - 1); i++) {
          const j = (i + 1) % n;
          const ax = p[i * 3],
            ay = p[i * 3 + 1],
            dx = p[j * 3] - ax,
            dy = p[j * 3 + 1] - ay;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((pick.x - ax) * dx + (pick.y - ay) * dy) / l2));
          const d = Math.hypot(ax + dx * t - pick.x, ay + dy * t - pick.y);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
      const j = (best + 1) % n;
      return [{ x: p[best * 3], y: p[best * 3 + 1] }, { x: p[j * 3], y: p[j * 3 + 1] }];
    }
    return null;
  }
  if (p1.option) return null;
  const p2 = await ed.getPoint('Second extension line origin', { base: p1 });
  if (!p2 || p2.option) return null;
  return [p1, p2];
}

/** Ask for the dimension line location with the common text options. */
async function placeDim(ed, make) {
  let text = '';
  let fixedRot = null;
  for (;;) {
    const r = await ed.getPoint('Dimension line location', {
      options: opts('Text', 'Angle', 'Horizontal', 'Vertical'),
      preview: (p) => [make(p, text, fixedRot)],
    });
    if (!r) return null;
    if (r.option === 'text') {
      const t = await ed.getString('Dimension text (<> stands for the measured value)', { default: '<>', spaces: true });
      text = t === '<>' ? '' : t;
      continue;
    }
    if (r.option === 'angle') {
      ed.ui.log('Text angle follows the dimension style.', 'muted');
      continue;
    }
    if (r.option === 'horizontal') {
      fixedRot = 0;
      continue;
    }
    if (r.option === 'vertical') {
      fixedRot = Math.PI / 2;
      continue;
    }
    return make(r, text, fixedRot);
  }
}

export const DIMLINEAR = {
  name: 'DIMLINEAR',
  aliases: ['DLI', 'DIMLIN'],
  label: 'Linear dimension',
  icon: 'dim-linear',
  async run(ed) {
    const o = await dimOrigins(ed);
    if (!o) return;
    const [a, b] = o;
    const c = o.circle;
    const make = (p, text, fixedRot) => {
      let rot = fixedRot;
      if (c) {
        // A circle's diameter along the dimension: horizontal above or below it, vertical beside it.
        if (rot === null) rot = Math.abs(p.y - c.cy) >= Math.abs(p.x - c.cx) ? 0 : Math.PI / 2;
        const ux = Math.cos(rot) * c.r,
          uy = Math.sin(rot) * c.r;
        return dimBase(ed, { dimType: 'linear', x1: c.cx - ux, y1: c.cy - uy, x2: c.cx + ux, y2: c.cy + uy, lx: p.x, ly: p.y, rot, text });
      }
      if (rot === null) {
        const inX = p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x);
        const inY = p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
        rot = inX && !inY ? 0 : inY && !inX ? Math.PI / 2 : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 0 : Math.PI / 2;
      }
      return dimBase(ed, { dimType: 'linear', x1: a.x, y1: a.y, x2: b.x, y2: b.y, lx: p.x, ly: p.y, rot, text });
    };
    const d = await placeDim(ed, make);
    if (d) {
      ed.commit('Linear dimension', () => (ed.lastDim = ed.drawing.add(d)));
    }
  },
};

export const DIMALIGNED = {
  name: 'DIMALIGNED',
  aliases: ['DAL', 'DIMALI'],
  label: 'Aligned dimension',
  icon: 'dim-aligned',
  async run(ed) {
    const o = await dimOrigins(ed);
    if (!o) return;
    const [a, b] = o;
    const make = (p, text) => dimBase(ed, { dimType: 'aligned', x1: a.x, y1: a.y, x2: b.x, y2: b.y, lx: p.x, ly: p.y, rot: angleOf(a, b), text });
    const d = await placeDim(ed, make);
    if (d) {
      ed.commit('Aligned dimension', () => (ed.lastDim = ed.drawing.add(d)));
    }
  },
};

export const DIMANGULAR = {
  name: 'DIMANGULAR',
  aliases: ['DAN', 'DIMANG'],
  label: 'Angular dimension',
  icon: 'dim-angular',
  async run(ed) {
    const pick = await ed.getEntity('Select arc, circle or line (Enter to specify the vertex)', { filter: (e) => ['line', 'arc', 'circle'].includes(e.type) });
    let v, p1, p2, locate;
    if (pick === null) {
      v = await ed.getPoint('Angle vertex');
      if (!v || v.option) return;
      p1 = await ed.getPoint('First angle end point', { base: v });
      if (!p1 || p1.option) return;
      p2 = await ed.getPoint('Second angle end point', { base: v });
      if (!p2 || p2.option) return;
    } else {
      if (pick.option) return;
      const e = pick.ent;
      if (e.type === 'arc') {
        v = { x: e.cx, y: e.cy };
        p1 = { x: e.cx + e.r * Math.cos(e.start), y: e.cy + e.r * Math.sin(e.start) };
        p2 = { x: e.cx + e.r * Math.cos(e.end), y: e.cy + e.r * Math.sin(e.end) };
      } else if (e.type === 'circle') {
        v = { x: e.cx, y: e.cy };
        const c = closestPoint(e, pick.x, pick.y);
        p1 = { x: c.x, y: c.y };
        const q = await ed.getPoint('Second angle end point', { base: v });
        if (!q || q.option) return;
        p2 = q;
      } else {
        let second;
        for (;;) {
          second = await ed.getEntity('Select second line', { filter: (x) => x.type === 'line' });
          if (!second || second.option) return;
          if (second.id !== pick.id) break;
          ed.ui.log('That line is already picked. Select a different line.', 'error');
        }
        const f = second.ent;
        const ip = intersectPrims(toPrims(e)[0], toPrims(f)[0], { extA: true, extB: true });
        if (!ip || !ip.length) {
          ed.ui.log('The lines are parallel.', 'error');
          return;
        }
        v = ip[0];
        // Each line gives a ray on both sides of the vertex: its endpoint
        // there, or else its far endpoint mirrored through the vertex.
        const rays = (ln) => {
          const a = { x: ln.x1, y: ln.y1 },
            b = { x: ln.x2, y: ln.y2 };
          const da = Math.hypot(a.x - v.x, a.y - v.y),
            db = Math.hypot(b.x - v.x, b.y - v.y);
          const [far, near, dn] = da >= db ? [a, b, db] : [b, a, da];
          const opposite = (near.x - v.x) * (far.x - v.x) + (near.y - v.y) * (far.y - v.y) < 0;
          const mirrored = { x: 2 * v.x - far.x, y: 2 * v.y - far.y };
          const back = opposite && dn > 1e-9 * da ? near : mirrored;
          return [far, back];
        };
        const r1 = rays(e),
          r2 = rays(f);
        // Like AutoCAD, the location picks which of the four angles (all
        // under 180 degrees) between the lines is dimensioned.
        locate = (p) => {
          const ux = r1[0].x - v.x,
            uy = r1[0].y - v.y,
            wx = r2[0].x - v.x,
            wy = r2[0].y - v.y;
          const px = p.x - v.x,
            py = p.y - v.y;
          const det = ux * wy - uy * wx;
          p1 = (px * wy - py * wx) / det >= 0 ? r1[0] : r1[1];
          p2 = (ux * py - uy * px) / det >= 0 ? r2[0] : r2[1];
        };
      }
    }
    const make = (p, text) => {
      locate?.(p);
      const pts = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: v.x, y3: v.y, lx: p.x, ly: p.y };
      return dimBase(ed, { dimType: 'angular', ...pts, text });
    };
    const d = await placeDim(ed, make);
    if (d) ed.commit('Angular dimension', () => (ed.lastDim = ed.drawing.add(d)));
  },
};

async function radial(ed, type) {
  const pick = await ed.getEntity('Select arc or circle', { filter: (e) => e.type === 'arc' || e.type === 'circle' || (e.type === 'polyline' && e.pts.some((v, i) => i % 3 === 2 && v)) });
  if (!pick || pick.option) return;
  const e = pick.ent;
  let cx = e.cx,
    cy = e.cy,
    r = e.r;
  if (e.type === 'polyline') {
    // The arc segment under the pick.
    const arc = closestPoint(e, pick.x, pick.y)?.prim;
    if (arc?.t !== 'arc') {
      ed.ui.log('Select an arc segment of the polyline.', 'error');
      return;
    }
    ({ cx, cy, r } = arc);
  }
  const make = (p, text) => {
    const a = Math.atan2(p.y - cy, p.x - cx);
    return dimBase(ed, { dimType: type, x1: cx, y1: cy, x2: cx + r * Math.cos(a), y2: cy + r * Math.sin(a), lx: p.x, ly: p.y, text });
  };
  const d = await placeDim(ed, make);
  if (d) ed.commit(type === 'radius' ? 'Radius dimension' : 'Diameter dimension', () => ed.drawing.add(d));
}

export const DIMRADIUS = { name: 'DIMRADIUS', aliases: ['DRA', 'DIMRAD'], label: 'Radius dimension', icon: 'dim-radius', run: (ed) => radial(ed, 'radius') };
export const DIMDIAMETER = { name: 'DIMDIAMETER', aliases: ['DDI', 'DIMDIA'], label: 'Diameter dimension', icon: 'dim-diameter', run: (ed) => radial(ed, 'diameter') };

export const DIMORDINATE = {
  name: 'DIMORDINATE',
  aliases: ['DOR', 'DIMORD'],
  label: 'Ordinate dimension',
  icon: 'dim-ordinate',
  async run(ed) {
    const f = await ed.getPoint('Feature location');
    if (!f || f.option) return;
    const make = (p, text, fixed) => {
      const axis = fixed === 0 ? 'y' : fixed === Math.PI / 2 ? 'x' : Math.abs(p.x - f.x) > Math.abs(p.y - f.y) ? 'y' : 'x';
      return dimBase(ed, { dimType: 'ordinate', x1: f.x, y1: f.y, x2: p.x, y2: p.y, lx: p.x, ly: p.y, ordAxis: axis, text });
    };
    const d = await placeDim(ed, make);
    if (d) ed.commit('Ordinate dimension', () => ed.drawing.add(d));
  },
};

async function chainDims(ed, baseline) {
  let last = ed.lastDim && ed.drawing.get(ed.lastDim.id);
  if (!last || (last.dimType !== 'linear' && last.dimType !== 'aligned')) {
    const pick = await ed.getEntity('Select a linear or aligned dimension', { filter: (e) => e.type === 'dimension' && (e.dimType === 'linear' || e.dimType === 'aligned') });
    if (!pick || pick.option) return;
    last = pick.ent;
  }
  const ds = ed.drawing.dimStyles.get(last.style) ?? ed.drawing.dimStyles.get('Standard');
  const step = (ds?.textHeight ?? 2.5) * (ds?.scale ?? 1) * 3;
  const first = { x: last.x1, y: last.y1 };
  let prev = { x: last.x2, y: last.y2 };
  let line = { x: last.lx, y: last.ly };
  for (;;) {
    const ux = last.dimType === 'linear' ? -Math.sin(last.rot) : -(last.y2 - last.y1);
    const uy = last.dimType === 'linear' ? Math.cos(last.rot) : last.x2 - last.x1;
    const ul = Math.hypot(ux, uy) || 1;
    const make = (p) => {
      const o = baseline ? first : prev;
      let lx = line.x,
        ly = line.y;
      if (baseline) {
        // Each baseline dimension steps away from the previous one.
        const side = (line.x - o.x) * ux + (line.y - o.y) * uy >= 0 ? 1 : -1;
        lx += (ux / ul) * step * side;
        ly += (uy / ul) * step * side;
      }
      return dimBase(ed, { dimType: last.dimType, x1: o.x, y1: o.y, x2: p.x, y2: p.y, lx, ly, rot: last.dimType === 'linear' ? last.rot : angleOf(o, p), style: last.style });
    };
    const p = await ed.getPoint('Second extension line origin (Enter to finish)', { preview: (c) => [make(c)] });
    if (!p || p.option) return;
    const d = make(p);
    ed.commit(baseline ? 'Baseline dimension' : 'Continued dimension', () => (ed.lastDim = ed.drawing.add(d)));
    prev = p;
    line = { x: d.lx, y: d.ly };
    last = d;
  }
}

export const DIMCONTINUE = { name: 'DIMCONTINUE', aliases: ['DCO', 'DIMCONT'], label: 'Continue dimension', icon: 'dim-continue', run: (ed) => chainDims(ed, false) };
export const DIMBASELINE = { name: 'DIMBASELINE', aliases: ['DBA', 'DIMBASE'], label: 'Baseline dimension', icon: 'dim-baseline', run: (ed) => chainDims(ed, true) };

export const DIM = {
  name: 'DIM',
  label: 'Dimension',
  icon: 'dim-quick',
  async run(ed) {
    const kind = await ed.getKeyword(
      'Dimension type',
      [
        { key: 'L', label: 'Linear', value: 'DIMLINEAR' },
        { key: 'AL', label: 'Aligned', value: 'DIMALIGNED' },
        { key: 'AN', label: 'Angular', value: 'DIMANGULAR' },
        { key: 'R', label: 'Radius', value: 'DIMRADIUS' },
        { key: 'D', label: 'Diameter', value: 'DIMDIAMETER' },
        { key: 'O', label: 'Ordinate', value: 'DIMORDINATE' },
      ],
      'DIMLINEAR',
    );
    if (kind) await ed.find(kind).run(ed);
  },
};

export const LEADER = {
  name: 'LEADER',
  aliases: ['LE', 'MLEADER', 'MLD'],
  label: 'Leader',
  icon: 'leader',
  async run(ed) {
    const a = await ed.getPoint('Arrowhead location');
    if (!a || a.option) return;
    const pts = [a.x, a.y];
    const mk = (extra) => ed.make('leader', { pts: extra ? pts.concat([extra.x, extra.y]) : pts.slice(), text: '', h: ed.header.textHeight, style: ed.header.dimStyle });
    for (;;) {
      const last = { x: pts.at(-2), y: pts.at(-1) };
      const p = await ed.getPoint(pts.length < 4 ? 'Leader landing location' : 'Next point (Enter to add text)', { base: last, preview: (c) => [mk(c)] });
      if (!p) break;
      if (p.option) return;
      pts.push(p.x, p.y);
      if (pts.length >= 6) break;
    }
    if (pts.length < 4) return;
    const base = mk(null);
    const end = { x: pts.at(-2), y: pts.at(-1) };
    const text = await ed.editText({ anchor: end, height: base.h, rot: 0, multiline: false, onChange: (v) => ed.renderer.setPreview([{ ...base, text: v }]) });
    ed.renderer.setPreview([]);
    ed.commit('Leader', () => ed.drawing.add({ ...base, text: text || '' }));
  },
};

// Hatching ------------------------------------------------------------------

/**
 * Curves (polylines in world space) of visible geometry in rect, for boundary
 * detection. Block references contribute their objects; construction lines
 * and rays are cut to a segment that spans the rectangle. Each curve carries
 * the id of the object it came from.
 */
function curvesNear(ed, rect) {
  const out = [];
  const d = ed.drawing;
  const tol = 0.5 / ed.camera.scale;
  const cx = (rect[0] + rect[2]) / 2,
    cy = (rect[1] + rect[3]) / 2;
  const reach = Math.hypot(rect[2] - rect[0], rect[3] - rect[1]);
  const blocks = new Set();
  let top = null;
  const add = (e, depth) => {
    switch (e.type) {
      case 'hatch':
      case 'text':
      case 'mtext':
      case 'dimension':
      case 'point':
        return;
      case 'line':
        out.push({ pts: [e.x1, e.y1, e.x2, e.y2], closed: false, id: top });
        return;
      case 'xline':
      case 'ray': {
        const l = Math.hypot(e.dx, e.dy);
        if (!(l > 0)) return;
        const ux = e.dx / l,
          uy = e.dy / l;
        const far = Math.hypot(e.x - cx, e.y - cy) + reach;
        const t0 = e.type === 'ray' ? 0 : -far;
        const pts = [e.x + ux * t0, e.y + uy * t0, e.x + ux * far, e.y + uy * far];
        out.push({ pts, closed: false, id: top });
        return;
      }
      case 'insert': {
        const b = d.blocks.get(e.name);
        if (!b || depth >= 8 || blocks.has(e.name)) return;
        const m = insertMatrix(e, b);
        blocks.add(e.name);
        for (const sub of b.entities) {
          if (sub.layer !== '0' && !d.layerVisible(sub.layer)) continue;
          add(transformEntity(sub, m), depth + 1);
        }
        blocks.delete(e.name);
        return;
      }
      default:
        try {
          const curved = e.type !== 'leader' && (e.type !== 'polyline' || e.pts.some((v, i) => i % 3 === 2 && v));
          for (const p of tessellate(e, tol)) out.push(curved ? { ...p, id: top, src: e } : { ...p, id: top });
        } catch {
          /* skip */
        }
    }
  };
  for (const id of ed.doc.index.search(rect[0], rect[1], rect[2], rect[3])) {
    const e = d.get(id);
    top = id;
    if (e && d.layerVisible(e.layer)) add(e, 0);
  }
  weldEndsOnCurves(out);
  return out;
}

/**
 * Curves are flattened to chords, which run inside the true curve, so an
 * object that ends exactly on a curve from its outer side stops short of the
 * chord and would leave the boundary open. Each such end is added to the
 * curve's chords as a vertex. Ends that only come near a curve are left
 * alone: real gaps stay open.
 */
function weldEndsOnCurves(curves) {
  const items = [];
  for (const c of curves) {
    if (!c.src) continue;
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, c };
    const p = c.pts;
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < b.minX) b.minX = p[i];
      if (p[i] > b.maxX) b.maxX = p[i];
      if (p[i + 1] < b.minY) b.minY = p[i + 1];
      if (p[i + 1] > b.maxY) b.maxY = p[i + 1];
    }
    // The curve bulges out of its chords by at most the largest chord's sagitta.
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.25;
    b.minX -= pad;
    b.minY -= pad;
    b.maxX += pad;
    b.maxY += pad;
    items.push(b);
  }
  if (!items.length) return;
  const tree = new RBush();
  tree.load(items);
  const adds = new Map();
  const probe = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const end = (own, x, y) => {
    probe.minX = probe.maxX = x;
    probe.minY = probe.maxY = y;
    const eps = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
    for (const it of tree.search(probe)) {
      const c = it.c;
      if (c === own) continue;
      let q = null;
      try {
        q = closestPoint(c.src, x, y);
      } catch {
        /* skip */
      }
      if (!q || Math.hypot(q.x - x, q.y - y) > eps) continue;
      // Nearest chord, and where along it the end falls.
      const p = c.pts;
      const n = p.length >> 1;
      let best = Infinity,
        at = -1,
        bt = 0;
      for (let i = 0, m = c.closed ? n : n - 1; i < m; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2],
          ay = p[i * 2 + 1];
        const ex = p[j * 2] - ax,
          ey = p[j * 2 + 1] - ay;
        const l2 = ex * ex + ey * ey;
        let u = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d2 = (ax + u * ex - x) ** 2 + (ay + u * ey - y) ** 2;
        if (d2 < best) {
          best = d2;
          at = i;
          bt = u;
        }
      }
      if (at < 0 || !(best > eps * eps)) continue;
      let list = adds.get(c);
      if (!list) adds.set(c, (list = []));
      list.push({ at, t: bt, x, y });
    }
  };
  for (const c of curves) {
    const p = c.pts;
    if (c.closed || p.length < 4) continue;
    end(c, p[0], p[1]);
    end(c, p[p.length - 2], p[p.length - 1]);
  }
  for (const [c, list] of adds) {
    list.sort((a, b) => b.at - a.at || b.t - a.t);
    const pts = c.pts.slice();
    for (const a of list) pts.splice(a.at * 2 + 2, 0, a.x, a.y);
    c.pts = pts;
  }
}

/** Ids of the objects that the edges of picked loops (straight edges) lie on. */
function boundaryIds(ed, loops) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const l of loops) {
    for (let i = 0; i < l.length; i += 3) {
      x0 = Math.min(x0, l[i]);
      y0 = Math.min(y0, l[i + 1]);
      x1 = Math.max(x1, l[i]);
      y1 = Math.max(y1, l[i + 1]);
    }
  }
  const tol = 2 / ed.camera.scale;
  const curves = curvesNear(ed, [x0 - tol, y0 - tol, x1 + tol, y1 + tol]).map((c) => {
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (let i = 0; i < c.pts.length; i += 2) {
      bx0 = Math.min(bx0, c.pts[i]);
      by0 = Math.min(by0, c.pts[i + 1]);
      bx1 = Math.max(bx1, c.pts[i]);
      by1 = Math.max(by1, c.pts[i + 1]);
    }
    return { ...c, box: [bx0 - tol, by0 - tol, bx1 + tol, by1 + tol] };
  });
  const ids = new Set();
  const onCurve = (c, x, y) => {
    const p = c.pts,
      n = p.length >> 1;
    const m = c.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2],
        ay = p[i * 2 + 1],
        dx = p[j * 2] - ax,
        dy = p[j * 2 + 1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      if (Math.hypot(ax + dx * t - x, ay + dy * t - y) <= tol) return true;
    }
    return false;
  };
  for (const l of loops) {
    const n = l.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x = (l[i * 3] + l[j * 3]) / 2,
        y = (l[i * 3 + 1] + l[j * 3 + 1]) / 2;
      for (const c of curves) {
        if (c.id == null || ids.has(c.id)) continue;
        const b = c.box;
        if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && onCurve(c, x, y)) ids.add(c.id);
      }
    }
  }
  return ids;
}

/**
 * Put a new hatch behind its boundary objects, as AutoCAD does by default
 * (HPDRAWORDER). Fills already go beneath lines within a draw-order band, so
 * this only moves it when the boundary lies in an earlier band than the end
 * of the drawing, where the hatch would otherwise cover it.
 */
function placeBehindBoundary(ed, id, loops, selected) {
  const d = ed.drawing;
  const bands = drawBands(d.entities.values());
  if (!bands.band) return;
  const ids = boundaryIds(ed, loops);
  for (const k of selected) ids.add(k);
  const mine = bands.of.get(id) ?? 0;
  for (const k of d.entities.keys()) {
    if (!ids.has(k)) continue;
    if ((bands.of.get(k) ?? 0) < mine) d.moveBefore([id], k);
    return;
  }
}

/** True when (x, y) lies in the area of the picked loops (even-odd). */
function insideLoops(loops, x, y) {
  let n = 0;
  for (const r of loopsToRings(loops)) if (pointInRing(x, y, r) === 1) n++;
  return n % 2 === 1;
}

/** True when two straight-edged loops have the same vertices, in any order and direction. */
function sameLoop(a, b, tol) {
  if (a.length !== b.length) return false;
  const pts = (l) => {
    const out = [];
    for (let i = 0; i < l.length; i += 3) {
      if (l[i + 2]) return null;
      out.push([l[i], l[i + 1]]);
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  };
  const pa = pts(a),
    pb = pts(b);
  if (!pa || !pb) return false;
  return pa.every((p, i) => Math.abs(p[0] - pb[i][0]) <= tol && Math.abs(p[1] - pb[i][1]) <= tol);
}

export const HATCH = {
  name: 'HATCH',
  aliases: ['H', 'BH', 'BHATCH'],
  label: 'Hatch',
  icon: 'hatch',
  async run(ed) {
    const st = (ed.hatchSettings ??= { pattern: 'SOLID', scale: 1, angle: 0 });
    const preview = () => ed.renderer.setPreview(pendingPreview());
    const showPanel = () => ed.ui.showHatchPanel?.(st, preview);
    showPanel();
    let loops = [];
    // Loops before each pick, so Undo takes back a whole pick with its islands.
    const history = [];
    const pendingPreview = () => (loops.length ? [ed.make('hatch', { loops, pattern: st.pattern, scale: st.scale, angle: st.angle })] : []);
    let mode = 'pick';
    // Boundary objects chosen with Select objects.
    const selected = new Set();
    try {
      for (;;) {
        if (mode === 'pick') {
          const p = await ed.getPoint(loops.length ? 'Pick another internal point (Enter to finish)' : 'Pick an internal point', {
            options: [...opts('Select objects', 'Undo'), { key: 'T', label: 'Settings', value: 'settings' }],
            noSnap: true,
            rubber: false,
          });
          if (p === null) break;
          if (p.option === 'select objects') {
            mode = 'select';
            continue;
          }
          if (p.option === 'undo') {
            if (history.length) loops = history.pop();
            ed.renderer.setPreview(pendingPreview());
            continue;
          }
          if (p.option === 'settings') {
            await hatchSettingsPrompt(ed, st);
            showPanel();
            ed.renderer.setPreview(pendingPreview());
            continue;
          }
          if (insideLoops(loops, p.x, p.y)) {
            ed.ui.log('That area is already in the hatch.', 'muted');
            continue;
          }
          const v = ed.camera.bounds();
          const curves = curvesNear(ed, v);
          const res = findBoundary(p.x, p.y, curves, { gapTol: 0 });
          if (!res) {
            ed.ui.log('No closed boundary was found around that point. Zoom out so the whole boundary is visible, or select objects instead.', 'error');
            continue;
          }
          history.push(loops);
          loops = loops.slice();
          // A boundary shared whole with an earlier pick (an island picked
          // inside, or the area around one) merges the two areas.
          const tol = 1e-9 * Math.max(1, Math.abs(p.x), Math.abs(p.y), v[2] - v[0], v[3] - v[1]);
          for (const l of toHatchLoops(res)) {
            const k = loops.findIndex((m) => sameLoop(m, l, tol));
            if (k >= 0) loops.splice(k, 1);
            else loops.push(l);
          }
          ed.renderer.setPreview(pendingPreview());
        } else {
          const ids = await ed.getSelection('Select closed objects', { fresh: true });
          ed.clearSelection();
          for (const id of ids) {
            const l = loopFromEntity(ed.drawing.get(id));
            if (l) {
              loops.push(l);
              selected.add(id);
            }
          }
          if (!loops.length) {
            ed.ui.log('Select closed polylines, circles, ellipses or splines.', 'error');
            mode = 'pick';
            continue;
          }
          break;
        }
      }
      if (!loops.length) return;
      ed.commit('Hatch', () => {
        const { pattern, scale, angle } = st;
        const h = ed.drawing.add(ed.make('hatch', { loops, pattern, scale, angle }));
        placeBehindBoundary(ed, h.id, loops, selected);
      });
    } finally {
      ed.ui.showHatchPanel?.(null);
    }
  },
};

async function hatchSettingsPrompt(ed, st) {
  const name = await ed.getString('Pattern name', { default: st.pattern });
  const pat = name ? getPattern(name) : null;
  if (pat) st.pattern = pat.name;
  else if (name) {
    const list = patternNames().join(', ');
    ed.ui.log(`There is no hatch pattern named "${name}". Patterns: ${list}.`, 'error');
  }
  const s = await ed.getNumber('Pattern scale', { default: st.scale });
  if (Number.isFinite(s) && s > 0) st.scale = s;
  const a = await ed.getAngle('Pattern angle', { default: st.angle });
  if (typeof a === 'number') st.angle = a;
}
