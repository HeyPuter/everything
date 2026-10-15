// Sculpt Mode header menus (Sculpt, Mask, Face Sets), pie menus and the extra Sculpt keymap entries.
import { app, operators } from '../app/app';
import { addKeys, keymaps, keyLabel, type KeyItem } from '../app/keymap';
import { openPie, openPopover, type MenuItem, type PieItem } from '../ui/menu';
import { icon } from '../ui/icons';
import { overlayPopoverSections } from '../editors/view3d/hooks';
import { modeMenus } from '../editors/view3d/modemenus';
import { toolSettingsRenderers } from '../editors/view3d/toolbar';
import { h, type Child } from '../ui/h';
import { button, checkbox, enumMenu, numberField, opButton, row, type Unit } from '../ui/widgets';
import { activeMeshData } from './session';
import { faceSetEditTool, maskByColorTool, sculptToolHooks } from './sculpttools';

const has = (op: string) => operators.has(op);

/** Shortcut label of the first Sculpt keymap item running `op` with matching props. */
function sc(op: string, props?: Record<string, unknown>) {
  const k = (keymaps.Sculpt ?? []).find((x) => !x.inactive && x.op === op && (!props || Object.entries(props).every(([p, v]) => x.props?.[p] === v)));
  return k ? keyLabel(k) : undefined;
}

type Item = MenuItem | null | false | undefined;
/** Operator entry, dropped when the operator is not registered. */
function op(label: string, idname: string, props?: Record<string, unknown>): Item {
  return has(idname) ? { label, op: idname, props, shortcut: sc(idname, props) } : null;
}
const sep: MenuItem = { separator: true };

