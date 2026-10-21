// 3D viewport header (mode selector, menus, transform settings, shading).
import { solidLightingChooser, hdriChooser } from './studiochooser';
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu, openPopover, type MenuItem } from '../../ui/menu';
import { app } from '../../app/app';
import { prefs } from '../../app/prefs';
import { currentOrientation, customOrientations, setOrientation, BUILTIN_ORIENTATIONS } from '../../ops/orientations';
import { gizmoOrientationSlot, setGizmoOrientationSlot } from './transformtool';
import { activeView3D, type View3D } from './view3d';
import { viewMenu, selectMenu, addMenu, objectMenu } from './menus';
import { modeMenus } from './modemenus';
import { overlayPopoverSections } from './hooks';
import { checkbox, numberField, enumRow, colorSwatch, panel, enumMenu } from '../../ui/widgets';
import type { Mode } from '../../data/types';
import { renderContext } from '../../render/context';

export const MODE_ITEMS: { mode: Mode; label: string; icon: string; types: string[] }[] = [
  { mode: 'OBJECT', label: 'Object Mode', icon: 'object_datamode', types: ['*'] },
  { mode: 'EDIT', label: 'Edit Mode', icon: 'editmode_hlt', types: ['MESH', 'CURVE', 'FONT', 'ARMATURE', 'LATTICE'] },
  { mode: 'SCULPT', label: 'Sculpt Mode', icon: 'sculptmode_hlt', types: ['MESH'] },
  { mode: 'VERTEX_PAINT', label: 'Vertex Paint', icon: 'vpaint_hlt', types: ['MESH'] },
  { mode: 'WEIGHT_PAINT', label: 'Weight Paint', icon: 'wpaint_hlt', types: ['MESH'] },
  { mode: 'TEXTURE_PAINT', label: 'Texture Paint', icon: 'tpaint_hlt', types: ['MESH'] },
  { mode: 'POSE', label: 'Pose Mode', icon: 'pose_hlt', types: ['ARMATURE'] },
];

export function availableModes() {
  const ob = app.activeObject;
  return MODE_ITEMS.filter((m) => m.types.includes('*') || (ob && m.types.includes(ob.type)));
}

function menuButton(label: string, items: () => MenuItem[], search = false) {
  return h(
    'button',
    {
      key: `menu-${label}`,
      class: 'hdr-menu',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openMenu(items(), e.currentTarget as HTMLElement, { search });
      },
      onpointerenter: (e: PointerEvent) => {
        // menu bar hover switching while a header menu is open
        if (document.querySelector('.hdr-menu.menu-open') && !(e.currentTarget as HTMLElement).classList.contains('menu-open')) openMenu(items(), e.currentTarget as HTMLElement, { search });
      },
    },
    label,
  );
}

const ORIENTATIONS = BUILTIN_ORIENTATIONS;

const PIVOTS = [
  ['BOUNDING_BOX_CENTER', 'Bounding Box Center', 'pivot_boundbox'],
  ['CURSOR', '3D Cursor', 'pivot_cursor'],
  ['INDIVIDUAL_ORIGINS', 'Individual Origins', 'pivot_individual'],
  ['MEDIAN_POINT', 'Median Point', 'pivot_median'],
  ['ACTIVE_ELEMENT', 'Active Element', 'pivot_active'],
] as const;

const SNAP_ELEMENTS = [
  ['INCREMENT', 'Increment', 'snap_increment'],
  ['GRID', 'Grid', 'snap_grid'],
  ['VERTEX', 'Vertex', 'snap_vertex'],
  ['EDGE', 'Edge', 'snap_edge'],
  ['FACE', 'Face', 'snap_face'],
  ['VOLUME', 'Volume', 'snap_volume'],
  ['EDGE_MIDPOINT', 'Edge Center', 'snap_midpoint'],
  ['EDGE_PERPENDICULAR', 'Edge Perpendicular', 'snap_perpendicular'],
  ['FACE_CENTER', 'Face Center', 'snap_face_center'],
] as const;

function iconDrop(id: string, iconName: string, tip: string, onDown: (el: HTMLElement) => void, extraClass = '') {
  return h(
    'button',
    {
      key: id,
      class: `hdr-icondrop ${extraClass}`,
      'data-tip': tip,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        onDown(e.currentTarget as HTMLElement);
      },
    },
    // a dropdown-only button (next to a toggle) shows just its arrow
    iconName === 'down_arrow_hlt' ? icon('down_arrow_hlt', 'tiny') : [icon(iconName), icon('down_arrow_hlt', 'tiny')],
  );
}

function iconToggle(id: string, iconName: string, on: boolean, tip: string, onClick: () => void) {
  return h('button', { key: id, class: { 'hdr-toggle': true, on }, 'data-tip': tip, onclick: onClick }, icon(iconName));
}

