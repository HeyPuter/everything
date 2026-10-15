// Sculpt Mode header menus (Sculpt, Mask, Face Sets), pie menus and the extra Sculpt keymap entries.
import { app, operators } from '../app/app';
import { addKeys, keymaps, keyLabel, type KeyItem } from '../app/keymap';
import { openPie, type MenuItem, type PieItem } from '../ui/menu';
import { modeMenus } from '../editors/view3d/modemenus';
import { toolSettingsRenderers } from '../editors/view3d/toolbar';
import { h, type Child } from '../ui/h';
import { checkbox, enumMenu, numberField } from '../ui/widgets';
import { activeMeshData } from './session';
import { faceSetEditTool, maskByColorTool, sculptToolHooks } from './sculpttools';

const has = (op: string) => operators.has(op);

/** Shortcut label of the first Sculpt keymap item running `op` with matching props. */
function sc(op: string, props?: Record<string, unknown>) {
  const k = (keymaps.Sculpt ?? []).find((x) => x.op === op && (!props || Object.entries(props).every(([p, v]) => x.props?.[p] === v)));
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
    op('Toggle Visibility', 'sculpt.face_set_change_visibility', { mode: 'TOGGLE' }),
    op('Hide Active Face Set', 'sculpt.face_set_change_visibility', { mode: 'HIDE_ACTIVE' }),
    op('Show All', 'paint.hide_show_all', { action: 'SHOW' }),
    op('Invert Visible', 'paint.visibility_invert'),
    op('Hide Masked', 'paint.hide_show_masked', { action: 'HIDE' }),
    op('Grow Visibility', 'paint.visibility_filter', { action: 'GROW' }),
    op('Shrink Visibility', 'paint.visibility_filter', { action: 'SHRINK' }),
    { label: 'Show/Hide', submenu: showHideMenu },
    sep,
    op('Fair Positions', 'sculpt.face_set_edit', { mode: 'FAIR_POSITIONS' }),
    op('Fair Tangency', 'sculpt.face_set_edit', { mode: 'FAIR_TANGENCY' }),
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
    op('Grow Face Set', 'sculpt.face_set_edit', { mode: 'GROW' }),
    op('Shrink Face Set', 'sculpt.face_set_edit', { mode: 'SHRINK' }),
    sep,
    op('Expand Face Set by Topology', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'GEODESIC' }),
    op('Expand Active Face Set', 'sculpt.expand', { target: 'FACE_SETS', falloff_type: 'BOUNDARY_FACE_SET' }),
    sep,
    op('Extract Face Set', 'sculpt.face_set_extract'),
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
