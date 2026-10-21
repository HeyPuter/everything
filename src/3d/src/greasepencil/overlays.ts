// Viewport Overlays ▸ Grease Pencil: onion skins, fade inactive layers / other objects, edit lines
// (Shift Q, Shift Alt Q only with multi-frame editing), point opacity and the drawing canvas grid.
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, Matrix4, Scene, Vector3 } from 'three';
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { overlayPopoverHooks } from '../editors/view3d/header';
import { viewportExtensions } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { h } from '../ui/h';
import { checkbox, numberField, colorSwatch, enumMenu } from '../ui/widgets';
import { gpOf, gpTS } from './data';

export interface GPOverlay {
  use_gpencil_onion_skin?: boolean;
  /** onion skins of the active object only */
  use_gpencil_onion_skin_active_object?: boolean;
  /** canvas drawn over everything */
  use_gpencil_canvas_xray?: boolean;
  gpencil_grid_offset?: [number, number];
  use_gpencil_fade_layers?: boolean;
  gpencil_fade_layer?: number;
  use_gpencil_fade_objects?: boolean;
  gpencil_fade_objects?: number;
  use_gpencil_edit_lines?: boolean;
  use_gpencil_multiedit_line_only?: boolean;
  gpencil_vertex_paint_opacity?: number;
  vertex_opacity?: number;
  use_gpencil_grid?: boolean;
  gpencil_grid_opacity?: number;
  gpencil_grid_color?: [number, number, number];
  gpencil_grid_scale?: [number, number];
  gpencil_grid_subdivisions?: number;
}

/** Grease pencil overlay settings of a viewport (defaults filled in). */
export function gpOverlay(v: View3D | null = activeView3D()): GPOverlay & Required<Pick<GPOverlay, 'gpencil_fade_layer' | 'gpencil_fade_objects' | 'vertex_opacity' | 'gpencil_grid_opacity'>> {
  const o = (v?.overlay ?? {}) as unknown as GPOverlay;
  o.gpencil_fade_layer ??= 0.5;
  o.gpencil_fade_objects ??= 0.5;
  o.vertex_opacity ??= 1;
  o.gpencil_grid_opacity ??= 0.9;
  return o as ReturnType<typeof gpOverlay>;
}

const gpModes = new Set(['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL', 'EDIT']);
export const inGPModeNow = () => gpModes.has(app.doc.mode) && !!gpOf(app.doc, app.activeObject);

/** Opacity factor for a layer of an object in the viewport (fade inactive layers / other objects). */
export function fadeFactor(obId: string, layerIndex: number, activeLayer: number): number {
  if (!inGPModeNow()) return 1;
  const o = gpOverlay();
  if (obId !== app.activeObject?.id) return o.use_gpencil_fade_objects ? o.gpencil_fade_objects : 1;
  if (o.use_gpencil_fade_layers && layerIndex !== activeLayer) return o.gpencil_fade_layer;
  return 1;
}

overlayPopoverHooks.push((v) => {
  if (!gpOf(app.doc, app.activeObject)) return null;
  const o = gpOverlay(v);
  const set = (k: keyof GPOverlay) => (x: unknown) => {
    (o as unknown as Record<string, unknown>)[k] = x;
    renderContext?.forceSync?.();
    app.changed('ui', 'doc');
  };
  const edit = app.doc.mode === 'EDIT' || app.doc.mode === 'SCULPT_GREASE_PENCIL' || app.doc.mode === 'WEIGHT_GREASE_PENCIL' || app.doc.mode === 'VERTEX_GREASE_PENCIL';
  return [
    h('div', { class: 'pop-sub' }, 'Grease Pencil'),
    h(
      'div',
      { class: 'pop-grid' },
      checkbox('gpo-onion', 'Onion Skins', o.use_gpencil_onion_skin !== false, set('use_gpencil_onion_skin')),
      checkbox('gpo-onion-act', 'Active Object Only', !!o.use_gpencil_onion_skin_active_object, set('use_gpencil_onion_skin_active_object')),
      checkbox('gpo-fadel', 'Fade Inactive Layers', !!o.use_gpencil_fade_layers, set('use_gpencil_fade_layers')),
      checkbox('gpo-fadeo', 'Fade Grease Pencil Objects', !!o.use_gpencil_fade_objects, set('use_gpencil_fade_objects')),
      checkbox('gpo-grid', 'Canvas', !!o.use_gpencil_grid, set('use_gpencil_grid')),
    ),
    o.use_gpencil_fade_layers ? numberField({ id: 'gpo-fadel-v', label: 'Layer Opacity', value: o.gpencil_fade_layer, min: 0, max: 1, slider: true, set: (x) => set('gpencil_fade_layer')(x) }) : null,
    o.use_gpencil_fade_objects ? numberField({ id: 'gpo-fadeo-v', label: 'Object Opacity', value: o.gpencil_fade_objects, min: 0, max: 1, slider: true, set: (x) => set('gpencil_fade_objects')(x) }) : null,
    o.use_gpencil_grid
      ? [
          numberField({ id: 'gpo-grid-op', label: 'Grid Opacity', value: o.gpencil_grid_opacity, min: 0.1, max: 1, slider: true, set: (x) => set('gpencil_grid_opacity')(x) }),
          checkbox('gpo-grid-xray', 'X-Ray', !!o.use_gpencil_canvas_xray, set('use_gpencil_canvas_xray'), { tip: 'Canvas X-Ray\nShow the canvas grid over the scene' }),
          numberField({ id: 'gpo-grid-ox', label: 'Offset X', value: (o.gpencil_grid_offset ?? [0, 0])[0], min: -100, max: 100, step: 0.1, set: (x) => set('gpencil_grid_offset')([x, (o.gpencil_grid_offset ?? [0, 0])[1]]) }),
          numberField({ id: 'gpo-grid-oy', label: 'Offset Y', value: (o.gpencil_grid_offset ?? [0, 0])[1], min: -100, max: 100, step: 0.1, set: (x) => set('gpencil_grid_offset')([(o.gpencil_grid_offset ?? [0, 0])[0], x]) }),
          numberField({ id: 'gpo-grid-sc', label: 'Grid Scale', value: (o.gpencil_grid_scale ?? [1, 1])[0], min: 0.01, max: 100, set: (x) => set('gpencil_grid_scale')([x, x]) }),
          numberField({ id: 'gpo-grid-sub', label: 'Subdivisions', value: o.gpencil_grid_subdivisions ?? 4, min: 1, max: 32, int: true, set: (x) => set('gpencil_grid_subdivisions')(Math.round(x)) }),
          colorSwatch('gpo-grid-col', o.gpencil_grid_color ?? [0.5, 0.5, 0.5], (c) => set('gpencil_grid_color')(c.slice(0, 3))),
        ]
      : null,
    edit
      ? [
          h('div', { class: 'pop-grid' }, checkbox('gpo-lines', 'Edit Lines', o.use_gpencil_edit_lines !== false, set('use_gpencil_edit_lines')), checkbox('gpo-mlines', 'Only in Multiframe', !!o.use_gpencil_multiedit_line_only, set('use_gpencil_multiedit_line_only'))),
          numberField({ id: 'gpo-vop', label: 'Vertex Opacity', value: o.vertex_opacity, min: 0, max: 1, slider: true, set: (x) => set('vertex_opacity')(x) }),
          app.doc.mode === 'EDIT'
            ? h(
                'div',
                { class: 'pop-line' },
                h('span', null, 'Handles'),
                enumMenu(
                  'gpo-handles',
                  [
                    { value: 'ALL', label: 'All' },
                    { value: 'SELECTED', label: 'Selected' },
                    { value: 'NONE', label: 'None' },
                  ],
                  v.overlay.display_handle ?? 'SELECTED',
                  (x) => {
                    v.overlay.display_handle = x as 'ALL';
                    app.changed('ui');
                  },
                ),
              )
            : null,
        ]
      : null,
  ];
});

