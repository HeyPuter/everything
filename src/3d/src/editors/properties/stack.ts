// Modifier and constraint stacks in the Properties editor.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators } from '../../app/app';
import { registerTab } from './properties';
import { panel, enumMenu, textField, isPanelOpen, setPanelOpen, button } from '../../ui/widgets';
import { num, bool, enumProp, splitRow, axisToggles, vecProp, objectProp } from '../../ui/props';
import { modifierTypes, newModifier } from '../../eval/modifiers';
import type { ModifierBase, ObjectData } from '../../data/types';
import { uid } from '../../data/defaults';
import { openMenu, type MenuItem } from '../../ui/menu';
import { cloneShared } from '../../data/cow';

type Field = [key: string, label: string, kind: 'num' | 'int' | 'bool' | 'enum' | 'object' | 'vgroup' | 'vec' | 'axes' | 'angle' | 'dist' | 'factor' | 'heading' | 'bone', extra?: unknown];

const E = (...items: string[]): [string, string][] => items.map((i) => [i, i.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())]);

export const modifierFields: Record<string, Field[]> = {
  ARRAY: [
    ['fit_type', 'Fit Type', 'enum', [['FIXED_COUNT', 'Fixed Count'], ['FIT_LENGTH', 'Fit Length']]],
    ['count', 'Count', 'int', { min: 1, max: 1000 }],
    ['fit_length', 'Length', 'dist'],
    ['use_relative_offset', 'Relative Offset', 'bool'],
    ['relative_offset_displace', 'Factor', 'vec'],
    ['use_constant_offset', 'Constant Offset', 'bool'],
    ['constant_offset_displace', 'Distance', 'vec', 'distance'],
    ['use_object_offset', 'Object Offset', 'bool'],
    ['offset_object', 'Object', 'object'],
    ['use_merge_vertices', 'Merge', 'bool'],
    ['merge_threshold', 'Distance', 'dist'],
    ['offset_u', 'Offset U', 'num'],
    ['offset_v', 'V', 'num'],
  ],
  BUILD: [['frame_start', 'Start', 'num'], ['frame_duration', 'Length', 'num'], ['use_reverse', 'Reversed', 'bool'], ['use_random_order', 'Randomize', 'bool'], ['seed', 'Seed', 'int']],
  EDGE_SPLIT: [['use_edge_angle', 'Edge Angle', 'bool'], ['split_angle', 'Angle', 'angle'], ['use_edge_sharp', 'Sharp Edges', 'bool']],
  MASK: [['mode', 'Mode', 'enum', [['VERTEX_GROUP', 'Vertex Group'], ['ARMATURE', 'Armature']]], ['armature', 'Armature', 'object', 'ARMATURE'], ['vertex_group', 'Vertex Group', 'vgroup'], ['threshold', 'Threshold', 'factor'], ['use_smooth', 'Smooth', 'bool']],
  MIRROR: [
    ['use_axis', 'Axis', 'axes'],
    ['use_bisect_axis', 'Bisect', 'axes'],
    ['use_bisect_flip_axis', 'Flip', 'axes'],
    ['mirror_object', 'Mirror Object', 'object'],
    ['use_clip', 'Clipping', 'bool'],
    ['use_mirror_merge', 'Merge', 'bool'],
    ['merge_threshold', 'Distance', 'dist'],
    ['bisect_threshold', 'Bisect Distance', 'dist'],
    ['heading', 'Data', 'heading'],
    ['use_mirror_u', 'Mirror U', 'bool'],
    ['mirror_offset_u', 'Flip U Offset', 'num', { min: -1, max: 1, slider: true }],
    ['use_mirror_v', 'Mirror V', 'bool'],
    ['mirror_offset_v', 'Flip V Offset', 'num', { min: -1, max: 1, slider: true }],
    ['offset_u', 'Offset U', 'num', { softMin: -1, softMax: 1, slider: true }],
    ['offset_v', 'V', 'num', { softMin: -1, softMax: 1, slider: true }],
    ['use_mirror_vertex_groups', 'Vertex Groups', 'bool'],
  ],
  SCREW: [
    ['angle', 'Angle', 'angle'],
    ['screw_offset', 'Screw', 'dist'],
    ['iterations', 'Iterations', 'int', { min: 1, max: 10000 }],
    ['axis', 'Axis', 'enum', E('X', 'Y', 'Z')],
    ['object', 'Axis Object', 'object'],
    ['use_object_screw_offset', 'Object Screw', 'bool'],
    ['steps', 'Steps Viewport', 'int', { min: 1, max: 10000 }],
    ['render_steps', 'Render', 'int', { min: 1, max: 10000 }],
    ['use_merge_vertices', 'Merge', 'bool'],
    ['merge_threshold', 'Distance', 'dist'],
    ['heading', 'Normals', 'heading'],
    ['use_smooth_shade', 'Smooth Shading', 'bool'],
    ['use_normal_calculate', 'Calculate Order', 'bool'],
    ['use_normal_flip', 'Flip', 'bool'],
    ['heading', 'Texture Coordinates', 'heading'],
    ['use_stretch_u', 'Stretch U', 'bool'],
    ['use_stretch_v', 'Stretch V', 'bool'],
  ],
  SOLIDIFY: [['thickness', 'Thickness', 'dist'], ['offset', 'Offset', 'num', { min: -1, max: 1, slider: true }], ['use_even_offset', 'Even Thickness', 'bool'], ['use_rim', 'Fill Rim', 'bool'], ['use_rim_only', 'Only Rim', 'bool'], ['vertex_group', 'Vertex Group', 'vgroup'], ['material_offset', 'Material Offset', 'int'], ['material_offset_rim', 'Rim', 'int']],
  SUBSURF: [['subdivision_type', 'Type', 'enum', [['CATMULL_CLARK', 'Catmull-Clark'], ['SIMPLE', 'Simple']]], ['levels', 'Levels Viewport', 'int', { min: 0, max: 6 }], ['render_levels', 'Render', 'int', { min: 0, max: 6 }], ['use_creases', 'Use Creases', 'bool']],
  TRIANGULATE: [['quad_method', 'Quad Method', 'enum', [['BEAUTY', 'Beauty'], ['FIXED', 'Fixed'], ['FIXED_ALTERNATE', 'Fixed Alternate'], ['SHORTEST_DIAGONAL', 'Shortest Diagonal'], ['LONGEST_DIAGONAL', 'Longest Diagonal']]], ['ngon_method', 'N-gon Method', 'enum', [['BEAUTY', 'Beauty'], ['CLIP', 'Clip']]], ['min_vertices', 'Minimum Vertices', 'int', { min: 4, max: 1000 }], ['keep_custom_normals', 'Keep Normals', 'bool']],
  WELD: [['mode', 'Mode', 'enum', [['ALL', 'All'], ['CONNECTED', 'Connected']]], ['merge_threshold', 'Distance', 'dist'], ['loose_edges', 'Only Loose Edges', 'bool'], ['vertex_group', 'Vertex Group', 'vgroup']],
  WIREFRAME: [['thickness', 'Thickness', 'dist']],
  ARMATURE: [['object', 'Object', 'object', 'ARMATURE'], ['vertex_group', 'Vertex Group', 'vgroup'], ['use_deform_preserve_volume', 'Preserve Volume', 'bool'], ['heading', 'Bind To', 'heading'], ['use_vertex_groups', 'Vertex Groups', 'bool'], ['use_bone_envelopes', 'Bone Envelopes', 'bool']],
  CAST: [['cast_type', 'Shape', 'enum', [['SPHERE', 'Sphere'], ['CYLINDER', 'Cylinder'], ['CUBOID', 'Cuboid']]], ['use_x', 'X', 'bool'], ['use_y', 'Y', 'bool'], ['use_z', 'Z', 'bool'], ['factor', 'Factor', 'num'], ['radius', 'Radius', 'dist'], ['vertex_group', 'Vertex Group', 'vgroup']],
  CURVE: [['object', 'Curve Object', 'object', 'CURVE'], ['deform_axis', 'Deformation Axis', 'enum', [['POS_X', 'X'], ['POS_Y', 'Y'], ['POS_Z', 'Z'], ['NEG_X', '-X'], ['NEG_Y', '-Y'], ['NEG_Z', '-Z']]], ['vertex_group', 'Vertex Group', 'vgroup']],
  DISPLACE: [['direction', 'Direction', 'enum', [['X', 'X'], ['Y', 'Y'], ['Z', 'Z'], ['NORMAL', 'Normal']]], ['texture_coords', 'Coordinates', 'enum', [['LOCAL', 'Local'], ['GLOBAL', 'Global']]], ['strength', 'Strength', 'num'], ['mid_level', 'Midlevel', 'factor'], ['vertex_group', 'Vertex Group', 'vgroup']],
  HOOK: [
    ['object', 'Object', 'object'],
    ['subtarget', 'Bone', 'bone'],
    ['strength', 'Strength', 'factor'],
    ['vertex_group', 'Vertex Group', 'vgroup'],
    ['heading', 'Falloff', 'heading'],
    ['falloff_type', 'Type', 'enum', [['NONE', 'No Falloff'], ['CONSTANT', 'Constant'], ['LINEAR', 'Linear'], ['SHARP', 'Sharp'], ['INVERSE_SQUARE', 'Inverse Square'], ['SMOOTH', 'Smooth'], ['ROOT', 'Root'], ['SPHERE', 'Sphere']]],
    ['falloff_radius', 'Radius', 'dist'],
    ['use_falloff_uniform', 'Uniform Falloff', 'bool'],
  ],
  LAPLACIANSMOOTH: [['iterations', 'Repeat', 'int', { min: 0, max: 200 }], ['lambda_factor', 'Lambda Factor', 'num'], ['use_volume_preserve', 'Preserve Volume', 'bool'], ['vertex_group', 'Vertex Group', 'vgroup']],
  LATTICE: [['object', 'Object', 'object', 'LATTICE'], ['strength', 'Strength', 'factor'], ['vertex_group', 'Vertex Group', 'vgroup']],
  SHRINKWRAP: [['target', 'Target', 'object', 'MESH'], ['offset', 'Offset', 'dist'], ['vertex_group', 'Vertex Group', 'vgroup']],
  SIMPLE_DEFORM: [['deform_method', 'Method', 'enum', [['TWIST', 'Twist'], ['BEND', 'Bend'], ['TAPER', 'Taper'], ['STRETCH', 'Stretch']]], ['angle', 'Angle', 'angle'], ['factor', 'Factor', 'num'], ['origin', 'Origin', 'object'], ['deform_axis', 'Axis', 'enum', E('X', 'Y', 'Z')], ['vertex_group', 'Vertex Group', 'vgroup']],
  SMOOTH: [['use_x', 'X', 'bool'], ['use_y', 'Y', 'bool'], ['use_z', 'Z', 'bool'], ['factor', 'Factor', 'num'], ['iterations', 'Repeat', 'int', { min: 0, max: 200 }], ['vertex_group', 'Vertex Group', 'vgroup']],
  WARP: [['object_from', 'Object From', 'object'], ['object_to', 'To', 'object'], ['strength', 'Strength', 'num'], ['falloff_radius', 'Radius', 'dist'], ['vertex_group', 'Vertex Group', 'vgroup']],
  WAVE: [['use_x', 'Motion X', 'bool'], ['use_y', 'Y', 'bool'], ['use_normal', 'Along Normals', 'bool'], ['height', 'Height', 'dist'], ['width', 'Width', 'dist'], ['narrowness', 'Narrowness', 'num'], ['speed', 'Speed', 'num'], ['time_offset', 'Offset', 'num'], ['vertex_group', 'Vertex Group', 'vgroup']],
  SMOOTH_BY_ANGLE: [['angle', 'Angle', 'angle']],
};