/** Remove missing entries and duplicate / dangling separators. */
export function clean(items: Item[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
    if (it.submenu && !it.submenu().length) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

const filter = (label: string, type: string) => op(label, 'sculpt.mesh_filter', { type });

function transformMenu(): MenuItem[] {
  return clean([op('Move', 'transform.translate'), op('Rotate', 'transform.rotate'), op('Scale', 'transform.resize'), sep, filter('To Sphere', 'SPHERE')]);
}

function showHideMenu(): MenuItem[] {
  return clean([
    op('Box Hide', 'paint.hide_show', { action: 'HIDE' }),
    op('Lasso Hide', 'paint.hide_show_lasso_gesture', { action: 'HIDE' }),
    op('Line Hide', 'paint.hide_show_line_gesture', { action: 'HIDE' }),
    op('Polyline Hide', 'paint.hide_show_polyline_gesture', { action: 'HIDE' }),
    sep,
    op('Box Show', 'paint.hide_show', { action: 'SHOW' }),
    op('Lasso Show', 'paint.hide_show_lasso_gesture', { action: 'SHOW' }),
    op('Line Show', 'paint.hide_show_line_gesture', { action: 'SHOW' }),
    op('Polyline Show', 'paint.hide_show_polyline_gesture', { action: 'SHOW' }),
  ]);
}

function trimMenu(): MenuItem[] {
  return clean([
    op('Box Trim', 'sculpt.trim_box_gesture', { trim_mode: 'DIFFERENCE' }),
    op('Lasso Trim', 'sculpt.trim_lasso_gesture', { trim_mode: 'DIFFERENCE' }),
    op('Line Trim', 'sculpt.trim_line_gesture', { trim_mode: 'DIFFERENCE' }),
    op('Polyline Trim', 'sculpt.trim_polyline_gesture', { trim_mode: 'DIFFERENCE' }),
    sep,
    op('Box Add', 'sculpt.trim_box_gesture', { trim_mode: 'JOIN' }),
    op('Lasso Add', 'sculpt.trim_lasso_gesture', { trim_mode: 'JOIN' }),
    op('Polyline Add', 'sculpt.trim_polyline_gesture', { trim_mode: 'JOIN' }),
  ]);
}

function pivotMenu(): MenuItem[] {
  const p = (label: string, mode: string) => op(label, 'sculpt.set_pivot_position', { mode });
  return clean([p('Pivot to Origin', 'ORIGIN'), p('Pivot to Unmasked', 'UNMASKED'), p('Pivot to Mask Border', 'BORDER'), p('Pivot to Active Vertex', 'ACTIVE'), p('Pivot to Surface Under Cursor', 'SURFACE')]);
}

export function sculptMenu(): MenuItem[] {
  return clean([
    { label: 'Transform', submenu: transformMenu },
    sep,
    op('Toggle Visibility', 'sculpt.face_set_change_visibility', { mode: 'TOGGLE', active_face_set: -1 }),
    op('Hide Active Face Set', 'sculpt.face_set_change_visibility', { mode: 'HIDE_ACTIVE', active_face_set: -1 }),
    op('Show All', 'paint.hide_show_all', { action: 'SHOW' }),
    op('Invert Visible', 'paint.visibility_invert'),
    op('Hide Masked', 'paint.hide_show_masked', { action: 'HIDE' }),
    op('Grow Visibility', 'paint.visibility_filter', { action: 'GROW' }),
    op('Shrink Visibility', 'paint.visibility_filter', { action: 'SHRINK' }),
    { label: 'Show/Hide', submenu: showHideMenu },
    sep,
    op('Fair Positions', 'sculpt.face_set_edit', { mode: 'FAIR_POSITIONS', active_face_set: -1 }),
    op('Fair Tangency', 'sculpt.face_set_edit', { mode: 'FAIR_TANGENCY', active_face_set: -1 }),
    op('Line Project', 'sculpt.project_line_gesture'),
    { label: 'Trim/Add', submenu: trimMenu },
    sep,
    filter('Smooth', 'SMOOTH'),
    filter('Surface Smooth', 'SURFACE_SMOOTH'),
    filter('Inflate', 'INFLATE'),
    filter('Relax Topology', 'RELAX'),
    filter('Relax Face Sets', 'RELAX_FACE_SETS'),
    filter('Sharpen', 'SHARPEN'),
    filter('Enhance Details', 'ENHANCE_DETAILS'),
    filter('Randomize', 'RANDOM'),
    sep,
    op('Set Vertex Color', 'sculpt.color_filter', { type: 'FILL' }),
    op('Sample Color', 'paint.sample_color'),
    sep,
    { label: 'Set Pivot', submenu: pivotMenu },
    sep,
    op('Rebuild BVH', 'sculpt.optimize'),
    op('Voxel Remesh', 'object.voxel_remesh'),
  ]);
}

function randomMaskMenu(): MenuItem[] {
  const p = (label: string, mode: string) => op(label, 'sculpt.mask_init', { mode });
  return clean([p('Per Vertex', 'RANDOM_PER_VERTEX'), p('Per Face Set', 'RANDOM_PER_FACE_SET'), p('Per Loose Part', 'RANDOM_PER_LOOSE_PART')]);
}

export function maskMenu(): MenuItem[] {
  const f = (label: string, filter_type: string) => op(label, 'sculpt.mask_filter', { filter_type });
  return clean([
    op('Fill Mask', 'paint.mask_flood_fill', { mode: 'VALUE', value: 1 }),
    op('Clear Mask', 'paint.mask_flood_fill', { mode: 'VALUE', value: 0 }),
    op('Invert Mask', 'paint.mask_flood_fill', { mode: 'INVERT' }),
    sep,
    op('Box Mask', 'paint.mask_box_gesture'),
    op('Lasso Mask', 'paint.mask_lasso_gesture'),
    op('Line Mask', 'paint.mask_line_gesture'),
    op('Polyline Mask', 'paint.mask_polyline_gesture'),
    sep,
    f('Smooth Mask', 'SMOOTH'),
    f('Sharpen Mask', 'SHARPEN'),
    f('Grow Mask', 'GROW'),
    f('Shrink Mask', 'SHRINK'),
    f('Increase Contrast', 'CONTRAST_INCREASE'),
    f('Decrease Contrast', 'CONTRAST_DECREASE'),
    sep,
    op('Expand Mask by Topology', 'sculpt.expand', { target: 'MASK', falloff_type: 'GEODESIC' }),
    op('Expand Mask by Normals', 'sculpt.expand', { target: 'MASK', falloff_type: 'NORMALS' }),
    sep,
    op('Mask Extract', 'sculpt.paint_mask_extract'),
    sep,
    op('Mask Slice', 'sculpt.paint_mask_slice', { fill_holes: false, new_object: false }),
    op('Mask Slice and Fill Holes', 'sculpt.paint_mask_slice', { fill_holes: true, new_object: false }),
    op('Mask Slice to New Object', 'sculpt.paint_mask_slice', { fill_holes: true, new_object: true }),
    sep,
    op('Mask from Cavity', 'sculpt.mask_from_cavity'),
    op('Mask from Mesh Boundary', 'sculpt.mask_from_boundary', { boundary_mode: 'MESH' }),
    op('Mask from Face Sets Boundary', 'sculpt.mask_from_boundary', { boundary_mode: 'FACE_SETS' }),
    op('Mask by Color', 'sculpt.mask_by_color'),
    sep,
    { label: 'Random Mask', submenu: randomMaskMenu },
  ]);
}

function faceSetsInitMenu(): MenuItem[] {
  const p = (label: string, mode: string) => op(label, 'sculpt.face_sets_init', { mode });
  return clean([
    p('By Loose Parts', 'LOOSE_PARTS'),
    p('By Face Set Boundaries', 'FACE_SET_BOUNDARIES'),
    p('By Materials', 'MATERIALS'),
    p('By Normals', 'NORMALS'),
    p('By UV Seams', 'UV_SEAMS'),
    p('By Edge Creases', 'CREASES'),
    p('By Sharp Edges', 'SHARP_EDGES'),
  ]);
}

export function faceSetsMenu(): MenuItem[] {
  return clean([
    op('Face Set from Masked', 'sculpt.face_sets_create', { mode: 'MASKED' }),
    op('Face Set from Visible', 'sculpt.face_sets_create', { mode: 'VISIBLE' }),
    op('Face Set from Edit Mode Selection', 'sculpt.face_sets_create', { mode: 'SELECTION' }),
    sep,
    { label: 'Initialize Face Sets', submenu: faceSetsInitMenu },
    sep,
    op('Grow Face Set', 'sculpt.face_set_edit', { mode: 'GROW', active_face_set: -1 }),
    op('Shrink Face Set', 'sculpt.face_set_edit', { mode: 'SHRINK', active_face_set: -1 }),
    sep,
    op('Expand Face Set by Topology', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'GEODESIC' }),
    op('Expand Active Face Set', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'BOUNDARY_FACE_SET' }),
    sep,
    op('Extract Face Set', 'sculpt.face_set_extract', { face_set: -1 }),
    sep,
    op('Randomize Colors', 'sculpt.face_sets_randomize_colors'),
  ]);
}