const toggle = (k: keyof GPOverlay, def: boolean) => () => {
  const o = gpOverlay();
  (o as unknown as Record<string, boolean>)[k] = !((o[k] as boolean | undefined) ?? def);
  app.changed('ui', 'doc');
};
const editLike = () => inGPModeNow() && app.doc.mode !== 'PAINT_GREASE_PENCIL';
addKeys('Grease Pencil', [
  { key: 'Q', shift: true, when: editLike, action: toggle('use_gpencil_edit_lines', true) },
  { key: 'Q', shift: true, alt: true, when: editLike, action: toggle('use_gpencil_multiedit_line_only', false) },
]);

// ---------------------------------------------------------------------------
// canvas grid: lines on the drawing plane through the object origin

const gridScene = new Scene();
const gridGeo = new BufferGeometry();
const gridMat = new LineBasicMaterial({ transparent: true, depthTest: true, depthWrite: false });
const grid = new LineSegments(gridGeo, gridMat);
grid.frustumCulled = false;
grid.matrixAutoUpdate = false;
gridScene.add(grid);
let gridKey = '';

function buildGrid(sub: number, scale: number) {
  const pos: number[] = [];
  const n = 10 * sub;
  const step = scale / sub;
  for (let i = -n; i <= n; i++) {
    pos.push(i * step, 0, -n * step, i * step, 0, n * step);
    pos.push(-n * step, 0, i * step, n * step, 0, i * step);
  }
  gridGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
}

viewportExtensions.push((v) => {
  const fn = (_s: unknown, camera: import('three').Camera) => {
    const o = gpOverlay(v);
    const ob = app.activeObject;
    if (!o.use_gpencil_grid || !v.overlay.show_overlays || !ob || !gpOf(app.doc, ob) || !inGPModeNow()) return;
    const sub = o.gpencil_grid_subdivisions ?? 4,
      sc = (o.gpencil_grid_scale ?? [1, 1])[0];
    const key = `${sub}|${sc}`;
    if (key !== gridKey) {
      gridKey = key;
      buildGrid(sub, sc);
    }
    const c = o.gpencil_grid_color ?? [0.5, 0.5, 0.5];
    gridMat.color.setRGB(c[0], c[1], c[2]);
    gridMat.opacity = o.gpencil_grid_opacity;
    // X-Ray: the canvas shows through everything
    gridMat.depthTest = !o.use_gpencil_canvas_xray;
    // the grid lies on the drawing plane (front X-Z by default) at the object origin
    const world = app.graph.get(ob.id)?.world ?? new Matrix4();
    const axis = gpTS(app.doc).gpencil_lock_axis;
    const rot = new Matrix4();
    if (axis === 'AXIS_Z') rot.makeRotationX(Math.PI / 2);
    else if (axis === 'AXIS_X') rot.makeRotationZ(Math.PI / 2);
    // the offset moves the grid within its plane (local X / Z of the front plane before turning)
    const off = o.gpencil_grid_offset ?? [0, 0];
    grid.matrix.copy(new Matrix4().setPosition(new Vector3().setFromMatrixPosition(world)).multiply(rot).multiply(new Matrix4().makeTranslation(off[0], 0, off[1])));
    grid.matrixWorld.copy(grid.matrix);
    renderContext?.engine.renderer.render(gridScene, camera);
  };
  v.extraOverlays.push(fn);
  return () => {
    const i = v.extraOverlays.indexOf(fn);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});