export function viewHeader(v: View3D): Child {
  // while a modal operation runs in this viewport its header shows the operation's values
  if (app.modal?.header && activeView3D() === v) return h('div', { class: 'hdr-row hdr-modal' }, h('span', { class: 'hdr-modal-text', style: 'padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis' }, app.modal.header()));
  const doc = app.doc;
  const ts = doc.scene.tool_settings;
  const mode = MODE_ITEMS.find((m) => m.mode === doc.mode) ?? MODE_ITEMS[0];
  const mm = modeMenus[doc.mode];
  const curOrient = currentOrientation();
  const orient: readonly [string, string, string] = ORIENTATIONS.find((o) => o[0] === curOrient) ?? [curOrient, curOrient, 'orientation_local'];
  const pivot = PIVOTS.find((p) => p[0] === ts.transform_pivot_point) ?? PIVOTS[3];
  const snapEl = SNAP_ELEMENTS.find((s) => s[0] === ts.snap_elements[0]) ?? SNAP_ELEMENTS[0];
  const propOn = doc.mode === 'OBJECT' ? ts.use_proportional_edit_objects : ts.use_proportional_edit;
  const sh = v.shading;
  return h(
    'div',
    { class: 'hdr-row' },
    // mode selector
    h(
      'button',
      {
        key: 'mode',
        class: 'hdr-mode',
        disabled: !app.activeObject,
        'data-tip': 'Interaction Mode\nSets the object interaction mode',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(
            availableModes().map((m) => ({ label: m.label, icon: m.icon, active: m.mode === doc.mode, action: () => app.run('object.mode_set', { mode: m.mode }) })),
            e.currentTarget as HTMLElement,
          );
        },
      },
      icon(mode.icon),
      h('span', null, mode.label),
      icon('down_arrow_hlt', 'tiny'),
    ),
    mm?.headerLead?.() ?? null,
    menuButton('View', viewMenu),
    !mm?.select || mm.select().length ? menuButton('Select', selectMenu) : null,
    (doc.mode === 'OBJECT' || doc.mode === 'EDIT') && (!mm?.add || mm.add().length) ? menuButton('Add', mm?.add ?? addMenu, true) : null,
    doc.mode === 'OBJECT' ? menuButton('Object', objectMenu) : null,
    ...(mm?.header?.() ?? []).map(([label, fn]) => menuButton(label, fn)),
    mm?.headerExtra?.() ?? null,
    h('div', { class: 'hdr-spacer' }),
    // transform orientation
    h(
      'button',
      {
        key: 'orient',
        class: 'hdr-drop',
        'data-tip': 'Transform Orientation',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(orientationMenu(), e.currentTarget as HTMLElement, { title: 'Transform Orientations' });
        },
      },
      icon(orient[2]),
      h('span', null, orient[1]),
      icon('down_arrow_hlt', 'tiny'),
    ),
    iconDrop('pivot', pivot[2], 'Transform Pivot Point', (el) =>
      openMenu(
        [
          ...PIVOTS.map(([id, label, ic]) => ({ label, icon: ic, active: ts.transform_pivot_point === id, action: () => setTool('transform_pivot_point', id) })),
          ...(doc.mode === 'OBJECT'
            ? [{ separator: true } as MenuItem, { label: 'Only Locations', checked: !!(ts as { use_transform_pivot_point_align?: boolean }).use_transform_pivot_point_align, action: () => setTool('use_transform_pivot_point_align', !(ts as { use_transform_pivot_point_align?: boolean }).use_transform_pivot_point_align) }]
            : []),
        ],
        el,
        { title: 'Pivot Point' },
      ),
    ),
    h(
      'div',
      { class: 'hdr-group' },
      iconToggle('snap', ts.use_snap ? 'snap_on' : 'snap_off', ts.use_snap, 'Snap (Shift Tab)\nSnap during transform', () => setTool('use_snap', !ts.use_snap)),
      iconDrop('snapel', snapEl[2], 'Snapping', (el) => openPopover(el, snappingPopover, { width: 240 })),
    ),
    h(
      'div',
      { class: 'hdr-group' },
      iconToggle('prop', propOn ? 'prop_on' : 'prop_off', propOn, 'Proportional Editing (O)', () => setTool(doc.mode === 'OBJECT' ? 'use_proportional_edit_objects' : 'use_proportional_edit', !propOn)),
      iconDrop('propfall', 'smooth', 'Proportional Editing Falloff', (el) =>
        openMenu(
          [
            ...['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'].map((f) => ({ label: f[0] + f.slice(1).toLowerCase().replace('_', ' '), active: ts.proportional_edit_falloff === f, action: () => setTool('proportional_edit_falloff', f) })),
            ...(doc.mode === 'EDIT' ? [{ separator: true } as MenuItem, { label: 'Connected Only', checked: ts.use_proportional_connected, action: () => setTool('use_proportional_connected', !ts.use_proportional_connected) }] : []),
          ],
          el,
          { title: 'Proportional Editing Falloff' },
        ),
      ),
    ),
    h('div', { class: 'hdr-spacer' }),
    // right side: visibility, gizmos, overlays, x-ray, shading
    iconDrop('vis', 'hide_off', 'Selectability & Visibility', (el) =>
      openPopover(el, () =>
        h(
          'div',
          { class: 'pop-panel' },
          h('div', { class: 'pop-title' }, 'Object Types Visibility'),
          (
            [
              ['MESH', 'Mesh', 'outliner_ob_mesh'],
              ['CURVE', 'Curve', 'outliner_ob_curve'],
              ['META', 'Metaball', 'outliner_ob_meta'],
              ['FONT', 'Text', 'outliner_ob_font'],
              ['CURVES', 'Curves', 'outliner_ob_curves'],
              ['ARMATURE', 'Armature', 'outliner_ob_armature'],
              ['LATTICE', 'Lattice', 'outliner_ob_lattice'],
              ['EMPTY', 'Empty', 'outliner_ob_empty'],
              ['LIGHT', 'Light', 'outliner_ob_light'],
              ['LIGHT_PROBE', 'Light Probe', 'outliner_ob_lightprobe'],
              ['CAMERA', 'Camera', 'outliner_ob_camera'],
              ['SPEAKER', 'Speaker', 'outliner_ob_speaker'],
            ] as const
          ).map(([t, label, ic]) =>
            h(
              'div',
              { key: t, class: 'pop-line vis-type' },
              icon(ic),
              h('span', { class: 'vt-label' }, label),
              iconToggle(`vis-${t}`, v.hiddenTypes.has(t) ? 'hide_on' : 'hide_off', !v.hiddenTypes.has(t), `Show ${label} objects in this viewport`, () => {
                if (v.hiddenTypes.has(t)) v.hiddenTypes.delete(t);
                else v.hiddenTypes.add(t);
                app.changed('ui');
              }),
              iconToggle(`sel-${t}`, v.unselectableTypes.has(t) ? 'restrict_select_on' : 'restrict_select_off', !v.unselectableTypes.has(t), `Allow selecting ${label} objects in this viewport`, () => {
                if (v.unselectableTypes.has(t)) v.unselectableTypes.delete(t);
                else v.unselectableTypes.add(t);
                app.changed('ui');
              }),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'hdr-group' },
      iconToggle('gizmos', 'transform', v.showGizmos, 'Show Gizmo', () => ((v.showGizmos = !v.showGizmos), v.drawSvg(), app.changed('ui'))),
      iconDrop('gizmo-pop', 'down_arrow_hlt', 'Gizmos', (el) =>
        openPopover(el, () =>
          h(
            'div',
            { class: 'pop-panel' },
            h('div', { class: 'pop-title' }, 'Viewport Gizmos'),
            checkbox('nav-g', 'Navigate', v.showNavGizmo, (x) => ((v.showNavGizmo = x), v.drawUI())),
            checkbox('tool-g', 'Active Tools', v.showToolGizmo, (x) => ((v.showToolGizmo = x), v.drawSvg(), app.changed('ui'))),
            checkbox('act-g', 'Active Object', v.dataGizmos.activeObject, (x) => ((v.dataGizmos.activeObject = x), v.drawSvg(), app.changed('ui'))),
            h('div', { class: 'pop-title' }, 'Object Gizmos'),
            enumMenu(
              'obg-orient',
              [{ value: 'DEFAULT', label: 'Default' }, ...ORIENTATIONS.map(([value, label, ic]) => ({ value, label, icon: ic })), ...customOrientations().map((c) => ({ value: c.name, label: c.name }))],
              gizmoOrientationSlot('move'),
              (x) => {
                for (const k of ['move', 'rotate', 'scale'] as const) setGizmoOrientationSlot(k, x);
                v.drawSvg();
              },
              { tip: 'Orientation\nOrientation of the object gizmos' },
            ),
            checkbox('obg-move', 'Move', v.objectGizmos.translate, (x) => ((v.objectGizmos.translate = x), v.drawSvg(), app.changed('ui'))),
            checkbox('obg-rot', 'Rotate', v.objectGizmos.rotate, (x) => ((v.objectGizmos.rotate = x), v.drawSvg(), app.changed('ui'))),
            checkbox('obg-scale', 'Scale', v.objectGizmos.scale, (x) => ((v.objectGizmos.scale = x), v.drawSvg(), app.changed('ui'))),
            ...dataGizmoRows(v),
          ),
        ),
      'hidden-icon'),
    ),
    h(
      'div',
      { class: 'hdr-group' },
      iconToggle('ov', 'overlay', v.overlay.show_overlays, 'Show Overlays (Shift Alt Z)', () => ((v.overlay.show_overlays = !v.overlay.show_overlays), app.changed('ui'))),
      iconDrop('ov-pop', 'down_arrow_hlt', 'Overlays', (el) => openPopover(el, () => overlayPopover(v), { width: 280 }), 'hidden-icon'),
    ),
    // edit mode overlays get their own dropdown
    app.doc.mode === 'EDIT' && (app.activeObject?.type === 'MESH' || app.activeObject?.type === 'CURVE' || app.activeObject?.type === 'CURVES')
      ? iconDrop('ov-edit', 'editmode_hlt', `${EDIT_OVERLAY_NAMES[app.activeObject.type]} Edit Mode Overlays`, (el) => openPopover(el, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, `${EDIT_OVERLAY_NAMES[app.activeObject?.type ?? 'MESH']} Edit Mode`), editOverlaySections(v)), { width: 260 }))
      : null,
    iconToggle('xray', 'xray', sh.type === 'WIREFRAME' ? sh.show_xray_wireframe : sh.show_xray, 'Toggle X-Ray (Alt Z)', () => {
      if (sh.type === 'WIREFRAME') sh.show_xray_wireframe = !sh.show_xray_wireframe;
      else sh.show_xray = !sh.show_xray;
      app.changed('ui');
    }),
    h(
      'div',
      { class: 'hdr-group shading' },
      (['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] as const).map((t) =>
        h(
          'button',
          {
            key: t,
            class: { 'hdr-toggle': true, on: sh.type === t },
            'data-tip': `Viewport Shading\n${{ WIREFRAME: 'Display the object as wire edges', SOLID: 'Display in solid mode', MATERIAL: 'Display in Material Preview mode', RENDERED: 'Display render preview' }[t]}`,
            onclick: () => {
              sh.type = t;
              renderContext?.forceSync();
              app.changed('ui');
            },
          },
          icon({ WIREFRAME: 'shading_wire', SOLID: 'shading_solid', MATERIAL: 'shading_texture', RENDERED: 'shading_rendered' }[t]),
        ),
      ),
      iconDrop('sh-pop', 'down_arrow_hlt', 'Shading', (el) => openPopover(el, () => shadingPopover(v), { width: 280 }), 'hidden-icon'),
    ),
  );
}