modeMenus.SCULPT = {
  ...(modeMenus.SCULPT ?? {}),
  select: () => [],
  header: () => [
    ['Sculpt', sculptMenu],
    ['Mask', maskMenu],
    ['Face Sets', faceSetsMenu],
  ],
};

// ---------------------------------------------------------------------------
// pies

function pie(title: string, key: string, items: (PieItem | null)[]) {
  openPie(
    title,
    items.map((it) => (it && (!it.op || has(it.op)) ? it : null)),
    app.pointer.x,
    app.pointer.y,
    key,
  );
  return [] as MenuItem[];
}

function faceSetsPie() {
  return pie('Face Sets Edit', 'W', [
    { label: 'Face Set from Masked', op: 'sculpt.face_sets_create', props: { mode: 'MASKED' } },
    { label: 'Face Set from Visible', op: 'sculpt.face_sets_create', props: { mode: 'VISIBLE' } },
    { label: 'Invert Visible', op: 'paint.visibility_invert' },
    { label: 'Show All', op: 'paint.hide_show_all', props: { action: 'SHOW' } },
  ]);
}

// ---------------------------------------------------------------------------
// keys

const sculptMode = () => app.doc.mode === 'SCULPT';
const k = (key: string, op: string, props?: Record<string, unknown>, mods: Partial<KeyItem> = {}): KeyItem => ({ key, op, props, ...mods, when: sculptMode });