function fieldWidget(ob: ObjectData, m: Record<string, unknown>, f: Field): Child {
  const [key, label, kind, extra] = f;
  const doc = app.doc;
  switch (kind) {
    case 'heading':
      return h('div', { class: 'sub-label' }, label);
    case 'num':
      return num(m, key, label, (extra as object) ?? {});
    case 'int':
      return num(m, key, label, { int: true, ...((extra as object) ?? {}) });
    case 'dist':
      return num(m, key, label, { unit: 'distance', min: 0 });
    case 'angle':
      return num(m, key, label, { unit: 'angle' });
    case 'factor':
      return num(m, key, label, { min: 0, max: 1, slider: true });
    case 'bool':
      return bool(m, key, label);
    case 'enum':
      return enumProp(m, key, label, extra as [string, string][]);
    case 'axes':
      return axisToggles(m, key, label);
    case 'vec':
      return vecProp(m, key, label, { unit: extra === 'distance' ? 'distance' : 'none' });
    case 'object':
      return objectProp(m, key, label, { filter: (o) => o.id !== ob.id && (!extra || o.type === extra), undo: `Set ${label}` });
    case 'vgroup': {
      const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : undefined;
      const menu = enumMenu(`${m.id ?? ''}.${key}`, [{ value: '', label: '—' }, ...(me?.vertex_groups ?? []).map((g) => ({ value: g.name, label: g.name, icon: 'group_vertex' }))], String(m[key] ?? ''), (v) => {
        m[key] = v;
        app.pushUndo(`Set ${label}`);
        app.changed('doc');
      });
      // modifiers with an invert option show its toggle next to the group
      const invKey = key === 'vertex_group' ? 'invert_vertex_group' : '';
      const type = modifierTypes[String(m.type ?? '')];
      const hasInvert = !!invKey && (invKey in m || (type ? invKey in type.defaults() : false));
      if (!hasInvert) return splitRow(label, menu);
      return splitRow(
        label,
        h(
          'div',
          { class: 'row-aligned' },
          menu,
          h('button', { class: { tbtn: true, 'mod-inv': true, on: !!m[invKey] }, 'data-tip': 'Invert', onclick: () => ((m[invKey] = !m[invKey]), app.pushUndo('Invert Vertex Group'), app.changed('doc')) }, icon('arrow_leftright')),
        ),
      );
    }
    case 'bone': {
      const tid = (m.target ?? m.object) as string | null | undefined;
      const target = tid ? doc.objects[tid] : undefined;
      const arm = target?.type === 'ARMATURE' && target.data ? doc.armatures[target.data] : undefined;
      if (!arm) return null;
      return splitRow(label, enumMenu(`${m.id ?? ''}.${key}`, [{ value: '', label: '—' }, ...arm.bones.map((b) => ({ value: b.name, label: b.name, icon: 'bone_data' }))], String(m[key] ?? ''), (v) => ((m[key] = v), app.pushUndo('Set Bone'), app.changed('doc'))));
    }
  }
  return null;
}