/** Gizmos popover rows for the object data gizmos (editors/view3d/datagizmos.ts). */
function dataGizmoRows(v: View3D): Child[] {
  const g = v.dataGizmos;
  const row = (key: keyof View3D['dataGizmos'], label: string) => checkbox(`dg-${key}`, label, g[key], (x) => ((g[key] = x), v.drawSvg(), app.changed('ui')));
  const off = !g.activeObject;
  return [
    h('div', { class: { 'pop-title': true, disabled: off } }, 'Empty'),
    row('empty_image', 'Image'),
    h('div', { class: { 'pop-title': true, disabled: off } }, 'Light'),
    row('light_size', 'Size'),
    row('light_look_at', 'Look At'),
    h('div', { class: { 'pop-title': true, disabled: off } }, 'Camera'),
    row('camera_lens', 'Lens'),
    row('camera_focus_distance', 'Focus Distance'),
  ];
}

/** Transform orientation dropdown: built-in and custom orientations, create / delete. */
function orientationMenu(): MenuItem[] {
  const cur = currentOrientation();
  const custom = customOrientations();
  return [
    ...ORIENTATIONS.map(([id, label, ic]) => ({ label, icon: ic, active: cur === id, action: () => setOrientation(id) })),
    ...(custom.length ? [{ separator: true } as MenuItem, ...custom.map((c) => ({ label: c.name, icon: 'orientation_local', active: cur === c.name, action: () => setOrientation(c.name) }))] : []),
    { separator: true },
    { label: 'Create Orientation', icon: 'add', op: 'transform.create_orientation', props: { use: true } },
    { label: 'Delete Orientation', icon: 'remove', op: 'transform.delete_orientation' },
  ];
}