addKeys('Sculpt', [
  k('R', 'object.voxel_size_edit'),
  k('R', 'sculpt.dyntopo_detail_size_edit'),
  k('R', 'sculpt.detail_flood_fill', {}, { ctrl: true }),
  k('A', 'sculpt.expand', { target: 'MASK', falloff_type: 'GEODESIC', invert: false, use_mask_preserve: true }, { shift: true }),
  k('A', 'sculpt.expand', { target: 'MASK', falloff_type: 'NORMALS', invert: false, use_mask_preserve: true }, { shift: true, alt: true }),
  k('W', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'GEODESIC', invert: false, use_mask_preserve: false, use_modify_active: false }, { shift: true }),
  k('W', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'BOUNDARY_FACE_SET', invert: false, use_mask_preserve: false, use_modify_active: true }, { shift: true, alt: true }),
  k('H', 'sculpt.face_set_change_visibility', { mode: 'TOGGLE' }, { shift: true }),
  k('H', 'sculpt.face_set_change_visibility', { mode: 'HIDE_ACTIVE' }),
  k('H', 'paint.hide_show_all', { action: 'SHOW' }, { alt: true }),
  k('PAGE_UP', 'paint.visibility_filter', { action: 'GROW' }),
  k('PAGE_DOWN', 'paint.visibility_filter', { action: 'SHRINK' }),
  k('W', 'sculpt.face_set_edit', { mode: 'GROW' }, { ctrl: true }),
  k('W', 'sculpt.face_set_edit', { mode: 'SHRINK' }, { ctrl: true, alt: true }),
  { key: 'W', alt: true, menu: faceSetsPie, menuTitle: 'Face Sets Edit', when: sculptMode },
]);

// ---------------------------------------------------------------------------
// click tools: Edit Face Set, Mask by Color

export const faceSetEditSettings = { mode: 'GROW' };
export const maskByColorSettings = { threshold: 0.35, contiguous: false, invert: false, preserve_previous_mask: false };

sculptToolHooks.pointer.push((_v, e, tool) => {
  const ev = { x: e.clientX, y: e.clientY };
  if (tool === faceSetEditTool.id) {
    app.run('sculpt.face_set_edit', { mode: e.ctrlKey || e.metaKey ? (faceSetEditSettings.mode === 'GROW' ? 'SHRINK' : 'GROW') : faceSetEditSettings.mode }, { event: ev });
    return true;
  }
  if (tool === maskByColorTool.id) {
    if (!activeMeshData()?.me.color_attributes.length) app.report('WARNING', 'Mask by Color needs a color attribute');
    else app.run('sculpt.mask_by_color', { ...maskByColorSettings }, { event: ev });
    return true;
  }
  return false;
});

const thBox = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
toolSettingsRenderers[faceSetEditTool.id] = () => [
  thBox(
    120,
    enumMenu(
      'th-fse-mode',
      [
        { value: 'GROW', label: 'Grow Face Set' },
        { value: 'SHRINK', label: 'Shrink Face Set' },
      ],
      faceSetEditSettings.mode,
      (x) => ((faceSetEditSettings.mode = x), app.changed('ui')),
    ),
  ),
  h('span', { class: 'th-label' }, 'Click a face set · Ctrl: opposite'),
];
toolSettingsRenderers[maskByColorTool.id] = () => {
  const st = maskByColorSettings;
  const set = (k: keyof typeof st) => (x: unknown) => (((st as Record<string, unknown>)[k] = x), app.changed('ui'));
  return [
    checkbox('th-mbc-cont', 'Contiguous', st.contiguous, set('contiguous')),
    checkbox('th-mbc-inv', 'Invert', st.invert, set('invert')),
    checkbox('th-mbc-pres', 'Preserve Mask', st.preserve_previous_mask, set('preserve_previous_mask')),
    thBox(140, numberField({ id: 'th-mbc-thr', label: 'Threshold', value: st.threshold, min: 0, max: 1, slider: true, set: set('threshold') })),
  ];
};

// ---------------------------------------------------------------------------
// auto-masking (Alt+A pie, tool header popover, sidebar panel)

type AutoKey =
  | 'use_automasking_topology'
  | 'use_automasking_face_sets'
  | 'use_automasking_boundary_edges'
  | 'use_automasking_boundary_face_sets'
  | 'use_automasking_cavity'
  | 'use_automasking_cavity_inverted'
  | 'use_automasking_start_normal'
  | 'use_automasking_view_normal';
