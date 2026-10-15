// 3D viewport header (mode selector, menus, transform settings, shading).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu, openPopover, type MenuItem } from '../../ui/menu';
import { app } from '../../app/app';
import { currentOrientation, customOrientations, setOrientation, BUILTIN_ORIENTATIONS } from '../../ops/orientations';
import { activeView3D, type View3D } from './view3d';
import { viewMenu, selectMenu, addMenu, objectMenu } from './menus';
import { modeMenus } from './modemenus';
import { checkbox, numberField, enumRow, colorSwatch, panel } from '../../ui/widgets';
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

function menuButton(label: string, items: () => MenuItem[]) {
  return h(
    'button',
    {
      key: `menu-${label}`,
      class: 'hdr-menu',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openMenu(items(), e.currentTarget as HTMLElement);
      },
      onpointerenter: (e: PointerEvent) => {
        // menu bar hover switching while a header menu is open
        if (document.querySelector('.hdr-menu.menu-open') && !(e.currentTarget as HTMLElement).classList.contains('menu-open')) openMenu(items(), e.currentTarget as HTMLElement);
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
  ['FACE', 'Face Project', 'snap_face'],
  ['VOLUME', 'Volume', 'snap_volume'],
  ['EDGE_MIDPOINT', 'Edge Center', 'snap_edge'],
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
    icon(iconName),
    icon('down_arrow_hlt', 'tiny'),
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
    menuButton('View', viewMenu),
    !mm?.select || mm.select().length ? menuButton('Select', selectMenu) : null,
    (doc.mode === 'OBJECT' || doc.mode === 'EDIT') && (!mm?.add || mm.add().length) ? menuButton('Add', mm?.add ?? addMenu) : null,
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
          ['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'].map((f) => ({ label: f[0] + f.slice(1).toLowerCase().replace('_', ' '), active: ts.proportional_edit_falloff === f, action: () => setTool('proportional_edit_falloff', f) })),
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
              ['FONT', 'Text', 'outliner_ob_font'],
              ['ARMATURE', 'Armature', 'outliner_ob_armature'],
              ['LATTICE', 'Lattice', 'outliner_ob_lattice'],
              ['EMPTY', 'Empty', 'outliner_ob_empty'],
              ['LIGHT', 'Light', 'outliner_ob_light'],
              ['CAMERA', 'Camera', 'outliner_ob_camera'],
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
            h('div', { class: 'pop-title' }, 'Object Gizmos'),
            checkbox('obg-move', 'Move', v.objectGizmos.translate, (x) => ((v.objectGizmos.translate = x), v.drawSvg(), app.changed('ui'))),
            checkbox('obg-rot', 'Rotate', v.objectGizmos.rotate, (x) => ((v.objectGizmos.rotate = x), v.drawSvg(), app.changed('ui'))),
            checkbox('obg-scale', 'Scale', v.objectGizmos.scale, (x) => ((v.objectGizmos.scale = x), v.drawSvg(), app.changed('ui'))),
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

type SnapExtras = { use_snap_grid_absolute?: boolean; snap_angle_increment_3d?: number; snap_angle_increment_3d_precision?: number };

/** Snapping popover (header snap dropdown, Shift Ctrl Tab). */
export function snappingPopover(): Child {
  const ts = app.doc.scene.tool_settings;
  const tx = ts as typeof ts & SnapExtras;
  const deg = Math.PI / 180;
  return h(
    'div',
    { class: 'pop-panel' },
    h('div', { class: 'pop-title' }, 'Snap Target for Individual Elements'),
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
              app.pushUndo('Snap Element');
              app.changed('ui');
            },
          },
          icon(ic),
          label,
        ),
      ),
    ),
    ts.snap_elements.includes('INCREMENT') ? checkbox('snap-abs', 'Absolute Grid Snap', !!tx.use_snap_grid_absolute, (x) => setTool('use_snap_grid_absolute', x)) : null,
    h('div', { class: 'pop-title' }, 'Snap With'),
    enumRow('snap-target', [['CLOSEST', 'Closest'], ['CENTER', 'Center'], ['MEDIAN', 'Median'], ['ACTIVE', 'Active']].map(([value, label]) => ({ value, label })), ts.snap_target, (x) => setTool('snap_target', x)),
    h('div', { class: 'pop-title' }, 'Rotation Increment'),
    numberField({ id: 'snap-rot', label: 'Angle', value: tx.snap_angle_increment_3d ?? 5 * deg, min: 0.01 * deg, max: Math.PI, unit: 'angle', set: (x) => setTool('snap_angle_increment_3d', x) }),
    numberField({ id: 'snap-rotp', label: 'Precision', value: tx.snap_angle_increment_3d_precision ?? 1 * deg, min: 0.01 * deg, max: Math.PI, unit: 'angle', set: (x) => setTool('snap_angle_increment_3d_precision', x) }),
  );
}

function setTool(key: string, value: unknown) {
  (app.doc.scene.tool_settings as unknown as Record<string, unknown>)[key] = value;
  app.pushUndo('Tool Setting');
  app.changed('ui', 'doc');
}

