/**
 * Live shape properties (shared by the Properties and Transform panels):
 * size, angle and corners of a live rectangle (linked or per corner: type
 * and radius, absolute or relative rounding), an ellipse's size, angle and
 * pie, a polygon's sides, radius, side length and corners, a star's points,
 * radii and corners, and a line's length and angle. Edits regenerate the
 * anchors; dragging a field's label or using the arrow keys coalesces into
 * one undo step.
 */
import { h } from '../../lib/dom.js';
import { numberField, iconButton, selectField, segmented } from '../widgets.js';
import { regenerateShape, isPie } from '../../model/shapes.js';
import { nodeFrameAngle, normAngle } from '../../model/geometry.js';

export const SHAPE_TITLES = { rect: 'Rectangle Properties', ellipse: 'Ellipse Properties', polygon: 'Polygon Properties', star: 'Star Properties', line: 'Line Properties' };
const CORNER_TYPES = [
  { value: 'round', label: 'Round' },
  { value: 'inverted', label: 'Inverted Round' },
  { value: 'chamfer', label: 'Chamfer' },
];
const ROUNDING = [
  { value: 'absolute', label: 'Absolute', text: 'Absolute' },
  { value: 'relative', label: 'Relative', text: 'Relative' },
];
const CORNER_NAMES = ['Top left', 'Top right', 'Bottom right', 'Bottom left'];

/** The single selected live shape node, or null. */
export function selectedShape(ed) {
  const nodes = ed.selectedNodes();
  const n = nodes.length === 1 ? nodes[0] : null;
  return n?.type === 'path' && n.shape && SHAPE_TITLES[n.shape.kind] ? n : null;
}

/**
 * A live shape section: { el, title, update(ed) -> shown }. `kinds` limits
 * the shape kinds it shows (default: all).
 */
export function createShapeSection(app, { kinds = null } = {}) {
  const state = { linked: true, id: null, key: null, fields: null };
  const body = h('div.shape-props');
  const section = {
    el: body,
    title: '',
    update(ed) {
      const n = selectedShape(ed);
      if (!n || (kinds && !kinds.includes(n.shape.kind))) {
        state.key = null;
        return false;
      }
      const shape = n.shape;
      section.title = SHAPE_TITLES[shape.kind];
      if (state.id !== n.id) state.linked = new Set(shape.radii || [0]).size === 1 && new Set(shape.cornerTypes || ['round']).size === 1;
      const unit = ed.doc.root.units || 'pt';
      const key = `${n.id}:${shape.kind}:${state.linked}:${isPie(shape)}:${unit}`;
      if (state.key !== key) {
        state.key = key;
        state.id = n.id;
        state.fields = buildShapeFields(state, ed, n.id, shape, () => {
          state.key = null;
          section.update(app.editor);
        });
        body.replaceChildren(...state.fields.els, h('button.btn.small', { type: 'button', onclick: () => ed.doc.transact('Expand Shape', () => ed.doc.update(n.id, { shape: undefined })) }, 'Expand Shape'));
      }
      state.fields.refresh(ed.doc.get(n.id));
      return true;
    },
  };
  return section;
}