const AUTO: [AutoKey, string, string][] = [
  ['use_automasking_topology', 'Topology', 'Only affect the part of the mesh connected to where the stroke starts'],
  ['use_automasking_face_sets', 'Face Sets', 'Only affect the face set under the stroke start'],
  ['use_automasking_boundary_edges', 'Mesh Boundary', 'Do not affect the open borders of the mesh'],
  ['use_automasking_boundary_face_sets', 'Face Sets Boundary', 'Do not affect the borders between face sets'],
  ['use_automasking_cavity', 'Cavity', 'Only affect the cavities of the mesh'],
  ['use_automasking_cavity_inverted', 'Cavity (Inverted)', 'Only affect the raised parts of the mesh'],
  ['use_automasking_start_normal', 'Area Normal', 'Only affect surfaces facing like the stroke start'],
  ['use_automasking_view_normal', 'View Normal', 'Only affect surfaces facing the view'],
];

function toggleAuto(k: AutoKey) {
  const ts = app.doc.scene.tool_settings.sculpt;
  ts[k] = !ts[k];
  if (k === 'use_automasking_cavity' && ts[k]) ts.use_automasking_cavity_inverted = false;
  if (k === 'use_automasking_cavity_inverted' && ts[k]) ts.use_automasking_cavity = false;
  app.changed('ui');
}

function automaskPie() {
  const ts = app.doc.scene.tool_settings.sculpt;
  openPie(
    'Automasking',
    AUTO.map(([k, label]) => ({ label, active: !!ts[k], action: () => toggleAuto(k) })),
    app.pointer.x,
    app.pointer.y,
    'A',
  );
  return [] as MenuItem[];
}

/** Auto-masking settings (popover / sidebar panel body). */
export function automaskSettings(prefix: string): Child[] {
  const ts = app.doc.scene.tool_settings.sculpt;
  const rows: Child[] = AUTO.map(([k, label, tip]) => checkbox(`${prefix}-${k}`, label, !!ts[k], () => toggleAuto(k), { tip }));
  const num = (id: string, label: string, key: keyof typeof ts, def: number, o: { min: number; max: number; int?: boolean; unit?: string }) =>
    numberField({ id: `${prefix}-${id}`, label, value: (ts[key] as number | undefined) ?? def, min: o.min, max: o.max, int: o.int, unit: o.unit as Unit | undefined, slider: !o.int, set: (x) => (((ts as unknown as Record<string, number>)[key as string] = x), app.changed('ui')) });
  if (ts.use_automasking_boundary_edges || ts.use_automasking_boundary_face_sets) rows.push(num('steps', 'Propagation Steps', 'automasking_boundary_edges_propagation_steps', 1, { min: 1, max: 20, int: true }));
  if (ts.use_automasking_cavity || ts.use_automasking_cavity_inverted) {
    rows.push(num('cavf', 'Cavity Factor', 'automasking_cavity_factor', 1, { min: 0, max: 5 }));
    rows.push(num('cavb', 'Cavity Blur', 'automasking_cavity_blur_steps', 0, { min: 0, max: 25, int: true }));
  }
  if (ts.use_automasking_start_normal) {
    rows.push(num('snl', 'Area Normal Limit', 'automasking_start_normal_limit', 0.35, { min: 0.0001, max: Math.PI, unit: 'angle' }));
    rows.push(num('snf', 'Area Normal Falloff', 'automasking_start_normal_falloff', 0.25, { min: 0.0001, max: 1 }));
  }
  if (ts.use_automasking_view_normal) {
    rows.push(num('vnl', 'View Normal Limit', 'automasking_view_normal_limit', 1.57, { min: 0.0001, max: Math.PI, unit: 'angle' }));
    rows.push(num('vnf', 'View Normal Falloff', 'automasking_view_normal_falloff', 0.25, { min: 0.0001, max: 1 }));
  }
  return rows;
}

export function automaskButton(): Child {
  const ts = app.doc.scene.tool_settings.sculpt;
  const on = AUTO.some(([k]) => ts[k]);
  return h(
    'button',
    {
      key: 'th-automask',
      class: { 'hdr-toggle': true, on },
      'data-tip': 'Auto-Masking (Alt A)',
      onclick: (e: MouseEvent) => openPopover(e.currentTarget as HTMLElement, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, 'Auto-Masking'), ...automaskSettings('pop-am')), { width: 240 }),
    },
    icon('automask'),
  );
}

addKeys('Sculpt', [{ key: 'A', alt: true, menu: automaskPie, menuTitle: 'Automasking', when: sculptMode }]);

