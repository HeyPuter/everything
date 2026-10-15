// Dynamic Paint operators: canvas/brush toggles, surface slots and output layers.
import { app, registerOperators } from '../app/app';
import { uid } from '../data/defaults';
import { newModifier } from '../eval/modifiers';
import type { ObjectData } from '../data/types';
import { defaultBrush, defaultSurface, type DynamicPaintModifier, type DPSurface } from './dynpaint';

export const dpOf = (ob: ObjectData | null | undefined) => ob?.modifiers.find((m) => m.type === 'DYNAMIC_PAINT') as DynamicPaintModifier | undefined;
const meshActive = () => app.activeObject?.type === 'MESH' ? app.activeObject : null;

/** Active canvas surface of the active object. */
export function activeSurface(): DPSurface | undefined {
  const m = dpOf(app.activeObject);
  const cs = m?.canvas_settings;
  return cs ? cs.canvas_surfaces[Math.min(cs.active_index, cs.canvas_surfaces.length - 1)] : undefined;
}

function uniqueSurfaceName(list: DPSurface[], base: string) {
  const names = new Set(list.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

registerOperators([
  {
    idname: 'dpaint.type_toggle',
    label: 'Toggle Type Active',
    description: 'Make the object a Dynamic Paint canvas or brush (or stop being one)',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CANVAS', items: [['CANVAS', 'Canvas'], ['BRUSH', 'Brush']] }],
    poll: () => !!meshActive(),
    exec: (_ctx, p) => {
      const ob = meshActive()!;
      let m = dpOf(ob);
      if (!m) {
        m = newModifier('DYNAMIC_PAINT', uid('md'), ob.modifiers) as DynamicPaintModifier;
        ob.modifiers.push(m);
      }
      m.ui_type = p.type as 'CANVAS' | 'BRUSH';
      if (p.type === 'CANVAS') {
        if (m.canvas_settings) m.canvas_settings = null;
        else m.canvas_settings = { canvas_surfaces: [defaultSurface('PAINT', 'Surface')], active_index: 0 };
      } else {
        m.brush_settings = m.brush_settings ? null : defaultBrush();
      }
    },
  },
  {
    idname: 'dpaint.surface_slot_add',
    label: 'Add Surface Slot',
    description: 'Add a new canvas surface',
    poll: () => !!dpOf(app.activeObject)?.canvas_settings,
    exec: () => {
      const cs = dpOf(app.activeObject)!.canvas_settings!;
      cs.canvas_surfaces.push(defaultSurface('PAINT', uniqueSurfaceName(cs.canvas_surfaces, 'Surface')));
      cs.active_index = cs.canvas_surfaces.length - 1;
    },
  },
  {
    idname: 'dpaint.surface_slot_remove',
    label: 'Remove Surface Slot',
    description: 'Remove the active canvas surface',
    poll: () => !!dpOf(app.activeObject)?.canvas_settings?.canvas_surfaces.length,
    exec: () => {
      const cs = dpOf(app.activeObject)!.canvas_settings!;
      cs.canvas_surfaces.splice(cs.active_index, 1);
      cs.active_index = Math.max(0, Math.min(cs.active_index, cs.canvas_surfaces.length - 1));
    },
  },
  {
    idname: 'dpaint.output_toggle',
    label: 'Toggle Output Layer',
    description: 'Add or remove the data layer an output of the active surface writes to',
    props: [{ id: 'output', label: 'Output', type: 'enum', default: 'A', items: [['A', 'Output A'], ['B', 'Output B']] }],
    poll: () => !!activeSurface() && !!meshActive(),
    exec: (_ctx, p) => {
      const ob = meshActive()!;
      const me = app.doc.meshes[ob.data!];
      const sf = activeSurface()!;
      const name = p.output === 'B' ? sf.output_name_b : sf.output_name_a;
      if (sf.surface_type === 'WEIGHT') {
        const i = me.vertex_groups.findIndex((g) => g.name === name);
        if (i >= 0) {
          me.vertex_groups.splice(i, 1);
          me.weights.splice(i, 1);
        } else {
          me.vertex_groups.push({ name, lock_weight: false });
          me.weights.push(new Float32Array(me.positions.length / 3));
        }
        return;
      }
      if (sf.surface_type !== 'PAINT') return 'CANCELLED';
      const i = me.color_attributes.findIndex((c) => c.name === name);
      if (i >= 0) {
        me.color_attributes.splice(i, 1);
        me.active_color_index = Math.max(0, Math.min(me.active_color_index, me.color_attributes.length - 1));
      } else {
        const data = new Float32Array(me.indices.length * 4).fill(1);
        me.color_attributes.push({ name, domain: 'CORNER', data });
        me.active_color_index = me.color_attributes.length - 1;
      }
    },
  },
]);