/** Fields for a live shape's params: { els, refresh(node) }. */
function buildShapeFields(state, ed, id, shape, rebuild) {
  const unit = ed.doc.root.units || 'pt';
  const doc = ed.doc;
  const set = (patchFn, live) => {
    const cur = doc.get(id);
    if (!cur?.shape) return;
    const next = { ...cur.shape, ...patchFn(cur.shape) };
    const anchors = regenerateShape(next, cur.anchors);
    if (!anchors) return;
    // Turning the shape turns its bounding box with it.
    const turn = (next.angle || 0) - (cur.shape.angle || 0);
    const frame = turn && cur.shape.kind !== 'line' ? { frameAngle: normAngle(nodeFrameAngle(cur) + turn) } : {};
    doc.transact('Change Shape', () => doc.update(id, { shape: next, anchors, ...frame }), { coalesce: live ? `shape-${id}` : null });
  };
  const len = (label, get, put, extra = {}) => {
    const f = numberField({ label, value: 0, unit, min: 0, onCommit: (v, o) => set((s) => put(v, s), o?.live), ...extra });
    return { el: f.el, refresh: (n) => f.set(get(n.shape, n)) };
  };
  const num = (label, get, put, extra = {}) => len(label, get, put, { kind: 'number', unit: undefined, ...extra });
  const ang = (label, get, put, extra = {}) => len(label, get, put, { kind: 'angle', unit: undefined, min: -360, max: 360, ...extra });
  // The shape's own angle, shown counterclockwise; stored clockwise in [0, 360).
  const stored = (v) => (((-v % 360) + 360) % 360) || 0;
  const angleField = () => ang('Shape angle', (s) => normAngle(-(s.angle || 0)), (v) => ({ angle: stored(v) }), { icon: 'rotate-ccw' });
  const typeSelect = (label, get, put) => {
    const f = selectField(label, CORNER_TYPES, 'round', put);
    f.el.classList.add('corner-type');
    return { el: f.el, refresh: (n) => f.set(get(n)) };
  };
  const fields = [];
  const extras = [];
  const k = shape.kind;

  // Polygons and stars round every corner alike (live corners on their anchors).
  const anchorCorner = (n) => n?.anchors.find((a) => a.corner)?.corner || null;
  const setAnchorCorners = (patch, live) => {
    const cur = doc.get(id);
    if (!cur) return;
    const c0 = anchorCorner(cur) || { r: 0, type: 'round' };
    const c = { ...c0, ...patch };
    const anchors = cur.anchors.map((a) => {
      const { corner, ...rest } = a;
      return c.r > 0 || c.type !== 'round' ? { ...rest, corner: { r: c.r, type: c.type, ...(c.rounding === 'relative' ? { rounding: 'relative' } : {}) } } : rest;
    });
    doc.transact('Round Corners', () => doc.update(id, { anchors }), { coalesce: live ? `corners-${id}` : null });
  };
  const anchorCornerFields = () => {
    const r = numberField({ label: 'Corner radius', icon: 'square-dashed', value: 0, unit, min: 0, onCommit: (v, o) => setAnchorCorners({ r: v }, o?.live) });
    fields.push({ el: r.el, refresh: (n) => r.set(anchorCorner(n)?.r || 0) });
    const t = typeSelect('Corner type', (n) => anchorCorner(n)?.type || 'round', (v) => setAnchorCorners({ type: v }));
    extras.push(h('div.shape-corner-row', h('span.prop-label', 'Corners'), t.el));
    fields.push({ el: null, refresh: t.refresh });
  };

  if (k === 'rect' || k === 'ellipse') {
    fields.push(len('W', (s) => s.w, (v) => ({ w: Math.max(0.01, v) }), { ariaLabel: 'Shape width' }));
    fields.push(len('H', (s) => s.h, (v) => ({ h: Math.max(0.01, v) }), { ariaLabel: 'Shape height' }));
    fields.push(angleField());
  }
  if (k === 'rect') {
    const types = (s) => s.cornerTypes || ['round', 'round', 'round', 'round'];
    const withTypes = (s, next) => (next.some((t) => t !== 'round') ? { cornerTypes: next } : { cornerTypes: undefined });
    const linkBtn = iconButton(state.linked ? 'link' : 'unlink', 'Link corner radius values', () => {
      state.linked = !state.linked;
      rebuild();
    }, { pressed: state.linked });
    if (state.linked) {
      fields.push(len('Corner radius', (s) => s.radii?.[0] || 0, (v) => ({ radii: [v, v, v, v] }), { icon: 'square-dashed' }));
      const t = typeSelect('Corner type', (n) => types(n.shape)[0], (v) => set((s) => withTypes(s, [v, v, v, v])));
      extras.push(h('div.shape-corner-row', h('span.prop-label', 'Corners'), t.el, linkBtn));
      fields.push({ el: null, refresh: t.refresh });
    } else {
      const rows = CORNER_NAMES.map((name, i) => {
        const r = len(['TL', 'TR', 'BR', 'BL'][i], (s) => s.radii?.[i] || 0, (v, s) => {
          const radii = [...(s.radii || [0, 0, 0, 0])];
          radii[i] = v;
          return { radii };
        }, { ariaLabel: `${name} corner radius` });
        const t = typeSelect(`${name} corner type`, (n) => types(n.shape)[i], (v) => set((s) => {
          const next = [...types(s)];
          next[i] = v;
          return withTypes(s, next);
        }));
        fields.push(r, { el: null, refresh: t.refresh });
        return h('div.shape-corner-row', t.el, r.el);
      });
      extras.push(h('div.shape-corners', rows), h('div.shape-corners-link', linkBtn, h('span.prop-label', 'Each corner separately')));
    }
    const rounding = segmented('Rounding', ROUNDING, shape.rounding || 'absolute', (v) => {
      rounding.set(v);
      set(() => ({ rounding: v === 'relative' ? 'relative' : undefined }));
    });
    extras.push(h('div.shape-corner-row', h('span.prop-label', 'Rounding'), rounding.el));
    fields.push({ el: null, refresh: (n) => rounding.set(n.shape.rounding || 'absolute') });
  } else if (k === 'ellipse') {
    fields.push(ang('Pie start', (s) => (isPie(s) ? s.pieStart : 0), (v, s) => ({ pieStart: ((v % 360) + 360) % 360, pieEnd: isPie(s) ? s.pieEnd : 0 })));
    fields.push(ang('Pie end', (s) => (isPie(s) ? s.pieEnd : 0), (v, s) => ({ pieEnd: ((v % 360) + 360) % 360, pieStart: isPie(s) ? s.pieStart : 0 })));
    if (isPie(shape)) {
      extras.push(h('div.shape-actions',
        h('button.btn.small', { type: 'button', onclick: () => set((s) => ({ pieStart: s.pieEnd, pieEnd: s.pieStart })) }, 'Invert Pie'),
        h('button.btn.small', { type: 'button', onclick: () => set(() => ({ pieStart: undefined, pieEnd: undefined })) }, 'Close Pie'),
      ));
    }
  } else if (k === 'polygon') {
    fields.push(num('Sides', (s) => s.sides, (v) => ({ sides: Math.max(3, Math.min(1000, Math.round(v))) }), { min: 3, max: 1000 }));
    fields.push(len('Radius', (s) => s.r, (v) => ({ r: v })));
    fields.push(len('Side length', (s) => 2 * s.r * Math.sin(Math.PI / s.sides), (v, s) => ({ r: v / (2 * Math.sin(Math.PI / s.sides)) })));
    fields.push(ang('Angle', (s) => normAngle(-(s.angle || 0)), (v) => ({ angle: stored(v) })));
    anchorCornerFields();
  } else if (k === 'star') {
    fields.push(num('Points', (s) => s.points, (v) => ({ points: Math.max(3, Math.min(1000, Math.round(v))) }), { min: 3, max: 1000 }));
    fields.push(len('Radius 1', (s) => s.r1, (v) => ({ r1: v })));
    fields.push(len('Radius 2', (s) => s.r2, (v) => ({ r2: v })));
    fields.push(ang('Angle', (s) => normAngle(-(s.angle || 0)), (v) => ({ angle: stored(v) })));
    anchorCornerFields();
  } else if (k === 'line') {
    const angleOf = (s) => (-Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
    fields.push(len('Length', (s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1), (v, s) => {
      const a = (-angleOf(s) * Math.PI) / 180;
      return { x2: s.x1 + Math.cos(a) * v, y2: s.y1 + Math.sin(a) * v };
    }));
    fields.push(ang('Angle', angleOf, (v, s) => {
      const l = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const a = (-v * Math.PI) / 180;
      return { x2: s.x1 + Math.cos(a) * l, y2: s.y1 + Math.sin(a) * l };
    }));
  }
  return {
    els: [h('div.shape-fields', fields.filter((f) => f.el && !f.el.isConnected && !extras.some((x) => x.contains(f.el))).map((f) => f.el)), ...extras],
    refresh: (n) => n?.shape && fields.forEach((f) => f.refresh(n)),
  };
}