// ---------------------------------------------------------------------------
// overlay popover: mask and face set display

overlayPopoverSections.push((v) => {
  if (app.doc.mode !== 'SCULPT') return null;
  const o = v.overlay;
  const set = (k: string) => (x: unknown) => (((o as unknown as Record<string, unknown>)[k] = x), app.changed('ui'));
  return [
    h('div', { class: 'pop-sub' }, 'Sculpt'),
    h('div', { class: 'row-split' }, checkbox('o-smask', 'Mask', o.show_sculpt_mask !== false, set('show_sculpt_mask')), numberField({ id: 'o-smask-op', value: o.sculpt_mode_mask_opacity, min: 0, max: 1, slider: true, set: set('sculpt_mode_mask_opacity') })),
    h('div', { class: 'row-split' }, checkbox('o-sfs', 'Face Sets', o.show_sculpt_face_sets !== false, set('show_sculpt_face_sets')), numberField({ id: 'o-sfs-op', value: o.sculpt_mode_face_sets_opacity ?? 1, min: 0, max: 1, slider: true, set: set('sculpt_mode_face_sets_opacity') })),
  ];
});

// ---------------------------------------------------------------------------
// dyntopo panel and header toggle

export function dyntopoSettings(prefix: string): Child[] {
  const ts = app.doc.scene.tool_settings.sculpt;
  const ch = () => app.changed('ui');
  const method = ts.detail_type_method ?? 'RELATIVE';
  const rows: Child[] = [
    checkbox(`${prefix}-on`, 'Dyntopo', !!ts.use_dyntopo, () => app.run('sculpt.dynamic_topology_toggle'), { tip: 'Add and remove triangles under the brush (triangulates the mesh)' }),
  ];
  if (!ts.use_dyntopo) return rows;
  if (method === 'CONSTANT' || method === 'MANUAL')
    rows.push(
      h(
        'div',
        { class: 'row-split' },
        numberField({ id: `${prefix}-res`, label: 'Resolution', value: ts.constant_detail_resolution ?? 6, min: 0.01, max: 1000, tip: 'Triangles per unit length', set: (x) => ((ts.constant_detail_resolution = x), ch()) }),
        button(`${prefix}-sample`, icon('eyedropper'), () => app.run('sculpt.sample_detail_size', { mode: 'DYNTOPO' }), { tip: 'Sample the detail from the mesh under the cursor (click, then hover)' }),
      ),
    );
  else if (method === 'BRUSH') rows.push(numberField({ id: `${prefix}-pct`, label: 'Detail Percentage', value: ts.detail_percent ?? 25, min: 0.5, max: 100, unit: 'percentage', tip: 'Edge length as a percentage of the brush radius', set: (x) => ((ts.detail_percent = x), ch()) }));
  else rows.push(numberField({ id: `${prefix}-size`, label: 'Detail Size', value: ts.detail_size ?? 12, min: 0.5, max: 40, unit: 'pixel', tip: 'Edge length in screen pixels (R)', set: (x) => ((ts.detail_size = x), ch()) }));
  rows.push(
    row(
      'Refine Method',
      enumMenu(
        `${prefix}-refine`,
        [
          { value: 'SUBDIVIDE', label: 'Subdivide Edges' },
          { value: 'COLLAPSE', label: 'Collapse Edges' },
          { value: 'SUBDIVIDE_COLLAPSE', label: 'Subdivide Collapse' },
        ],
        ts.detail_refine_method ?? 'SUBDIVIDE_COLLAPSE',
        (x) => ((ts.detail_refine_method = x as 'SUBDIVIDE'), ch()),
      ),
    ),
    row(
      'Detailing',
      enumMenu(
        `${prefix}-type`,
        [
          { value: 'RELATIVE', label: 'Relative Detail' },
          { value: 'CONSTANT', label: 'Constant Detail' },
          { value: 'BRUSH', label: 'Brush Detail' },
          { value: 'MANUAL', label: 'Manual Detail' },
        ],
        method,
        (x) => ((ts.detail_type_method = x as 'RELATIVE'), ch()),
      ),
    ),
    opButton('sculpt.detail_flood_fill', 'Detail Flood Fill'),
  );
  return rows;
}