type SnapExtras = { use_snap_grid_absolute?: boolean; snap_angle_increment_3d?: number; snap_angle_increment_3d_precision?: number; use_snap_backface_culling?: boolean; use_snap_selectable?: boolean; use_snap_translate?: boolean; use_snap_rotate?: boolean; use_snap_scale?: boolean };

/** Snapping popover (header snap dropdown, Shift Ctrl Tab). */
export function snappingPopover(): Child {
  const ts = app.doc.scene.tool_settings;
  const tx = ts as typeof ts & SnapExtras;
  const deg = Math.PI / 180;
  const flag = (k: keyof SnapExtras, def = false) => (tx[k] as boolean | undefined) ?? def;
  return h(
    'div',
    { class: 'pop-panel snap-pop' },
    h('div', { class: 'pop-title' }, 'Snap Base'),
    enumRow('snap-target', [['CLOSEST', 'Closest'], ['CENTER', 'Center'], ['MEDIAN', 'Median'], ['ACTIVE', 'Active']].map(([value, label]) => ({ value, label })), ts.snap_target, (x) => setTool('snap_target', x)),
    h('div', { class: 'pop-title' }, 'Snap Target'),
    h(
      'div',
      { class: 'pop-list' },
      SNAP_ELEMENTS.map(([id, label, ic]) =>
        h(
          'button',
          {
            key: id,
            class: { 'pop-item': true, on: ts.snap_elements.includes(id) },
            'data-tip': 'Shift-click to combine several element types',
            onclick: (e: MouseEvent) => {
              if (e.shiftKey) ts.snap_elements = ts.snap_elements.includes(id) ? ts.snap_elements.filter((x) => x !== id) : [...ts.snap_elements, id];
              else ts.snap_elements = [id];
              if (!ts.snap_elements.length) ts.snap_elements = ['INCREMENT'];
              app.pushUndo('Snap Element');
              app.changed('ui');
            },
          },
          icon(ic),
          label,
        ),
      ),
    ),
    checkbox('snap-abs', 'Absolute Increment Snap', !!tx.use_snap_grid_absolute, (x) => setTool('use_snap_grid_absolute', x), { disabled: !ts.snap_elements.includes('INCREMENT'), tip: 'Absolute Increment Snap\nIncrements land on the grid instead of stepping from where the move started' }),
    checkbox('snap-align', 'Align Rotation to Target', !!ts.use_snap_align_rotation, (x) => setTool('use_snap_align_rotation', x), { disabled: !ts.snap_elements.includes('FACE'), tip: 'Align Rotation to Target\nTurn the moved objects to the surface they snap to' }),
    checkbox('snap-cull', 'Backface Culling', flag('use_snap_backface_culling'), (x) => setTool('use_snap_backface_culling', x), { tip: 'Backface Culling\nIgnore faces turned away from the view' }),
    h('div', { class: 'pop-title' }, 'Target Selection'),
    h('button', { class: { 'pop-item': true, on: flag('use_snap_selectable') }, 'data-tip': 'Exclude Non-Selectable\nDo not snap to objects that cannot be selected', onclick: () => setTool('use_snap_selectable', !flag('use_snap_selectable')) }, icon('restrict_select_off'), 'Exclude Non-Selectable'),
    h('div', { class: 'pop-title' }, 'Affect'),
    h(
      'div',
      { class: 'enum-row snap-affect' },
      (
        [
          ['use_snap_translate', 'Move', true],
          ['use_snap_rotate', 'Rotate', false],
          ['use_snap_scale', 'Scale', false],
        ] as const
      ).map(([k, label, def]) => h('button', { key: k, class: { on: flag(k, def) }, onclick: () => setTool(k, !flag(k, def)) }, label)),
    ),
    h('div', { class: 'pop-title' }, 'Rotation Increment'),
    h(
      'div',
      { class: 'ov-scale-row' },
      numberField({ id: 'snap-rot', value: tx.snap_angle_increment_3d ?? 5 * deg, min: 0.01 * deg, max: Math.PI, unit: 'angle', tip: 'Rotation Increment\nAngle step of rotation snapping', set: (x) => setTool('snap_angle_increment_3d', x) }),
      numberField({ id: 'snap-rotp', value: tx.snap_angle_increment_3d_precision ?? 1 * deg, min: 0.01 * deg, max: Math.PI, unit: 'angle', tip: 'Precision Rotation Increment\nAngle step while Shift is held', set: (x) => setTool('snap_angle_increment_3d_precision', x) }),
    ),
  );
}

