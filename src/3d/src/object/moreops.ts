// More Object Mode operators: duplicate without moving, render visibility helpers, mode with a
// mesh select sub-mode, custom property defaults, the Add Modifier menu at the pointer.
import { app, registerOperators } from '../app/app';
import { duplicateSelected } from '../ops/object';
import { openMenu } from '../ui/menu';
import { addModifierMenu } from '../editors/properties/stack';
import { customPropMeta, setCustomPropMeta } from '../ui/custommeta';
import type { ObjectData } from '../data/types';

const objectMode = () => app.doc.mode === 'OBJECT';

type Rec = Record<string, unknown>;

/** Store each custom property's current value as its default; returns how many were set. */
export function assignPropertyDefaults(block: Rec): number {
  const custom = block.custom as Rec | undefined;
  if (!custom) return 0;
  let n = 0;
  for (const [key, value] of Object.entries(custom)) {
    // nested groups and arbitrary script values have no default
    if (value === null || (typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value))) continue;
    const meta = { ...customPropMeta(block, key) };
    meta.default = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value as ArrayLike<unknown>) : value;
    setCustomPropMeta(block, key, meta);
    n++;
  }
  return n;
}

/** Data-block of an object's data, when it has one. */
function dataOf(ob: ObjectData): Rec | undefined {
  if (!ob.data) return undefined;
  for (const t of Object.values(app.doc) as unknown[]) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const rec: unknown = (t as Record<string, unknown>)[ob.data];
    if (rec && typeof rec === 'object' && (rec as { id?: string }).id === ob.data) return rec as Rec;
  }
  return undefined;
}

registerOperators([
  {
    idname: 'object.duplicate',
    label: 'Duplicate Objects',
    description: 'Copy the selected objects in place (the copies become the selection)',
    props: [
      { id: 'linked', label: 'Linked', type: 'bool', default: false },
      { id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATION', items: [['TRANSLATION', 'Translation'], ['DUMMY', 'Dummy']], hidden: true },
    ],
    poll: () => objectMode() && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      duplicateSelected(ctx.doc, !!p.linked);
    },
  },
  {
    idname: 'object.hide_render_clear_all',
    label: 'Clear All Restrict Render',
    description: 'Let every object of the scene render again',
    poll: objectMode,
    exec: (ctx) => {
      let n = 0;
      for (const ob of Object.values(ctx.doc.objects))
        if (ob.hide_render) {
          ob.hide_render = false;
          n++;
        }
      if (!n) return 'CANCELLED';
      app.report('INFO', `${n} object(s) render again`);
    },
  },
  {
    idname: 'object.isolate_type_render',
    label: 'Restrict Render Unselected',
    description: 'Keep unselected objects of the active object’s type out of renders',
    poll: () => objectMode() && !!app.activeObject,
    exec: (ctx) => {
      const type = app.activeObject!.type;
      let n = 0;
      for (const ob of Object.values(ctx.doc.objects)) {
        if (ob.type !== type) continue;
        const hide = !ob.select;
        if (!!ob.hide_render !== hide) {
          ob.hide_render = hide;
          n++;
        }
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'object.mode_set_with_submode',
    label: 'Set Object Mode with Sub-mode',
    description: 'Switch the interaction mode, and for meshes the selection mode too',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Object Mode'], ['EDIT', 'Edit Mode'], ['SCULPT', 'Sculpt Mode'], ['VERTEX_PAINT', 'Vertex Paint'], ['WEIGHT_PAINT', 'Weight Paint'], ['TEXTURE_PAINT', 'Texture Paint'], ['POSE', 'Pose Mode']] },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
      { id: 'mesh_select_mode', label: 'Mesh Mode', type: 'bools', default: [false, false, false] },
    ],
    poll: () => !!app.activeObject,
    exec: (ctx, p) => {
      const r = app.run('object.mode_set', { mode: p.mode, toggle: p.toggle }, { invoke: false });
      if (r === 'CANCELLED') return 'CANCELLED';
      const sm = p.mesh_select_mode as boolean[] | undefined;
      if (ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH' && sm?.some(Boolean)) ctx.doc.scene.tool_settings.mesh_select_mode = [!!sm[0], !!sm[1], !!sm[2]];
      app.changed('mode');
    },
    redo: false,
  },
  {
    idname: 'object.assign_property_defaults',
    label: 'Assign Custom Property Values as Default',
    description: 'Use the current values of the custom properties as their defaults',
    props: [
      { id: 'process_data', label: 'Process Data', type: 'bool', default: true },
      { id: 'process_bones', label: 'Process Bones', type: 'bool', default: true },
    ],
    poll: () => (app.doc.mode === 'OBJECT' || app.doc.mode === 'POSE') && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      let n = 0;
      for (const ob of app.selectedObjects()) {
        n += assignPropertyDefaults(ob as unknown as Rec);
        if (p.process_data) {
          const d = dataOf(ob);
          if (d) n += assignPropertyDefaults(d);
        }
        if (p.process_bones && ob.pose) for (const pb of Object.values(ob.pose)) n += assignPropertyDefaults(pb as unknown as Rec);
      }
      app.report('INFO', `${n} default value(s) assigned`);
    },
  },
  {
    idname: 'object.add_modifier_menu',
    label: 'Add Modifier',
    description: 'Open the Add Modifier menu at the pointer',
    undo: false,
    poll: () => !!app.activeObject && ['MESH', 'CURVE', 'FONT', 'SURFACE', 'LATTICE', 'CURVES', 'POINTCLOUD', 'VOLUME', 'GREASEPENCIL'].includes(app.activeObject.type),
    invoke: (ctx) => {
      const at = ctx.event ?? app.pointer;
      openMenu(addModifierMenu(), { x: at.x, y: at.y }, { title: 'Add Modifier', search: true });
      return 'CANCELLED';
    },
  },
]);