/** Extra UI for modifiers registered by other modules (e.g. geometry nodes, physics). */
export const modifierExtraUI: Record<string, (ob: ObjectData, m: ModifierBase) => Child> = {};

function modifierPanel(ob: ObjectData, m: ModifierBase, i: number): Child {
  const t = modifierTypes[m.type];
  const id = `mod-${m.id}`;
  const open = isPanelOpen(id, m.show_expanded);
  const error = app.graph.get(ob.id)?.error?.startsWith(`${m.name}:`) ? app.graph.get(ob.id)!.error : null;
  const toggle = (k: 'show_in_editmode' | 'show_viewport' | 'show_render', ic: string, tip: string) =>
    h('button', { class: { 'mod-toggle': true, on: !!m[k] }, 'data-tip': tip, onclick: (e: MouseEvent) => (e.stopPropagation(), (m[k] = !m[k]), app.pushUndo(tip), app.changed('doc')) }, icon(ic));
  return h(
    'section',
    { key: m.id, class: { panel: true, modifier: true, open, disabled: !m.show_viewport, active: !!m.is_active }, 'data-mod': m.id },
    h(
      'header',
      {
        class: 'panel-header mod-header',
        onpointerdown: (e: PointerEvent) => {
          // clicking a modifier makes it the active one (no undo step, like selection)
          if (!m.is_active) {
            for (const x of ob.modifiers) x.is_active = x === m;
            app.changed('ui', 'doc');
          }
          if ((e.target as HTMLElement).closest('button, input, label')) return;
          setPanelOpen(id, !open);
          m.show_expanded = !open;
          app.changed('ui');
        },
      },
      h('span', { class: 'ph-arrow' }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      icon(t?.icon ?? 'modifier'),
      textField(`mod-name-${m.id}`, m.name, (v) => ((m.name = v), app.pushUndo('Rename Modifier'), app.changed('doc')), { className: 'mod-name' }),
      t?.supportsEditMode || t?.deformOnly ? toggle('show_in_editmode', 'editmode_hlt', 'Edit Mode') : null,
      toggle('show_viewport', 'restrict_view_off', 'Realtime (show in viewport)'),
      toggle('show_render', 'restrict_render_off', 'Render'),
      h(
        'button',
        {
          class: 'mod-menu',
          'data-tip': 'Modifier options',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const items: MenuItem[] = [
              { label: 'Apply', shortcut: 'Ctrl A', op: 'object.modifier_apply', props: { modifier: m.id } },
              ...(t?.deformOnly && ob.type === 'MESH'
                ? [
                    { label: 'Apply as Shape Key', op: 'object.modifier_apply_as_shapekey', props: { modifier: m.id, keep_modifier: false } },
                    { label: 'Save as Shape Key', op: 'object.modifier_apply_as_shapekey', props: { modifier: m.id, keep_modifier: true } },
                  ]
                : []),
              { label: 'Duplicate', shortcut: 'Shift D', op: 'object.modifier_copy', props: { modifier: m.id } },
              { label: 'Copy to Selected', op: 'object.modifier_copy_to_selected', props: { modifier: m.id } },
              { separator: true },
              { label: 'Move Up', op: 'object.modifier_move_up', props: { modifier: m.id }, disabled: i === 0 },
              { label: 'Move Down', op: 'object.modifier_move_down', props: { modifier: m.id }, disabled: i === ob.modifiers.length - 1 },
              { label: 'Move to First', op: 'object.modifier_move_to_index', props: { modifier: m.id, index: 0 } },
              { label: 'Move to Last', op: 'object.modifier_move_to_index', props: { modifier: m.id, index: ob.modifiers.length - 1 } },
            ];
            openMenu(items, e.currentTarget as HTMLElement);
          },
        },
        icon('down_arrow_hlt'),
      ),
      h('button', { class: 'mod-x', 'data-tip': 'Delete modifier', onclick: (e: MouseEvent) => (e.stopPropagation(), app.run('object.modifier_remove', { modifier: m.id })) }, icon('x')),
      h('span', { class: 'ph-grip', draggable: 'true', ondragstart: (e: DragEvent) => e.dataTransfer?.setData('text/modifier', String(i)) }, '⠿'),
    ),
    open
      ? h(
          'div',
          {
            class: 'panel-body',
            ondragover: (e: DragEvent) => e.preventDefault(),
            ondrop: (e: DragEvent) => {
              const from = Number(e.dataTransfer?.getData('text/modifier'));
              if (Number.isInteger(from) && from !== i) app.run('object.modifier_move_to_index', { modifier: ob.modifiers[from].id, index: i });
            },
          },
          error ? h('div', { class: 'mod-error' }, icon('error'), error.slice(m.name.length + 2)) : null,
          (modifierFields[m.type] ?? []).map((f) => fieldWidget(ob, m as Record<string, unknown>, f)),
          modifierExtraUI[m.type]?.(ob, m) ?? null,
        )
      : null,
  );
}