function setTool(key: string, value: unknown) {
  (app.doc.scene.tool_settings as unknown as Record<string, unknown>)[key] = value;
  app.pushUndo('Tool Setting');
  app.changed('ui', 'doc');
}

/** Extra sections of the Viewport Overlays popover (e.g. grease pencil options). */
export const overlayPopoverHooks: ((v: View3D) => Child)[] = [];
/** Extra sections of the Mesh Edit Mode overlays popover. */
export const editOverlayHooks: ((v: View3D) => Child)[] = [];

/** Is the viewport showing an orthographic axis view (where the Grid rather than the Floor applies)? */
function axisViewOf(v: View3D) {
  return v.nav.ortho && !v.cameraView && v.nav.view !== 'USER';
}

function overlayPopover(v: View3D): Child {
  const o = v.overlay;
  const set = (k: keyof typeof o) => (x: unknown) => {
    (o as unknown as Record<string, unknown>)[k] = x;
    app.changed('ui');
  };
  const axisBtn = (k: 'show_axis_x' | 'show_axis_y' | 'show_axis_z', l: string) => h('button', { key: k, class: { on: !!o[k] }, 'data-tip': `Show the ${l} axis line`, onclick: () => set(k)(!o[k]) }, l);
  return h(
    'div',
    { class: 'pop-panel' },
    h('div', { class: 'pop-title' }, 'Viewport Overlays'),
    panel('ov-guides', 'Guides', () => [
      // the Grid (orthographic axis views) and Floor (other views) switches apply to one kind of view each
      h(
        'div',
        { class: 'ov-guides-row' },
        checkbox('o-ogrid', 'Grid', o.show_ortho_grid, set('show_ortho_grid'), { tip: 'Grid\nShow the grid in orthographic side views', disabled: !axisViewOf(v) }),
        checkbox('o-grid', 'Floor', o.show_floor, set('show_floor'), { tip: 'Floor\nShow the ground plane grid', disabled: axisViewOf(v) }),
        h('div', { class: 'ov-axes' }, h('span', { class: 'ov-axes-label' }, 'Axes'), h('div', { class: 'enum-row' }, axisBtn('show_axis_x', 'X'), axisBtn('show_axis_y', 'Y'), axisBtn('show_axis_z', 'Z'))),
      ),
      h(
        'div',
        { class: 'ov-scale-row' },
        numberField({ id: 'o-gscale', label: 'Scale', value: o.grid_scale, min: 0.001, max: 1000, set: (x) => set('grid_scale')(x) }),
        numberField({ id: 'o-gsub', label: 'Subdivisions', value: o.grid_subdivisions ?? 10, min: 2, max: 1024, step: 1, int: true, disabled: !axisViewOf(v), set: (x) => set('grid_subdivisions')(Math.round(x)) }),
      ),
      h('div', { class: 'pop-grid' }, checkbox('o-cursor', '3D Cursor', o.show_cursor, set('show_cursor')), checkbox('o-ann', 'Annotations', o.show_annotation, set('show_annotation'))),
    ], { sub: true }),
    panel('ov-text', 'Text', () => [
      h('div', { class: 'pop-grid' }, checkbox('o-text', 'General Info', o.show_text, set('show_text')), checkbox('o-stats', 'Statistics', o.show_stats, set('show_stats'))),
      v.shading.type === 'MATERIAL' || v.shading.type === 'RENDERED' ? checkbox('o-lookdev', 'HDRI Preview', !!o.show_look_dev, set('show_look_dev'), { tip: 'HDRI Preview\nShow a matte and a mirror sphere lit by the current environment' }) : null,
    ], { sub: true }),
    panel('ov-objects', 'Objects', () => [
      h('div', { class: 'pop-grid' }, checkbox('o-extras', 'Extras', o.show_extras, set('show_extras')), checkbox('o-bones', 'Bones', o.show_bones, set('show_bones')), checkbox('o-lcol', 'Light Colors', !!o.show_light_colors, set('show_light_colors'), { tip: 'Light Colors\nDraw lights in the colour of their light', disabled: !o.show_extras }), checkbox('o-mpaths2', 'Motion Paths', o.show_motion_paths !== false, set('show_motion_paths')), checkbox('o-rel', 'Relationship Lines', o.show_relationship_lines, set('show_relationship_lines')), checkbox('o-orig', 'Origins', o.show_object_origins, set('show_object_origins')), checkbox('o-outline', 'Outline Selected', o.show_outline_selected, set('show_outline_selected')), checkbox('o-origall', 'Origins (All)', o.show_object_origins_all, set('show_object_origins_all'))),
    ], { sub: true }),
    panel('ov-geometry', 'Geometry', () => [
      h(
        'div',
        { class: 'ov-wire-row' },
        checkbox('o-wire', '', o.show_wireframes, set('show_wireframes'), { tip: 'Wireframe\nShow the wireframe of every object' }),
        numberField({ id: 'o-wireth', label: 'Wireframe', value: o.wireframe_threshold ?? 1, min: 0, max: 1, slider: true, tip: 'Wireframe Threshold\nLower values show only the edges between faces that meet at sharper angles', set: (x) => set('wireframe_threshold')(x) }),
        numberField({ id: 'o-wireop', label: 'Opacity', value: o.wireframe_opacity, min: 0, max: 1, slider: true, set: (x) => set('wireframe_opacity')(x) }),
      ),
      checkbox('o-faceor', 'Face Orientation', o.show_face_orientation, set('show_face_orientation')),
    ], { sub: true }),
    overlayPopoverSections.map((f) => f(v)),
    overlayPopoverHooks.map((f) => f(v)),
  );
}

