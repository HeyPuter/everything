// Properties editor for surfaces: Object Data tab (Shape resolutions, Texture Space, Active Spline in
// Edit Mode) and the type-specific tab icon.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, numberField, opButton } from '../ui/widgets';
import { propertiesTabs } from '../editors/properties/properties';
import { dataTabDrawers, dataBlockSelector } from '../editors/properties/tabs';
import { texSpacePanel } from '../editors/properties/more/mesh';
import { splitRow } from '../ui/props';
import type { CurveData, ObjectData, Spline } from '../data/types';
import { activeSurface, inSurfaceEdit, surfaceState } from './edit';
import { gridSize } from './nurbs';

const changed = (label: string) => {
  app.changed('doc', 'geometry');
  app.pushUndo(label);
};

/** A labelled pair of controls (U and V) on one split row. */
function pairRow(label: string, a: Child, b: Child): Child {
  return splitRow(label, h('div', { class: 'su-pair' }, a, b));
}

function intField(id: string, label: string, value: number, min: number, max: number, set: (v: number) => void): Child {
  return numberField({ id, label, value, min, max, int: true, set: (x, final) => (set(Math.round(x)), app.changed('doc', 'geometry'), final && app.pushUndo(label)) });
}

function shapePanel(cu: CurveData): Child {
  return panel('su-shape', 'Shape', () => [
    pairRow(
      'Resolution Preview',
      intField(`su-ru-${cu.id}`, 'U', cu.resolution_u, 1, 1024, (v) => {
        cu.resolution_u = v;
        // the curve setting drives every spline, as editing it in the panel does
        for (const sp of cu.splines) sp.resolution_u = v;
      }),
      intField(`su-rv-${cu.id}`, 'V', cu.resolution_v ?? 4, 1, 1024, (v) => {
        cu.resolution_v = v;
        for (const sp of cu.splines) sp.resolution_v = v;
      }),
    ),
    pairRow('Render', intField(`su-rru-${cu.id}`, 'U', cu.render_resolution_u ?? 0, 0, 1024, (v) => (cu.render_resolution_u = v)), intField(`su-rrv-${cu.id}`, 'V', cu.render_resolution_v ?? 0, 0, 1024, (v) => (cu.render_resolution_v = v))),
  ]);
}

/** The spline of the active point, or the first spline with a selected point. */
function activeSpline(cu: CurveData): Spline | null {
  const a = surfaceState.active;
  if (a && cu.splines[a.s]) return cu.splines[a.s];
  return cu.splines.find((sp) => sp.points.some((p) => p.select)) ?? null;
}

function activeSplinePanel(cu: CurveData): Child {
  const sp = activeSpline(cu);
  return panel('su-spline', 'Active Spline', () => {
    if (!sp) return h('div', { class: 'prop-note' }, 'Select a control point');
    const { u, v } = gridSize(sp);
    const flag = (key: keyof Spline, label: string, dirOk = true) => checkbox(`su-${String(key)}`, label, !!sp[key], (on) => (((sp as unknown as Record<string, boolean>)[key as string] = on), changed(label)), { disabled: !dirOk });
    const orderMax = (n: number) => Math.max(2, Math.min(6, n));
    return [
      pairRow('Cyclic', flag('use_cyclic_u', 'U'), flag('use_cyclic_v', 'V', v > 1)),
      pairRow('Bézier', flag('use_bezier_u', 'U'), flag('use_bezier_v', 'V', v > 1)),
      pairRow('Endpoint', flag('use_endpoint_u', 'U'), flag('use_endpoint_v', 'V', v > 1)),
      pairRow(
        'Order',
        intField('su-ou', 'U', sp.order_u, 2, orderMax(u), (x) => (sp.order_u = x)),
        v > 1 ? intField('su-ov', 'V', sp.order_v ?? 2, 2, orderMax(v), (x) => (sp.order_v = x)) : h('span'),
      ),
      pairRow(
        'Resolution',
        intField('su-ru', 'U', sp.resolution_u, 1, 1024, (x) => (sp.resolution_u = x)),
        intField('su-rv', 'V', sp.resolution_v ?? cu.resolution_v ?? 4, 1, 1024, (x) => (sp.resolution_v = x)),
      ),
      splitRow('', checkbox('su-smooth', 'Smooth', sp.use_smooth, (on) => ((sp.use_smooth = on), changed('Smooth')))),
    ];
  });
}

function surfaceData(o: ObjectData): Child {
  const cu = o.data ? app.doc.curves[o.data] : undefined;
  if (!cu) return h('div', { class: 'prop-note' }, 'No data');
  return [
    dataBlockSelector('su', 'surface_data', Object.values(app.doc.curves).filter((c) => c.surface || c.id === cu.id), cu.id, (id) => id && ((o.data = id), changed('Assign Surface')), () => {}, { noUnlink: true }),
    shapePanel(cu),
    texSpacePanel('su-texspace', cu, () => app.graph.get(o.id)?.mesh?.positions ?? new Float32Array(0), () => h('div', { class: 'btn-row' }, opButton('curve.match_texture_space', 'Match Texture Space'))),
    inSurfaceEdit() && activeSurface()?.cu === cu ? activeSplinePanel(cu) : null,
  ];
}

dataTabDrawers.SURFACE = surfaceData;

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const prev = Object.getOwnPropertyDescriptor(dataTab, 'icon');
  const base = () => (prev?.get ? prev.get.call(dataTab) : prev?.value) as string;
  Object.defineProperty(dataTab, 'icon', { get: () => (app.activeObject?.type === 'SURFACE' ? 'surface_data' : base()), configurable: true });
}
const matTab = propertiesTabs.find((t) => t.id === 'MATERIAL');
if (matTab) {
  const poll = matTab.poll;
  matTab.poll = () => app.activeObject?.type === 'SURFACE' || poll();
}
