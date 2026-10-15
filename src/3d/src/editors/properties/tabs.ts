// Properties tabs: scene, world, collection, object, data, material.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { registerTab } from './properties';
import { panel, enumMenu, button, opButton, textField, enumRow, checkbox, numberField } from '../../ui/widgets';
import { num, bool, enumProp, colorProp, vecProp, splitRow, textProp, boolHeading, oid, objectProp } from '../../ui/props';
import type { ObjectData, MaterialData, MeshData, WorldData, LightData, CameraData, CurveData } from '../../data/types';
import { newMaterial, uid, newWorld } from '../../data/defaults';
import { uniqueName } from '../../ops/object';
import { cloneShared } from '../../data/cow';
import { openMenu, type MenuItem } from '../../ui/menu';
import { materialSlots } from '../view3d/draw';
import { uiList } from './uilist';
import { cameraPanels } from '../../render/final/props/camera';
import { materialSpecials, shapeKeySpecials, vertexGroupSpecials } from '../../object/listmenus';
import { propertiesCollection } from '../../object/relations';
import { objectCollectionsPanel } from '../../object/collections';

/** Small lock toggle used inside list rows. */
function lockToggle(on: boolean, tip: string, toggle: () => void): Child {
  return h('button', { class: { 'ul-lock': true, on }, 'data-tip': tip, onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => (e.stopPropagation(), toggle()) }, icon(on ? 'locked' : 'unlocked'));
}

const ob = () => app.activeObject;

/** Extra Object-tab panels contributed by other modules (shown after Instancing, e.g. Motion Paths). */
export const objectExtraPanels: ((o: ObjectData) => Child)[] = [];
/** Keying Sets panel of the Scene tab (drawn by the animation module). */
export const sceneKeyingPanel: { draw: (() => Child) | null } = { draw: null };
const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

// ---------------------------------------------------------------------------
// Tool

registerTab({
  id: 'TOOL',
  label: 'Tool',
  icon: 'tool',
  group: 0,
  poll: () => true,
  draw: () => {
    const ts = app.doc.scene.tool_settings;
    return [
      panel('tool-active', 'Active Tool', () => h('div', { class: 'prop-note' }, 'Tool settings are shown in the 3D Viewport tool header and sidebar.')),
      panel('tool-options', 'Options', () => [
        bool(ts, 'use_transform_data_origin', 'Affect Only Origins'),
        bool(ts, 'use_transform_skip_children', 'Affect Only Parents'),
        bool(ts, 'use_keyframe_insert_auto', 'Auto Keying'),
        enumProp(ts, 'keyframe_type', 'Keyframe Type', [['KEYFRAME', 'Keyframe'], ['BREAKDOWN', 'Breakdown'], ['MOVING_HOLD', 'Moving Hold'], ['EXTREME', 'Extreme'], ['JITTER', 'Jitter']]),
      ]),
    ];
  },
});

// Render, Output and View Layer tabs live in src/render/final/props/.

// ---------------------------------------------------------------------------
// Scene

registerTab({
  id: 'SCENE',
  label: 'Scene',
  icon: 'scene_data',
  group: 2,
  poll: () => true,
  draw: () => {
    const s = app.doc.scene;
    const worlds = Object.values(app.doc.worlds);
    return [
      panel('sc-scene', 'Scene', () => [
        objectProp(s, 'camera', 'Camera', { filter: (c) => c.type === 'CAMERA', undo: 'Scene Camera' }),
        splitRow('World', enumMenu('sc-world', [{ value: '', label: '—' }, ...worlds.map((w) => ({ value: w.id, label: w.name, icon: 'world' }))], s.world ?? '', (v) => ((s.world = v || null), changed('Scene World')))),
      ]),
      panel('sc-units', 'Units', () => [
        enumProp(s.unit_settings, 'system', 'Unit System', [['NONE', 'None'], ['METRIC', 'Metric'], ['IMPERIAL', 'Imperial']]),
        num(s.unit_settings, 'scale_length', 'Unit Scale', { min: 1e-5, max: 1e5 }),
        enumProp(s.unit_settings, 'system_rotation', 'Rotation', [['DEGREES', 'Degrees'], ['RADIANS', 'Radians']]),
        enumProp(s.unit_settings, 'length_unit', 'Length', [['ADAPTIVE', 'Adaptive'], ['KILOMETERS', 'Kilometers'], ['METERS', 'Meters'], ['CENTIMETERS', 'Centimeters'], ['MILLIMETERS', 'Millimeters'], ['MICROMETERS', 'Micrometers']]),
      ]),
      panel('sc-gravity', 'Gravity', () => [vecProp(s, 'gravity', 'Gravity', { unit: 'none' })], { header: checkbox('sc-grav-on', '', s.use_gravity, (v) => ((s.use_gravity = v), changed('Gravity'))) }),
      panel('sc-rb', 'Rigid Body World', () =>
        s.rigidbody_world
          ? [
              num(s.rigidbody_world, 'time_scale', 'Speed', { min: 0, max: 100 }),
              num(s.rigidbody_world, 'substeps_per_frame', 'Substeps Per Frame', { int: true, min: 1, max: 100 }),
              num(s.rigidbody_world, 'solver_iterations', 'Solver Iterations', { int: true, min: 1, max: 1000 }),
              num(s.rigidbody_world, 'frame_start', 'Simulation Start', { int: true }),
              num(s.rigidbody_world, 'frame_end', 'End', { int: true }),
              opButton('rigidbody.world_remove', 'Remove Rigid Body World'),
            ]
          : opButton('rigidbody.world_add', 'Add Rigid Body World'),
      ),
      sceneKeyingPanel.draw
        ? sceneKeyingPanel.draw()
        : panel('sc-keying', 'Keying Sets', () => [
            enumProp(s as never, 'keying_set' as never, 'Active Keying Set', [['LocRotScale', 'Location, Rotation & Scale'], ['Location', 'Location'], ['Rotation', 'Rotation'], ['Scale', 'Scale'], ['Available', 'Available'], ['WholeCharacter', 'Whole Character']]),
          ], { closed: true }),
    ];
  },
});