const EDIT_OVERLAY_NAMES: Record<string, string> = { MESH: 'Mesh', CURVE: 'Curve', CURVES: 'Curves' };

/** Overlays of the edit mode (own header popover next to the overlays one). */
function editOverlaySections(v: View3D): Child {
  const o = v.overlay;
  const set = (k: keyof typeof o) => (x: unknown) => {
    (o as unknown as Record<string, unknown>)[k] = x;
    app.changed('ui');
  };
  if (app.activeObject?.type === 'CURVES')
    return [h('div', { class: 'pop-line' }, h('span', null, 'Handles'), enumMenu('o-handles', [{ value: 'ALL', label: 'All' }, { value: 'SELECTED', label: 'Selected' }, { value: 'NONE', label: 'None' }], o.display_handle ?? 'SELECTED', set('display_handle')))];
  if (app.activeObject?.type === 'CURVE')
    return [
      h('div', { class: 'pop-line' }, h('span', null, 'Handles'), enumMenu('o-handles', [{ value: 'ALL', label: 'All' }, { value: 'SELECTED', label: 'Selected' }, { value: 'NONE', label: 'None' }], o.display_handle ?? 'SELECTED', set('display_handle'))),
      checkbox('o-cnorm', 'Normals', o.show_curve_normals !== false, set('show_curve_normals')),
      numberField({ id: 'o-cnlen', label: 'Normal Size', value: o.normals_length, min: 0.0001, max: 100, set: (x) => set('normals_length')(x) }),
    ];
  return [
    h('div', { class: 'pop-grid' }, checkbox('o-seam', 'Seams', o.show_edge_seams, set('show_edge_seams')), checkbox('o-sharp', 'Sharp', o.show_edge_sharp, set('show_edge_sharp')), checkbox('o-crease', 'Crease', o.show_edge_crease, set('show_edge_crease')), checkbox('o-fcen', 'Center', o.show_face_center, set('show_face_center'))),
    panel('ov-mesh-measure', 'Measurement', () => [h('div', { class: 'pop-grid' }, checkbox('o-len', 'Edge Length', o.show_extra_edge_length, set('show_extra_edge_length')), prefs.show_developer_ui ? checkbox('o-idx', 'Indices', o.show_extra_indices, set('show_extra_indices')) : null)], { sub: true }),
    panel('ov-mesh-normals', 'Normals', () => [
      h('div', { class: 'pop-grid' }, checkbox('o-vnorm', 'Vertex Normals', o.show_vertex_normals, set('show_vertex_normals')), checkbox('o-fnorm', 'Face Normals', o.show_face_normals, set('show_face_normals'))),
      numberField({ id: 'o-nlen', label: 'Size', value: o.normals_length, min: 0.0001, max: 100, set: (x) => set('normals_length')(x) }),
    ], { sub: true }),
    editOverlayHooks.map((f) => f(v)),
  ];
}