const MESH_LIKE = ['MESH', 'CURVE', 'FONT', 'SURFACE', 'LATTICE'];
/** Whether a modifier type can be added to an object type. */
export const modifierAllowed = (type: string, obType: string | undefined) => !!obType && (modifierTypes[type]?.objectTypes ?? MESH_LIKE).includes(obType);

export function addModifierMenu(): MenuItem[] {
  const cats: [string, string][] = [
    ['EDIT', 'Edit'],
    ['GENERATE', 'Generate'],
    ['DEFORM', 'Deform'],
    ['NORMALS', 'Normals'],
    ['PHYSICS', 'Physics'],
    ['COLOR', 'Color'],
  ];
  const obType = app.activeObject?.type;
  return cats
    .map(([c, label]) => {
      const list = Object.values(modifierTypes)
        .filter((t) => t.category === c && modifierAllowed(t.type, obType))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (!list.length) return null;
      return { label, submenu: () => list.map((t) => ({ label: t.label, icon: t.icon, op: 'object.modifier_add', props: { type: t.type } })) } as MenuItem;
    })
    .filter(Boolean) as MenuItem[];
}

registerTab({
  id: 'MODIFIER',
  label: 'Modifiers',
  icon: 'modifier',
  group: 3,
  poll: () => {
    const o = app.activeObject;
    return !!o && (o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT' || o.type === 'SURFACE' || o.type === 'LATTICE' || o.type === 'GREASEPENCIL');
  },
  draw: () => {
    const o = app.activeObject!;
    return [
      h(
        'div',
        { class: 'stack-toolbar' },
        h(
          'button',
          {
            class: 'btn add-mod',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(addModifierMenu(), e.currentTarget as HTMLElement);
            },
          },
          icon('add'),
          'Add Modifier',
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
      o.modifiers.map((m, i) => modifierPanel(o, m, i)),
    ];
  },
});

registerOperators([
  {
    idname: 'object.modifier_add',
    label: 'Add Modifier',
    props: [{ id: 'type', label: 'Type', type: 'string', default: 'SUBSURF' }],
    poll: () => !!app.activeObject && ['MESH', 'CURVE', 'FONT', 'SURFACE', 'LATTICE', 'GREASEPENCIL'].includes(app.activeObject.type),
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      if (!modifierTypes[p.type as string] || !modifierAllowed(p.type as string, ob.type)) return 'CANCELLED';
      ob.modifiers.push(newModifier(p.type as string, uid('md'), ob.modifiers));
    },
  },
  {
    idname: 'object.modifier_remove',
    label: 'Remove Modifier',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      ob.modifiers = ob.modifiers.filter((m) => m.id !== p.modifier);
    },
  },
  {
    idname: 'object.modifier_move_to_index',
    label: 'Move Modifier to Index',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }, { id: 'index', label: 'Index', type: 'int', default: 0 }],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const i = ob.modifiers.findIndex((m) => m.id === p.modifier);
      if (i < 0) return 'CANCELLED';
      const [m] = ob.modifiers.splice(i, 1);
      ob.modifiers.splice(Math.max(0, Math.min(ob.modifiers.length, p.index as number)), 0, m);
    },
  },
  {
    idname: 'object.modifier_copy',
    label: 'Copy Modifier',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const i = ob.modifiers.findIndex((m) => m.id === p.modifier);
      if (i < 0) return 'CANCELLED';
      const c = cloneShared(ob.modifiers[i]);
      c.id = uid('md');
      c.name = newModifier(c.type, c.id, ob.modifiers).name;
      ob.modifiers.splice(i + 1, 0, c);
    },
  },
  {
    idname: 'object.modifier_copy_to_selected',
    label: 'Copy Modifier to Selected',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!app.activeObject && app.selectedObjects().length > 1,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = ob.modifiers.find((x) => x.id === p.modifier);
      if (!m) return 'CANCELLED';
      for (const o of app.selectedObjects()) if (o.id !== ob.id) o.modifiers.push({ ...cloneShared(m), id: uid('md') });
    },
  },
  {
    idname: 'object.modifier_apply',
    label: 'Apply Modifier',
    description: 'Apply modifier and remove from the stack',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => app.activeObject?.type === 'MESH' && app.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const doc = ctx.doc;
      const idx = ob.modifiers.findIndex((m) => m.id === p.modifier);
      if (idx < 0) return 'CANCELLED';
      if (idx > 0) app.report('WARNING', 'Applied modifier was not first, result may not be as expected');
      // evaluate the stack up to and including this modifier
      const keep = ob.modifiers;
      ob.modifiers = keep.slice(0, idx + 1).filter((m) => m.show_viewport);
      app.graph.invalidate(ob.id);
      app.graph.evaluate(doc, false);
      const mesh = app.graph.get(ob.id)?.mesh;
      ob.modifiers = keep.filter((_, i) => i > idx);
      if (!mesh) return 'CANCELLED';
      const me = doc.meshes[ob.data!];
      const users = Object.values(doc.objects).filter((o) => o.data === me.id).length;
      if (users > 1) {
        app.report('ERROR', 'Modifiers cannot be applied to multi-user data');
        ob.modifiers = keep;
        return 'CANCELLED';
      }
      me.positions = new Float32Array(mesh.positions);
      me.offsets = new Uint32Array(mesh.offsets);
      me.indices = new Uint32Array(mesh.indices);
      me.uvs = new Float32Array(mesh.uvs);
      me.normals = new Float32Array(mesh.normals);
      me.smooth = mesh.smooth ? new Uint8Array(mesh.smooth) : undefined;
      me.material_index = mesh.material_index ? new Uint16Array(mesh.material_index) : undefined;
      me.seams = mesh.seams ? new Uint32Array(mesh.seams) : undefined;
      me.sharp = mesh.sharp ? new Uint32Array(mesh.sharp) : undefined;
      me.creases = mesh.creases ? new Float32Array(mesh.creases) : undefined;
      me.auto_smooth_angle = mesh.auto_smooth_angle;
      if (mesh.weights && mesh.vertex_groups) me.weights = mesh.weights.map((w) => new Float32Array(w));
      me.shape_keys = [];
      me.select_vert = undefined;
      me.hide_vert = undefined;
      me.color_attributes = mesh.colors ? [{ name: me.color_attributes[me.active_color_index]?.name ?? 'Color', domain: 'CORNER', data: new Float32Array(mesh.colors) }] : [];
      app.graph.invalidate(ob.id);
    },
  },
]);

// ---------------------------------------------------------------------------
// Constraints: the Object/Bone Constraints tabs live in constraints/ui.ts (registered here to keep the tab order)
export { constraintExtraUI } from '../../constraints/ui';
import '../../constraints/index';