// ---------------------------------------------------------------------------
// World

function worldBackground(w: WorldData) {
  return w.tree.nodes.find((n) => n.type === 'ShaderNodeBackground');
}

registerTab({
  id: 'WORLD',
  label: 'World',
  icon: 'world',
  group: 2,
  poll: () => true,
  draw: () => {
    const s = app.doc.scene;
    const w = s.world ? app.doc.worlds[s.world] : undefined;
    const selector = dataBlockSelector(
      'world',
      'world',
      Object.values(app.doc.worlds),
      w?.id ?? null,
      (id) => ((s.world = id), changed('Assign World')),
      () => {
        const nw = newWorld(uniqueName(app.doc, 'World', 'actions' as never));
        app.doc.worlds[nw.id] = nw;
        s.world = nw.id;
        changed('New World');
      },
    );
    if (!w) return [selector];
    const bg = worldBackground(w);
    const linked = bg ? w.tree.links.find((l) => l.to_node === bg.id && l.to_socket === 'Color') : undefined;
    const src = linked ? w.tree.nodes.find((n) => n.id === linked.from_node) : undefined;
    return [
      selector,
      panel('wo-surface', 'Surface', () =>
        worldSurfacePanel.draw
          ? worldSurfacePanel.draw(w)
          : bg
          ? [
              splitRow('Surface', h('span', { class: 'node-link-label' }, icon('node_material'), 'Background')),
              src
                ? splitRow('Color', h('span', { class: 'node-link-label' }, icon('texture'), src.name), null)
                : colorProp(bg.inputs as Record<string, unknown>, 'Color' as never, 'Color'),
              src?.type === 'ShaderNodeTexEnvironment' ? imageSlot(src.props as Record<string, unknown>, 'image', 'Image') : null,
              src?.type === 'ShaderNodeTexSky' ? num(src.props as Record<string, unknown>, 'sun_elevation' as never, 'Sun Elevation', { unit: 'angle' }) : null,
              num(bg.inputs as Record<string, unknown>, 'Strength' as never, 'Strength', { min: 0, softMax: 10 }),
              h(
                'div',
                { class: 'btn-row' },
                button('wo-sky', 'Use Sky Texture', () => setWorldSource(w, 'ShaderNodeTexSky')),
                button('wo-env', 'Use Environment Texture', () => setWorldSource(w, 'ShaderNodeTexEnvironment')),
                src ? button('wo-plain', 'Use Color', () => setWorldSource(w, null)) : null,
              ),
            ]
          : h('div', { class: 'prop-note' }, 'The world node tree has no Background node. Edit it in the Shader Editor (World).'),
      ),
      panel('wo-mist', 'Mist Pass', () => [num(w as never, 'mist_start' as never, 'Start', { unit: 'distance' }), num(w as never, 'mist_depth' as never, 'Depth', { unit: 'distance' }), enumProp(w as never, 'mist_falloff' as never, 'Falloff', [['QUADRATIC', 'Quadratic'], ['LINEAR', 'Linear'], ['INVERSE_QUADRATIC', 'Inverse Quadratic']])], { closed: true }),
      panel('wo-display', 'Viewport Display', () => [colorProp(w, 'color', 'Color')], { closed: true }),
    ];
  },
});

function setWorldSource(w: WorldData, type: string | null) {
  const bg = worldBackground(w);
  if (!bg) return;
  w.tree.links = w.tree.links.filter((l) => !(l.to_node === bg.id && l.to_socket === 'Color'));
  if (type) {
    const n = { id: uid('node'), type, name: type === 'ShaderNodeTexSky' ? 'Sky Texture' : 'Environment Texture', location: [bg.location[0] - 260, bg.location[1]] as [number, number], inputs: {}, props: (type === 'ShaderNodeTexSky' ? { sky_type: 'NISHITA', sun_elevation: 0.26, sun_rotation: 0 } : { image: null }) as Record<string, string | number | null> };
    w.tree.nodes.push(n);
    w.tree.links.push({ id: uid('link'), from_node: n.id, from_socket: 'Color', to_node: bg.id, to_socket: 'Color' });
  }
  changed('World Surface');
}

