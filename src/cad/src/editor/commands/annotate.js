/**
 * Annotation commands: text, multiline text, dimensions, leaders, hatching.
 */
import { opts } from '../input.js';
import { closestPoint, intersectPrims, toPrims } from '../../core/geom/index.js';
import { findBoundary, toHatchLoops } from '../../core/hatch/boundary.js';
import { loopsToRings, pointInRing } from '../../core/hatch/fill.js';
import { tessellate } from '../../core/geom/index.js';
import { angleOf, loopFromEntity } from './util.js';

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
        if (ed.drawing.textStyles.has(s)) ed.commit('Text style', () => ed.drawing.setHeader({ textStyle: s }));
        else ed.ui.log(`There is no text style named "${s}".`, 'error');
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
    if (e.type === 'circle') return [{ x: e.cx - e.r, y: e.cy }, { x: e.cx + e.r, y: e.cy }];
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
    const make = (p, text, fixedRot) => {
      let rot = fixedRot;
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
    let v, p1, p2;
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
        const second = await ed.getEntity('Select second line', { filter: (x) => x.type === 'line' });
        if (!second || second.option) return;
        const f = second.ent;
        const ip = intersectPrims(toPrims(e)[0], toPrims(f)[0], { extA: true, extB: true });
        if (!ip || !ip.length) {
          ed.ui.log('The lines are parallel.', 'error');
          return;
        }
        v = ip[0];
        // Rays from the vertex toward the picked side of each line.
        const side = (ln, px, py) => {
          const far = Math.hypot(ln.x1 - v.x, ln.y1 - v.y) > Math.hypot(ln.x2 - v.x, ln.y2 - v.y) ? { x: ln.x1, y: ln.y1 } : { x: ln.x2, y: ln.y2 };
          const proj = (px - v.x) * (far.x - v.x) + (py - v.y) * (far.y - v.y);
          return proj >= 0 ? far : { x: 2 * v.x - far.x, y: 2 * v.y - far.y };
        };
        p1 = side(e, pick.x, pick.y);
        p2 = side(f, second.x, second.y);
      }
    }
    const make = (p, text) => dimBase(ed, { dimType: 'angular', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: v.x, y3: v.y, lx: p.x, ly: p.y, text });
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
    ed.ui.log('Select an arc or a circle.', 'error');
    return;
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

/** Curves (polylines in world space) of visible geometry around a point, for boundary detection. */
function curvesNear(ed, rect) {
  const out = [];
  const tol = 0.5 / ed.camera.scale;
  for (const id of ed.doc.index.search(rect[0], rect[1], rect[2], rect[3], false)) {
    const e = ed.drawing.get(id);
    if (!e || !ed.drawing.layerVisible(e.layer)) continue;
    if (e.type === 'hatch' || e.type === 'text' || e.type === 'mtext' || e.type === 'dimension' || e.type === 'point') continue;
    if (e.type === 'line') out.push({ pts: [e.x1, e.y1, e.x2, e.y2], closed: false });
    else {
      try {
        for (const p of tessellate(e, tol)) out.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return out;
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
    ed.ui.showHatchPanel?.(st, () => ed.renderer.setPreview(pendingPreview()));
    let loops = [];
    // Loops before each pick, so Undo takes back a whole pick with its islands.
    const history = [];
    const pendingPreview = () => (loops.length ? [ed.make('hatch', { loops, pattern: st.pattern, scale: st.scale, angle: st.angle })] : []);
    let mode = 'pick';
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
            if (l) loops.push(l);
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
      ed.commit('Hatch', () => ed.drawing.add(ed.make('hatch', { loops, pattern: st.pattern, scale: st.scale, angle: st.angle })));
    } finally {
      ed.ui.showHatchPanel?.(null);
    }
  },
};

async function hatchSettingsPrompt(ed, st) {
  const name = await ed.getString('Pattern name', { default: st.pattern });
  if (name) st.pattern = name.toUpperCase();
  const s = await ed.getNumber('Pattern scale', { default: st.scale });
  if (Number.isFinite(s) && s > 0) st.scale = s;
  const a = await ed.getAngle('Pattern angle', { default: st.angle });
  if (typeof a === 'number') st.angle = a;
}