function overlayPopover(v: View3D): Child {
  const o = v.overlay;
  const set = (k: keyof typeof o) => (x: unknown) => {
    (o as unknown as Record<string, unknown>)[k] = x;
    app.changed('ui');
  };
  const editing = app.doc.mode === 'EDIT';
  return h(
    'div',
    { class: 'pop-panel' },
    h('div', { class: 'pop-title' }, 'Viewport Overlays'),
    h('div', { class: 'pop-sub' }, 'Guides'),
    h('div', { class: 'pop-grid' }, checkbox('o-grid', 'Grid', o.show_floor, set('show_floor')), checkbox('o-x', 'X', o.show_axis_x, set('show_axis_x')), checkbox('o-y', 'Y', o.show_axis_y, set('show_axis_y')), checkbox('o-z', 'Z', o.show_axis_z, set('show_axis_z'))),
    numberField({ id: 'o-gscale', label: 'Scale', value: o.grid_scale, min: 0.001, max: 1000, set: (x) => set('grid_scale')(x) }),
    h('div', { class: 'pop-grid' }, checkbox('o-text', 'Text Info', o.show_text, set('show_text')), checkbox('o-stats', 'Statistics', o.show_stats, set('show_stats')), checkbox('o-cursor', '3D Cursor', o.show_cursor, set('show_cursor')), checkbox('o-ann', 'Annotations', o.show_annotation, set('show_annotation'))),
    h('div', { class: 'pop-sub' }, 'Objects'),
    h('div', { class: 'pop-grid' }, checkbox('o-extras', 'Extras', o.show_extras, set('show_extras')), checkbox('o-rel', 'Relationship Lines', o.show_relationship_lines, set('show_relationship_lines')), checkbox('o-outline', 'Outline Selected', o.show_outline_selected, set('show_outline_selected')), checkbox('o-bones', 'Bones', o.show_bones, set('show_bones')), checkbox('o-orig', 'Origins', o.show_object_origins, set('show_object_origins')), checkbox('o-origall', 'Origins (All)', o.show_object_origins_all, set('show_object_origins_all')), checkbox('o-mpaths', 'Motion Paths', o.show_motion_paths !== false, set('show_motion_paths'))),
    h('div', { class: 'pop-sub' }, 'Geometry'),
    h('div', { class: 'pop-grid' }, checkbox('o-wire', 'Wireframe', o.show_wireframes, set('show_wireframes')), checkbox('o-faceor', 'Face Orientation', o.show_face_orientation, set('show_face_orientation'))),
    numberField({ id: 'o-wireop', label: 'Opacity', value: o.wireframe_opacity, min: 0, max: 1, slider: true, set: (x) => set('wireframe_opacity')(x) }),
    editing
      ? [
          h('div', { class: 'pop-sub' }, 'Mesh Edit Mode'),
          h('div', { class: 'pop-grid' }, checkbox('o-seam', 'Seams', o.show_edge_seams, set('show_edge_seams')), checkbox('o-sharp', 'Sharp', o.show_edge_sharp, set('show_edge_sharp')), checkbox('o-crease', 'Crease', o.show_edge_crease, set('show_edge_crease')), checkbox('o-fcen', 'Center', o.show_face_center, set('show_face_center')), checkbox('o-fnorm', 'Face Normals', o.show_face_normals, set('show_face_normals')), checkbox('o-vnorm', 'Vertex Normals', o.show_vertex_normals, set('show_vertex_normals')), checkbox('o-len', 'Edge Length', o.show_extra_edge_length, set('show_extra_edge_length')), checkbox('o-idx', 'Indices', o.show_extra_indices, set('show_extra_indices'))),
          numberField({ id: 'o-nlen', label: 'Normal Size', value: o.normals_length, min: 0.0001, max: 100, set: (x) => set('normals_length')(x) }),
        ]
      : null,
  );
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
      !s[worldKey] ? numberField({ id: 's-strength', label: 'Strength', value: s.studiolight_intensity, min: 0, max: 2, slider: true, set: (x) => set('studiolight_intensity')(x) }) : null,
      h('div', { class: 'pop-title' }, 'Render Pass'),
      h('div', { class: 'pop-line' }, 'Combined'),
    );
  }
  return h(
    'div',
    { class: 'pop-panel' },
    panel('sh-light', 'Lighting', () => [enumRow('s-light', items([['STUDIO', 'Studio'], ['MATCAP', 'MatCap'], ['FLAT', 'Flat']]), s.light, set('light'))], { sub: true }),
    panel('sh-color', 'Color', () => [
      h('div', { class: 'enum-grid' }, enumRow('s-color', items([['MATERIAL', 'Material'], ['OBJECT', 'Object'], ['VERTEX', 'Attribute'], ['SINGLE', 'Single'], ['RANDOM', 'Random'], ['TEXTURE', 'Texture']]), s.color_type, set('color_type'))),
      s.color_type === 'SINGLE' ? colorSwatch('s-single', s.single_color, (c) => set('single_color')(c.slice(0, 3))) : null,
    ], { sub: true }),
    panel('sh-bg', 'Background', () => [
      enumRow('s-bg', items([['THEME', 'Theme'], ['WORLD', 'World'], ['VIEWPORT', 'Viewport']]), s.background_type, set('background_type')),
      s.background_type === 'VIEWPORT' ? colorSwatch('s-bgc', s.background_color, (c) => set('background_color')(c.slice(0, 3))) : null,
    ], { sub: true }),
    panel('sh-opt', 'Options', () => [
      h('div', { class: 'row-split' }, checkbox('s-xray', 'X-Ray', s.show_xray, set('show_xray')), numberField({ id: 's-xa', value: s.xray_alpha, min: 0, max: 1, slider: true, set: (x) => set('xray_alpha')(x) })),
      checkbox('s-cull', 'Backface Culling', s.show_backface_culling, set('show_backface_culling')),
      checkbox('s-outline', 'Outline', s.show_object_outline, set('show_object_outline')),
      checkbox('s-spec', 'Specular Lighting', s.show_specular_highlight, set('show_specular_highlight')),
    ], { sub: true }),
  );
}