export function imageSlot(owner: Record<string, unknown>, key: string, label: string) {
  const images = Object.values(app.doc.images);
  return splitRow(
    label,
    h(
      'div',
      { class: 'row-aligned' },
      enumMenu(`img-${oid(owner)}`, [{ value: '', label: '—' }, ...images.map((i) => ({ value: i.id, label: i.name, icon: 'image' }))], String(owner[key] ?? ''), (v) => ((owner[key] = v || null), changed('Assign Image'))),
      button(`img-open-${oid(owner)}`, icon('file_folder'), () => app.run('image.open', { target_owner: true }, { invoke: true }) && void 0, { tip: 'Open Image' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Collection

registerTab({
  id: 'COLLECTION',
  label: 'Collection',
  icon: 'collection',
  group: 2,
  poll: () => {
    const id = (window as unknown as { __activeCollection?: string }).__activeCollection;
    void id;
    return Object.keys(app.doc.collections).length > 1;
  },
  draw: () => {
    const doc = app.doc;
    const c = propertiesCollection();
    if (!c) return h('div', { class: 'prop-note' }, 'No collection');
    return [
      h('div', { class: 'id-row' }, icon('collection'), textField('col-name', c.name, (v) => ((c.name = uniqueName(doc, v, 'collections')), changed('Rename Collection')))),
      panel('col-restrict', 'Restrictions', () => [boolHeading(c, 'hide_select', 'Selectable', '', {}), bool(c, 'hide_render', 'Disable in Renders'), bool(c, 'holdout' as never, 'Holdout'), bool(c, 'indirect_only' as never, 'Indirect Only')]),
      panel(
        'col-instancing',
        'Instancing',
        () => [
          vecProp(c, 'instance_offset', 'Offset', { unit: 'distance' }),
          h('div', { class: 'btn-row btn-stack' }, opButton('object.instance_offset_from_cursor'), opButton('object.instance_offset_from_object'), opButton('object.instance_offset_to_cursor')),
        ],
        { closed: true },
      ),
    ];
  },
});

// ---------------------------------------------------------------------------
// Object

registerTab({
  id: 'OBJECT',
  label: 'Object',
  icon: 'object',
  group: 3,
  poll: () => !!ob(),
  draw: () => {
    const o = ob()!;
    const doc = app.doc;
    const rotPath = o.rotation_mode === 'QUATERNION' ? 'rotation_quaternion' : o.rotation_mode === 'AXIS_ANGLE' ? 'rotation_axis_angle' : 'rotation_euler';
    const parents = Object.values(doc.objects).filter((x) => x.id !== o.id);
    return [
      h('div', { class: 'id-row' }, icon('object'), textField('ob-name', o.name, (v) => ((o.name = uniqueName(doc, v)), changed('Rename Object')))),
      panel('ob-transform', 'Transform', () => [
        vecProp(o, 'location', 'Location', { unit: 'distance', anim: { ob: o, path: 'location' }, lock: { owner: o, key: 'lock_location' } }),
        o.rotation_mode === 'QUATERNION'
          ? vecProp(o, 'rotation_quaternion', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob: o, path: rotPath }, lock: { owner: o, key: 'lock_rotation', offset: 1 } })
          : o.rotation_mode === 'AXIS_ANGLE'
            ? vecProp(o, 'rotation_axis_angle', 'Rotation', { names: ['W', 'X', 'Y', 'Z'], anim: { ob: o, path: rotPath }, lock: { owner: o, key: 'lock_rotation', offset: 1 } })
            : vecProp(o, 'rotation_euler', 'Rotation', { unit: 'angle', anim: { ob: o, path: rotPath }, lock: { owner: o, key: 'lock_rotation' } }),
        splitRow(
          'Mode',
          enumMenu('ob-rotmode', [['QUATERNION', 'Quaternion (WXYZ)'], ['XYZ', 'XYZ Euler'], ['XZY', 'XZY Euler'], ['YXZ', 'YXZ Euler'], ['YZX', 'YZX Euler'], ['ZXY', 'ZXY Euler'], ['ZYX', 'ZYX Euler'], ['AXIS_ANGLE', 'Axis Angle']].map(([value, label]) => ({ value, label })), o.rotation_mode, (m) => app.run('object.rotation_mode_set', { mode: m })),
        ),
        vecProp(o, 'scale', 'Scale', { anim: { ob: o, path: 'scale' }, lock: { owner: o, key: 'lock_scale' } }),
        panel('ob-delta', 'Delta Transform', () => [vecProp(o, 'delta_location', 'Delta Location', { unit: 'distance' }), vecProp(o, 'delta_rotation_euler', 'Delta Rotation', { unit: 'angle' }), vecProp(o, 'delta_scale', 'Delta Scale')], { sub: true, closed: true }),
      ]),
      panel('ob-relations', 'Relations', () => [
        splitRow('Parent', enumMenu('ob-parent', [{ value: '', label: '—' }, ...parents.map((p) => ({ value: p.id, label: p.name, icon: 'object' }))], o.parent ?? '', (v) => {
          o.parent = v || null;
          if (!v) o.parent_type = 'OBJECT';
          changed('Set Parent');
        })),
        o.parent ? enumProp(o, 'parent_type', 'Parent Type', [['OBJECT', 'Object'], ['BONE', 'Bone'], ['VERTEX', 'Vertex'], ['VERTEX_3', '3 Vertices']]) : null,
        o.parent && o.parent_type === 'BONE' ? textProp(o, 'parent_bone', 'Parent Bone') : null,
        num(o as never, 'pass_index' as never, 'Pass Index', { int: true, min: 0 }),
      ], { closed: true }),
      panel('ob-collections', 'Collections', () => objectCollectionsPanel(o), { closed: true }),
      panel('ob-instancing', 'Instancing', () => [
        enumProp(o, 'instance_type', 'Instancing', [['NONE', 'None'], ['COLLECTION', 'Collection'], ['VERTS', 'Vertices'], ['FACES', 'Faces']]),
        o.instance_type === 'COLLECTION' ? splitRow('Collection', enumMenu('ob-inst-col', Object.values(doc.collections).filter((c) => c.id !== doc.scene.collection).map((c) => ({ value: c.id, label: c.name })), o.instance_collection ?? '', (v) => ((o.instance_collection = v), changed('Instance Collection')))) : null,
        o.instance_type === 'VERTS' ? bool(o as never, 'use_instance_vertices_rotation' as never, 'Align to Vertex Normal') : null,
        o.instance_type === 'FACES' ? [bool(o as never, 'use_instance_faces_scale' as never, 'Scale by Face Size'), o.use_instance_faces_scale && o.instance_faces_scale !== undefined ? num(o as never, 'instance_faces_scale' as never, 'Factor', { min: 0.001, max: 10000 }) : null] : null,
      ], { closed: true }),
      objectExtraPanels.map((p) => p(o)),
      panel('ob-visibility', 'Visibility', () => [
        boolHeading({ get v() { return !o.hide_select; }, set v(x: boolean) { o.hide_select = !x; } } as { v: boolean }, 'v', 'Selectable'),
        h('div', { class: 'sub-label' }, 'Show In'),
        bool({ get v() { return !o.hide_viewport; }, set v(x: boolean) { o.hide_viewport = !x; } } as { v: boolean }, 'v', 'Viewports'),
        bool({ get v() { return !o.hide_render; }, set v(x: boolean) { o.hide_render = !x; } } as { v: boolean }, 'v', 'Renders'),
        h('div', { class: 'sub-label' }, 'Mask'),
        bool(o as never, 'is_shadow_catcher' as never, 'Shadow Catcher'),
        bool(o as never, 'is_holdout' as never, 'Holdout'),
      ], { closed: true }),
      panel('ob-display', 'Viewport Display', () => [
        bool(o, 'show_name', 'Name'),
        bool(o, 'show_axis', 'Axes'),
        o.type === 'MESH' ? bool(o, 'show_wire', 'Wireframe') : null,
        bool(o, 'show_in_front', 'In Front'),
        enumProp(o, 'display_type', 'Display As', [['BOUNDS', 'Bounds'], ['WIRE', 'Wire'], ['SOLID', 'Solid'], ['TEXTURED', 'Textured']]),
        colorProp(o, 'color', 'Color', { alpha: true }),
        o.type === 'EMPTY' ? [enumProp(o, 'empty_display_type', 'Display As', [['PLAIN_AXES', 'Plain Axes'], ['ARROWS', 'Arrows'], ['SINGLE_ARROW', 'Single Arrow'], ['CIRCLE', 'Circle'], ['CUBE', 'Cube'], ['SPHERE', 'Sphere'], ['CONE', 'Cone'], ['IMAGE', 'Image']]), num(o, 'empty_display_size', 'Size', { unit: 'distance', min: 0 })] : null,
      ], { closed: true }),
      panel('ob-custom', 'Custom Properties', () => customProps(o.custom), { closed: true }),
    ];
  },
});

export function customProps(custom: Record<string, unknown>): Child {
  return [
    button('cp-new', [icon('add'), 'New'], () => {
      let i = 0;
      while (`prop${i ? i : ''}` in custom) i++;
      custom[`prop${i ? i : ''}`] = 1.0;
      changed('Add Property');
    }),
    Object.entries(custom).map(([k, v]) =>
      h(
        'div',
        { key: k, class: 'custom-prop' },
        typeof v === 'number'
          ? splitRow(k, numberField({ id: `cp.${k}`, value: v, set: (x, f) => ((custom[k] = x), app.changed('doc'), f && app.pushUndo('Edit Property')) }), h('button', { class: 'icon-btn', onclick: () => (delete custom[k], changed('Remove Property')) }, icon('x')))
          : typeof v === 'boolean'
            ? splitRow(k, checkbox(`cp.${k}`, '', v, (x) => ((custom[k] = x), changed('Edit Property'))), h('button', { class: 'icon-btn', onclick: () => (delete custom[k], changed('Remove Property')) }, icon('x')))
            : splitRow(k, textField(`cp.${k}`, String(v), (x) => ((custom[k] = x), changed('Edit Property'))), h('button', { class: 'icon-btn', onclick: () => (delete custom[k], changed('Remove Property')) }, icon('x'))),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Data-block selector (browse / name / new / unlink)

/** Extra right-click menu entries of data-block selectors (e.g. Mark as Asset), given the shown data-block id. */
export const idSelectorMenuHooks: ((id: string) => MenuItem[])[] = [];

export function dataBlockSelector<T extends { id: string; name: string; use_fake_user?: boolean }>(id: string, iconName: string, items: T[], current: string | null, set: (id: string | null) => void, create: () => void, opts: { duplicate?: () => void; users?: number; noUnlink?: boolean } = {}): Child {
  const cur = items.find((i) => i.id === current);
  return h(
    'div',
    {
      class: 'id-selector',
      oncontextmenu: (e: MouseEvent) => {
        const extra = cur ? idSelectorMenuHooks.flatMap((f) => f(cur.id)) : [];
        if (!extra.length) return;
        e.preventDefault();
        e.stopPropagation();
        openMenu(extra, { x: e.clientX, y: e.clientY });
      },
    },
    h(
      'button',
      {
        class: 'ids-browse',
        'data-tip': 'Browse',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(items.map((i) => ({ label: i.name, icon: iconName, active: i.id === current, action: () => set(i.id) })), e.currentTarget as HTMLElement);
        },
      },
      icon(iconName),
      icon('down_arrow_hlt', 'tiny'),
    ),
    cur
      ? [
          textField(`${id}-name`, cur.name, (v) => ((cur.name = v), changed('Rename'))),
          opts.users && opts.users > 1 ? h('button', { class: 'ids-users', 'data-tip': 'Display number of users of this data (click to make a single-user copy)', onclick: () => opts.duplicate?.() }, String(opts.users)) : null,
          h('button', { class: { 'ids-btn': true, on: !!cur.use_fake_user }, 'data-tip': 'Fake User\nSave this data-block even if it has no users', onclick: () => ((cur.use_fake_user = !cur.use_fake_user), changed('Fake User')) }, icon(cur.use_fake_user ? 'fake_user_on' : 'fake_user_off')),
          opts.duplicate ? h('button', { class: 'ids-btn', 'data-tip': 'New (duplicate)', onclick: () => opts.duplicate!() }, icon('duplicate')) : null,
          opts.noUnlink ? null : h('button', { class: 'ids-btn', 'data-tip': 'Unlink Data-Block', onclick: () => set(null) }, icon('x')),
        ]
      : h('button', { class: 'btn ids-new', onclick: create }, icon('add'), 'New'),
  );
}

// ---------------------------------------------------------------------------
// Object data

function meshData(o: ObjectData, me: MeshData): Child {
  const doc = app.doc;
  const users = Object.values(doc.objects).filter((x) => x.data === me.id).length;
  return [
    dataBlockSelector('me', 'mesh_data', Object.values(doc.meshes), me.id, (id) => id && ((o.data = id), changed('Assign Mesh')), () => {}, {
      noUnlink: true,
      users,
      duplicate: () => {
        const d = cloneShared(me);
        d.id = uid('me');
        d.name = uniqueName(doc, me.name, 'meshes');
        doc.meshes[d.id] = d;
        o.data = d.id;
        changed('Make Single User');
      },
    }),
    panel('me-vgroups', 'Vertex Groups', () => [
      uiList(
        'vg',
        me.vertex_groups.map((g, i) => ({ key: g.name, label: g.name, icon: 'group_vertex', rightSize: 'compact' as const, right: lockToggle(!!g.lock_weight, 'Lock weights', () => ((me.vertex_groups[i] = { ...g, lock_weight: !g.lock_weight }), changed('Lock Vertex Group'))) })),
        o.vertex_group_active_index ?? 0,
        (i) => ((o.vertex_group_active_index = i), app.changed('doc')),
        {
          add: () => app.run('object.vertex_group_add'),
          remove: () => app.run('object.vertex_group_remove'),
          specials: vertexGroupSpecials,
          up: me.vertex_groups.length > 1 ? () => app.run('object.vertex_group_move', { direction: 'UP' }) : undefined,
          down: me.vertex_groups.length > 1 ? () => app.run('object.vertex_group_move', { direction: 'DOWN' }) : undefined,
          rename: (i, name) => {
            me.vertex_groups[i].name = name;
            changed('Rename Vertex Group');
          },
        },
      ),
      app.doc.mode === 'EDIT' && me.vertex_groups.length
        ? h('div', { class: 'btn-row' }, opButton('object.vertex_group_assign', 'Assign'), opButton('object.vertex_group_remove_from', 'Remove'), opButton('object.vertex_group_select', 'Select'), opButton('object.vertex_group_deselect', 'Deselect'))
        : null,
      app.doc.mode === 'EDIT' ? num(doc.scene.tool_settings as never, 'vertex_group_weight' as never, 'Weight', { min: 0, max: 1, slider: true }) : null,
    ]),
    panel('me-shapekeys', 'Shape Keys', () => [
      uiList(
        'sk',
        me.shape_keys.map((k, i) => ({
          key: k.name,
          label: k.name,
          icon: 'shapekey_data',
          rightSize: 'wide' as const,
          right: [
            i > 0 ? numberField({ id: `sk.${me.id}.${i}`, value: k.value, min: k.slider_min, max: k.slider_max, slider: true, set: (v, f) => ((k.value = v), app.changed('doc'), f && app.pushUndo('Shape Key Value')) }) : null,
            i > 0 ? checkbox(`sk-mute.${me.id}.${i}`, '', !k.mute, (v) => ((k.mute = !v), changed('Shape Key Mute'))) : null,
            lockToggle(!!k.lock_shape, 'Lock shape against edits', () => ((me.shape_keys[i] = { ...k, lock_shape: !k.lock_shape }), changed('Lock Shape Key'))),
          ],
        })),
        me.active_shape_key_index,
        (i) => ((me.active_shape_key_index = i), app.changed('doc')),
        {
          add: () => app.run('object.shape_key_add', { from_mix: false }),
          remove: () => app.run('object.shape_key_remove'),
          specials: shapeKeySpecials,
          up: me.shape_keys.length > 2 ? () => app.run('object.shape_key_move', { type: 'UP' }) : undefined,
          down: me.shape_keys.length > 2 ? () => app.run('object.shape_key_move', { type: 'DOWN' }) : undefined,
          rename: (i, name) => {
            me.shape_keys[i].name = name;
            changed('Rename Shape Key');
          },
        },
      ),
      me.shape_keys[me.active_shape_key_index] && me.active_shape_key_index > 0
        ? (() => {
            const k = me.shape_keys[me.active_shape_key_index];
            return [
              num(k, 'value', 'Value', { min: k.slider_min, max: k.slider_max, slider: true, anim: { ob: o, path: `data.shape_keys.key_blocks["${k.name}"].value` } }),
              num(k, 'slider_min', 'Range Min'),
              num(k, 'slider_max', 'Max'),
              splitRow('Vertex Group', enumMenu('sk-vg', [{ value: '', label: '—' }, ...me.vertex_groups.map((g) => ({ value: g.name, label: g.name }))], k.vertex_group ?? '', (v) => ((k.vertex_group = v || undefined), changed('Shape Key Group')))),
              splitRow('Relative To', enumMenu('sk-rel', me.shape_keys.map((x) => ({ value: x.name, label: x.name })), k.relative_key, (v) => ((k.relative_key = v), changed('Relative Key')))),
              bool(k, 'mute', 'Mute'),
            ];
          })()
        : me.shape_keys.length
          ? h('div', { class: 'prop-note' }, 'The Basis key is the rest shape.')
          : null,
      me.shape_keys.length ? [bool(o as never, 'show_only_shape_key' as never, 'Pin Active Shape Key'), bool(me as never, 'use_shape_key_edit_mode' as never, 'Shape Key Edit Mode')] : null,
    ]),
    panel('me-uvmaps', 'UV Maps', () => [uiList('uv', [{ key: me.uv_map_name, label: me.uv_map_name, icon: 'uv' }], 0, () => {}, { rename: (_i, name) => ((me.uv_map_name = name), changed('Rename UV Map')) })]),
    panel('me-colors', 'Color Attributes', () => [
      uiList(
        'ca',
        me.color_attributes.map((c) => ({ key: c.name, label: c.name, icon: 'group_vcol', right: h('span', { class: 'ul-meta' }, c.domain === 'POINT' ? 'Vertex' : 'Face Corner') })),
        me.active_color_index,
        (i) => ((me.active_color_index = i), app.changed('doc')),
        { add: () => app.run('geometry.color_attribute_add'), remove: () => app.run('geometry.color_attribute_remove') },
      ),
    ]),
    panel('me-remesh', 'Remesh', () => [
      splitRow('Voxel Size', numberField({ id: `me-voxel-${me.id}`, value: me.remesh_voxel_size ?? 0.1, min: 0.0001, max: 10, unit: 'distance', precision: 4, set: (x, final) => ((me.remesh_voxel_size = x), app.changed('ui'), final && app.pushUndo('Voxel Size')) })),
      h('div', { class: 'btn-row' }, opButton('object.voxel_remesh', 'Voxel Remesh')),
    ], { closed: true }),
    panel('me-geodata', 'Geometry Data', () => [h('div', { class: 'btn-row' }, opButton('mesh.customdata_mask_clear', 'Clear Sculpt Mask Data'))], { closed: true }),
    panel('me-normals', 'Normals', () => [
      splitRow('Auto Smooth', checkbox('me-autosmooth', '', me.auto_smooth_angle !== undefined, (v) => ((me.auto_smooth_angle = v ? (30 * Math.PI) / 180 : undefined), changed('Auto Smooth')))),
      me.auto_smooth_angle !== undefined ? num(me as never, 'auto_smooth_angle' as never, 'Angle', { unit: 'angle', min: 0, max: Math.PI }) : null,
    ], { closed: true }),
  ];
}

function lightData(o: ObjectData, la: LightData): Child {
  const anim = (path: string) => ({ ob: o, path: `data.${path}` });
  return [
    dataBlockSelector('la', 'light_data', Object.values(app.doc.lights), la.id, (id) => id && ((o.data = id), changed('Assign Light')), () => {}, { noUnlink: true }),
    panel('la-light', 'Light', () => [
      h('div', { class: 'enum-tabs' }, enumRow('la-type', [['POINT', 'Point', 'light_point'], ['SUN', 'Sun', 'light_sun'], ['SPOT', 'Spot', 'light_spot'], ['AREA', 'Area', 'light_area']].map(([v, l, i]) => ({ value: v, label: l, icon: i })), la.type, (v) => ((la.type = v as LightData['type']), la.type === 'SUN' && la.energy > 100 && (la.energy = 1), changed('Light Type')))),
      colorProp(la, 'color', 'Color', { anim: anim('color') }),
      la.type === 'SUN' ? num(la, 'energy', 'Strength', { min: 0, softMax: 10, anim: anim('energy') }) : num(la, 'energy', 'Power', { unit: 'power', min: 0, softMax: 10000, anim: anim('energy') }),
      num(la, 'diffuse_factor', 'Diffuse', { min: 0, max: 1, slider: true }),
      num(la, 'specular_factor', 'Specular', { min: 0, max: 1, slider: true }),
      num(la, 'volume_factor', 'Volume', { min: 0, max: 1, slider: true }),
      la.type === 'SUN' ? num(la, 'angle', 'Angle', { unit: 'angle', min: 0, max: Math.PI }) : la.type !== 'AREA' ? num(la, 'shadow_soft_size', 'Radius', { unit: 'distance', min: 0 }) : null,
      la.type === 'AREA'
        ? [
            enumProp(la, 'shape', 'Shape', [['SQUARE', 'Square'], ['RECTANGLE', 'Rectangle'], ['DISK', 'Disk'], ['ELLIPSE', 'Ellipse']]),
            num(la, 'size', la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE' ? 'Size X' : 'Size', { unit: 'distance', min: 0 }),
            la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE' ? num(la, 'size_y', 'Y', { unit: 'distance', min: 0 }) : null,
          ]
        : null,
    ]),
    la.type === 'SPOT' ? panel('la-spot', 'Beam Shape', () => [num(la, 'spot_size', 'Spot Size', { unit: 'angle', min: (1 * Math.PI) / 180, max: Math.PI }), num(la, 'spot_blend', 'Blend', { min: 0, max: 1, slider: true }), bool(la, 'show_cone', 'Show Cone')]) : null,
    panel('la-shadow', 'Shadow', () => [num(la as never, 'shadow_buffer_bias' as never, 'Bias', { min: 0 })], { header: checkbox('la-shadow-on', '', la.use_shadow, (v) => ((la.use_shadow = v), changed('Light Shadow'))) }),
    panel('la-cutoff', 'Custom Distance', () => [num(la as never, 'cutoff_distance' as never, 'Distance', { unit: 'distance', min: 0 })], { closed: true, header: checkbox('la-cut-on', '', !!la.use_custom_distance, (v) => ((la.use_custom_distance = v), changed('Custom Distance'))) }),
  ];
}

function cameraData(o: ObjectData, ca: CameraData): Child {
  const doc = app.doc;
  return [dataBlockSelector('ca', 'camera_data', Object.values(doc.cameras), ca.id, (id) => id && ((o.data = id), changed('Assign Camera')), () => {}, { noUnlink: true }), cameraPanels(o, ca)];
}

function curveData(o: ObjectData, cu: CurveData): Child {
  const isText = o.type === 'FONT';
  return [
    dataBlockSelector('cu', 'curve_data', Object.values(app.doc.curves), cu.id, (id) => id && ((o.data = id), changed('Assign Curve')), () => {}, { noUnlink: true }),
    isText
      ? fontDataPanels.map((f) => f(o, cu))
      : panel('cu-shape', 'Shape', () => [enumRow('cu-dims', [{ value: '2D', label: '2D' }, { value: '3D', label: '3D' }], cu.dimensions, (v) => ((cu.dimensions = v as '2D'), changed('Dimensions'))), num(cu, 'resolution_u', 'Resolution Preview U', { int: true, min: 1, max: 1024 }), cu.dimensions === '2D' ? enumProp(cu, 'fill_mode', 'Fill Mode', [['NONE', 'None'], ['BACK', 'Back'], ['FRONT', 'Front'], ['BOTH', 'Both']]) : null]),
    panel('cu-geometry', 'Geometry', () => [
      num(cu, 'offset', 'Offset', { min: -10, max: 10 }),
      num(cu, 'extrude', 'Extrude', { unit: 'distance', min: 0 }),
      h('div', { class: 'sub-label' }, 'Bevel'),
      num(cu, 'bevel_depth', 'Depth', { unit: 'distance', min: 0 }),
      num(cu, 'bevel_resolution', 'Resolution', { int: true, min: 0, max: 32 }),
      bool(cu, 'use_fill_caps', 'Fill Caps'),
      ...curveGeometryRows.map((f) => f(o, cu)),
    ]),
    ...curveDataPanels.map((f) => f(o, cu)),
  ];
}

/** Object Data tab contents for object types defined by feature modules (e.g. speakers). */
export const dataTabDrawers: Record<string, (o: ObjectData) => Child> = {};

/** Extra panels at the end of the curve / text Object Data tab (e.g. Active Spline). */
export const curveDataPanels: ((ob: ObjectData, cu: CurveData) => Child)[] = [];

/** Extra rows at the end of the curve Geometry panel (bevel / taper objects). */
export const curveGeometryRows: ((ob: ObjectData, cu: CurveData) => Child)[] = [];

/** Panels of the text (FONT) Object Data tab, before Geometry. */
export const fontDataPanels: ((ob: ObjectData, cu: CurveData) => Child)[] = [];

/** Extra panels of the armature Object Data tab, after Skeleton (e.g. Bone Collections, Selection Sets). */
export const armatureDataPanels: ((ob: ObjectData, arm: import('../../data/types').ArmatureData) => Child)[] = [];

registerTab({
  id: 'DATA',
  label: 'Data',
  icon: 'mesh_data',
  group: 3,
  poll: () => {
    const o = ob();
    return !!o && (o.type !== 'EMPTY' || o.empty_display_type === 'IMAGE');
  },
  draw: () => {
    const o = ob()!;
    const doc = app.doc;
    const extra = dataTabDrawers[o.type];
    if (extra) return extra(o);
    if (o.type === 'MESH' && o.data) return meshData(o, doc.meshes[o.data]);
    if (o.type === 'LIGHT' && o.data) return lightData(o, doc.lights[o.data]);
    if (o.type === 'CAMERA' && o.data) return cameraData(o, doc.cameras[o.data]);
    if ((o.type === 'CURVE' || o.type === 'FONT') && o.data) return curveData(o, doc.curves[o.data]);
    if (o.type === 'ARMATURE' && o.data) {
      const arm = doc.armatures[o.data];
      return [
        dataBlockSelector('ar', 'armature_data', Object.values(doc.armatures), arm.id, (id) => id && ((o.data = id), changed('Assign Armature')), () => {}, { noUnlink: true }),
        panel('ar-skeleton', 'Skeleton', () => [enumRow('ar-pose', [{ value: 'POSE', label: 'Pose Position' }, { value: 'REST', label: 'Rest Position' }], arm.pose_position, (v) => ((arm.pose_position = v as 'POSE'), changed('Pose Position')))]),
        ...armatureDataPanels.map((f) => f(o, arm)),
        panel('ar-display', 'Viewport Display', () => [enumProp(arm, 'display_type', 'Display As', [['OCTAHEDRAL', 'Octahedral'], ['STICK', 'Stick'], ['BBONE', 'B-Bone'], ['ENVELOPE', 'Envelope'], ['WIRE', 'Wire']]), bool(arm, 'show_names', 'Names'), bool(arm, 'show_axes', 'Axes'), bool(arm as never, 'show_in_front' as never, 'In Front')]),
        panel('ar-bones', 'Bones', () => arm.bones.map((b) => h('div', { key: b.name, class: { 'chip-row': true, on: arm.active_bone === b.name }, onclick: () => ((arm.active_bone = b.name), app.changed('doc')) }, icon('bone_data'), b.name))),
      ];
    }
    if (o.type === 'LATTICE' && o.data) {
      const lt = doc.lattices[o.data];
      return [panel('lt', 'Lattice', () => [num(lt, 'points_u', 'Resolution U', { int: true, min: 1, max: 64, onChange: () => app.run('lattice.resize', {}, { invoke: false }) }), num(lt, 'points_v', 'V', { int: true, min: 1, max: 64, onChange: () => app.run('lattice.resize', {}, { invoke: false }) }), num(lt, 'points_w', 'W', { int: true, min: 1, max: 64, onChange: () => app.run('lattice.resize', {}, { invoke: false }) }), enumProp(lt, 'interpolation', 'Interpolation', [['KEY_LINEAR', 'Linear'], ['KEY_BSPLINE', 'B-Spline']])])];
    }
    return h('div', { class: 'prop-note' }, 'No data');
  },
});

// ---------------------------------------------------------------------------
// Material

export function activeMaterial(o: ObjectData | null): MaterialData | null {
  if (!o) return null;
  const slots = materialSlots(app.doc, o);
  const id = slots[o.active_material_index];
  return id ? app.doc.materials[id] ?? null : null;
}

function slotOwner(o: ObjectData): { materials: (string | null)[] } | null {
  const doc = app.doc;
  if (!o.data) return null;
  return (doc.meshes[o.data] ?? doc.curves[o.data] ?? doc.metaballs?.[o.data]) ?? null;
}

registerTab({
  id: 'MATERIAL',
  label: 'Material',
  icon: 'material',
  group: 3,
  poll: () => {
    const o = ob();
    return !!o && (o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT');
  },
  draw: () => {
    const o = ob()!;
    const doc = app.doc;
    const owner = slotOwner(o);
    if (!owner) return null;
    const slots = materialSlots(doc, o);
    const ma = activeMaterial(o);
    const users = ma ? Object.values(doc.objects).filter((x) => x.data && slotOwner(x)?.materials.includes(ma.id)).length : 0;
    return [
      uiList(
        'mat-slots',
        slots.map((s, i) => ({ key: `${i}`, label: s ? doc.materials[s]?.name ?? '' : '', icon: 'material' })),
        o.active_material_index,
        (i) => ((o.active_material_index = i), app.changed('doc')),
        {
          add: () => app.run('object.material_slot_add'),
          remove: () => app.run('object.material_slot_remove'),
          specials: materialSpecials,
          up: slots.length > 1 ? () => app.run('object.material_slot_move', { direction: 'UP' }) : undefined,
          down: slots.length > 1 ? () => app.run('object.material_slot_move', { direction: 'DOWN' }) : undefined,
          extra: app.doc.mode === 'EDIT' ? h('div', { class: 'btn-row' }, opButton('object.material_slot_assign', 'Assign'), opButton('object.material_slot_select', 'Select'), opButton('object.material_slot_deselect', 'Deselect')) : null,
        },
      ),
      dataBlockSelector(
        'ma',
        'material',
        Object.values(doc.materials),
        ma?.id ?? null,
        (id) => {
          if (!owner.materials.length) owner.materials.push(null);
          owner.materials[o.active_material_index] = id;
          changed('Assign Material');
        },
        () => app.run('material.new'),
        {
          users,
          duplicate: () => {
            if (!ma) return;
            const d = cloneShared(ma);
            d.id = uid('ma');
            d.name = uniqueName(doc, ma.name, 'materials');
            doc.materials[d.id] = d;
            owner.materials[o.active_material_index] = d.id;
            changed('Copy Material');
          },
        },
      ),
      ma ? materialPanels(ma) : null,
    ];
  },
});

export const materialSurfacePanel: { draw: ((ma: MaterialData) => Child) | null } = { draw: null };
/** Hook for the World ▸ Surface panel (set by the nodes module). */
export const worldSurfacePanel: { draw: ((w: WorldData) => Child) | null } = { draw: null };

function materialPanels(ma: MaterialData): Child {
  return [
    panel('ma-preview', 'Preview', () => h('div', { class: 'mat-preview', style: { background: `radial-gradient(circle at 35% 35%, #fff8 0, transparent 30%), radial-gradient(circle, ${swatchCss(ma)} 0 60%, transparent 61%)` } }), { closed: true }),
    panel('ma-surface', 'Surface', () => (materialSurfacePanel.draw ? materialSurfacePanel.draw(ma) : h('div', { class: 'prop-note' }, 'Edit the node tree in the Shader Editor.'))),
    panel('ma-settings', 'Settings', () => [
      bool(ma, 'use_backface_culling', 'Backface Culling'),
      enumProp(ma, 'blend_method', 'Blend Mode', [['OPAQUE', 'Opaque'], ['CLIP', 'Alpha Clip'], ['HASHED', 'Alpha Hashed'], ['BLEND', 'Alpha Blend']]),
      ma.blend_method === 'CLIP' ? num(ma, 'alpha_threshold', 'Clip Threshold', { min: 0, max: 1, slider: true }) : null,
      enumProp(ma as never, 'shadow_method' as never, 'Shadow Mode', [['NONE', 'None'], ['OPAQUE', 'Opaque'], ['CLIP', 'Alpha Clip'], ['HASHED', 'Alpha Hashed']]),
      num(ma as never, 'pass_index' as never, 'Pass Index', { int: true, min: 0 }),
    ], { closed: true }),
    panel('ma-display', 'Viewport Display', () => [colorProp(ma, 'diffuse_color', 'Color', { alpha: true }), num(ma, 'metallic', 'Metallic', { min: 0, max: 1, slider: true }), num(ma, 'roughness', 'Roughness', { min: 0, max: 1, slider: true })], { closed: true }),
  ];
}

function swatchCss(ma: MaterialData) {
  const c = ma.diffuse_color.map((x) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export { newMaterial };