function shadingPopover(v: View3D): Child {
  const s = v.shading;
  const set = (k: keyof typeof s) => (x: unknown) => {
    (s as unknown as Record<string, unknown>)[k] = x;
    renderContext?.forceSync();
    app.changed('ui');
  };
  const items = (pairs: string[][]) => pairs.map(([value, label]) => ({ value, label }));
  if (s.type === 'MATERIAL' || s.type === 'RENDERED') {
    const lightsKey = s.type === 'RENDERED' ? 'use_scene_lights_render' : 'use_scene_lights';
    const worldKey = s.type === 'RENDERED' ? 'use_scene_world_render' : 'use_scene_world';
    return h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'pop-title' }, 'Lighting'),
      checkbox('s-lights', 'Scene Lights', s[lightsKey], set(lightsKey)),
      checkbox('s-world', 'Scene World', s[worldKey], set(worldKey)),
      !s[worldKey] ? hdriChooser(v) : null,
      !s[worldKey]
        ? h(
            'div',
            { class: 'col pop-col' },
            numberField({ id: 's-rot', label: 'Rotation', value: s.studiolight_rotate_z ?? 0, min: -Math.PI, max: Math.PI, unit: 'angle', slider: true, set: (x) => set('studiolight_rotate_z')(x) }),
            numberField({ id: 's-strength', label: 'Strength', value: s.studiolight_intensity, min: 0, max: 2, slider: true, set: (x) => set('studiolight_intensity')(x) }),
            numberField({ id: 's-wop', label: 'World Opacity', value: s.studiolight_background_alpha ?? 0, min: 0, max: 1, slider: true, set: (x) => set('studiolight_background_alpha')(x) }),
            numberField({ id: 's-blur', label: 'Blur', value: s.studiolight_background_blur ?? 0.5, min: 0, max: 1, slider: true, set: (x) => set('studiolight_background_blur')(x) }),
          )
        : null,
      h('div', { class: 'pop-title' }, 'Render Pass'),
      h('div', { class: 'pop-line' }, 'Combined'),
    );
  }
  return h(
    'div',
    { class: 'pop-panel' },
    h('div', { class: 'pop-title' }, 'Viewport Shading'),
    panel('sh-light', 'Lighting', () => [
      enumRow('s-light', items([['STUDIO', 'Studio'], ['MATCAP', 'MatCap'], ['FLAT', 'Flat']]), s.light, set('light')),
      h('div', { class: 'sh-light-row' }, solidLightingChooser(v), s.light === 'MATCAP' ? h('button', { class: { 'icon-btn': true, on: !!s.matcap_flip }, 'data-tip': 'Flip MatCap\nMirror the MatCap left to right', onclick: () => app.run('view3d.toggle_matcap_flip') }, icon('mod_mirror')) : null, s.light !== 'FLAT' ? h('button', { class: 'icon-btn', 'data-tip': 'Preferences\nEdit studio lights and MatCaps', onclick: () => app.run('screen.userpref_show', { section: 'LIGHTS' }) }, icon('preferences')) : null),
      s.light === 'STUDIO'
        ? h(
            'div',
            { class: 'sh-world-row' },
            h('button', { class: { 'icon-btn': true, on: !!s.use_world_space_lighting }, 'data-tip': 'World Space Lighting\nKeep the studio lights fixed to the scene instead of the view', onclick: () => set('use_world_space_lighting')(!s.use_world_space_lighting) }, icon('world')),
            numberField({ id: 's-srot', label: 'Rotation', value: s.studiolight_rotate_z ?? 0, min: -Math.PI, max: Math.PI, unit: 'angle', slider: true, disabled: !s.use_world_space_lighting, set: (x) => set('studiolight_rotate_z')(x) }),
          )
        : null,
    ], { sub: true }),
    panel('sh-color', 'Color', () => [
      h('div', { class: 'pop-label' }, 'Wireframe'),
      enumRow('s-wcolor', items([['THEME', 'Theme'], ['OBJECT', 'Object'], ['RANDOM', 'Random']]), s.wireframe_color_type, set('wireframe_color_type')),
      h('div', { class: 'pop-label' }, 'Object'),
      h('div', { class: 'enum-grid' }, enumRow('s-color', items([['MATERIAL', 'Material'], ['OBJECT', 'Object'], ['RANDOM', 'Random'], ['VERTEX', 'Attribute'], ['TEXTURE', 'Texture'], ['SINGLE', 'Custom']]), s.color_type, set('color_type'))),
      s.color_type === 'SINGLE' ? colorSwatch('s-single', s.single_color, (c) => set('single_color')(c.slice(0, 3))) : null,
      h('div', { class: 'pop-label' }, 'Background'),
      enumRow('s-bg', items([['THEME', 'Theme'], ['WORLD', 'World'], ['VIEWPORT', 'Custom']]), s.background_type, set('background_type')),
      s.background_type === 'VIEWPORT' ? colorSwatch('s-bgc', s.background_color, (c) => set('background_color')(c.slice(0, 3))) : null,
    ], { sub: true }),
    panel('sh-opt', 'Options', () => [
      checkbox('s-cull', 'Backface Culling', s.show_backface_culling, set('show_backface_culling')),
      h('div', { class: 'row-split' }, checkbox('s-outline', 'Outline', s.show_object_outline, set('show_object_outline')), colorSwatch('s-outc', s.object_outline_color ?? [0, 0, 0], (c) => set('object_outline_color')(c.slice(0, 3)))),
      checkbox('s-spec', 'Specular Lighting', s.show_specular_highlight, set('show_specular_highlight')),
      h('div', { class: 'row-split' }, checkbox('s-xray', 'X-Ray', s.show_xray, set('show_xray')), numberField({ id: 's-xa', value: s.xray_alpha, min: 0, max: 1, slider: true, set: (x) => set('xray_alpha')(x) })),
      h('div', { class: 'row-split' }, checkbox('s-shadow', 'Shadow', s.show_shadows, set('show_shadows'), { tip: 'Shadow\nObjects cast shadows from a fixed light direction' }), numberField({ id: 's-shadow-i', value: s.shadow_intensity ?? 0.5, min: 0, max: 1, slider: true, disabled: !s.show_shadows, tip: 'Shadow\nDarkness of the shadows', set: (x) => set('shadow_intensity')(x) })),
      s.show_shadows
        ? h(
            'div',
            { class: 'ov-scale-row sh-dir-row' },
            ...([0, 1, 2] as const).map((i) =>
              numberField({ id: `s-ldir-${i}`, label: 'XYZ'[i], value: (s.light_direction ?? [0.5774, -0.5774, 0.5774])[i], min: -1, max: 1, slider: true, tip: 'Light Direction\nDirection the shadow light comes from', set: (x) => {
                const d = [...(s.light_direction ?? [0.5774, -0.5774, 0.5774])] as [number, number, number];
                d[i] = x;
                set('light_direction')(d);
              } }),
            ),
          )
        : null,
      checkbox('s-cavity', 'Cavity', s.show_cavity, set('show_cavity'), { tip: 'Cavity\nLighten convex edges and darken creases' }),
      s.show_cavity
        ? h(
            'div',
            { class: 'ov-scale-row' },
            numberField({ id: 's-ridge', label: 'Ridge', value: s.cavity_ridge_factor ?? 1, min: 0, max: 2.5, slider: true, set: (x) => set('cavity_ridge_factor')(x) }),
            numberField({ id: 's-valley', label: 'Valley', value: s.cavity_valley_factor ?? 1, min: 0, max: 2.5, slider: true, set: (x) => set('cavity_valley_factor')(x) }),
          )
        : null,
    ], { sub: true }),
  );
}
