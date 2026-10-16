// object.bake: bake the chosen pass of the selected objects into their images (or color
// attributes). Unset properties take the scene's bake settings, so scripts can pass only what
// differs. Interactive runs work over several frames (Esc cancels); scripts block until done.
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import { bakeSettings, bakeType, contributions, BAKE_TYPES, SWIZZLE, type BakeType, type BakeSettings } from './settings';
import { bakeNow, bakeInteractive, bakeState, type BakeOptions } from './job';

/** A property whose default is read from the scene's bake settings when the operator runs. */
function sceneProp(def: Omit<PropDef, 'default'>, read: (b: BakeSettings) => unknown): PropDef {
  const p = { ...def } as PropDef;
  Object.defineProperty(p, 'default', { enumerable: true, get: () => (app ? read(bakeSettings(app.doc.scene.render)) : undefined) });
  return p;
}

const swz = SWIZZLE.map(([v, l]) => [v, l] as [string, string]);

export const BAKE_PROPS: PropDef[] = [
  { id: 'type', label: 'Type', type: 'enum', items: BAKE_TYPES.map(([v, l, d]) => [v, l, d]), default: 'COMBINED' },
  { id: 'pass_filter', label: 'Pass Filter', type: 'string', default: [], hidden: true },
  sceneProp({ id: 'margin', label: 'Margin', type: 'int', min: 0, max: 32767, softMax: 64, subtype: 'pixel' }, (b) => b.margin),
  sceneProp({ id: 'margin_type', label: 'Margin Type', type: 'enum', items: [['ADJACENT_FACES', 'Adjacent Faces'], ['EXTEND', 'Extend']] }, (b) => b.margin_type),
  sceneProp({ id: 'use_selected_to_active', label: 'Selected to Active', type: 'bool' }, (b) => b.use_selected_to_active),
  sceneProp({ id: 'max_ray_distance', label: 'Max Ray Distance', type: 'float', min: 0, softMax: 1, subtype: 'distance' }, (b) => b.max_ray_distance),
  sceneProp({ id: 'cage_extrusion', label: 'Cage Extrusion', type: 'float', min: 0, softMax: 1, subtype: 'distance' }, (b) => b.cage_extrusion),
  sceneProp({ id: 'cage_object', label: 'Cage Object', type: 'string' }, (b) => (b.cage_object && app.doc.objects[b.cage_object]?.name) || ''),
  sceneProp({ id: 'normal_space', label: 'Normal Space', type: 'enum', items: [['OBJECT', 'Object'], ['TANGENT', 'Tangent']] }, (b) => b.normal_space),
  sceneProp({ id: 'normal_r', label: 'R', type: 'enum', items: swz }, (b) => b.normal_r),
  sceneProp({ id: 'normal_g', label: 'G', type: 'enum', items: swz }, (b) => b.normal_g),
  sceneProp({ id: 'normal_b', label: 'B', type: 'enum', items: swz }, (b) => b.normal_b),
  sceneProp({ id: 'target', label: 'Target', type: 'enum', items: [['IMAGE_TEXTURES', 'Image Textures'], ['VERTEX_COLORS', 'Active Color Attribute']] }, (b) => b.target),
  sceneProp({ id: 'use_clear', label: 'Clear', type: 'bool' }, (b) => b.use_clear),
  sceneProp({ id: 'use_cage', label: 'Cage', type: 'bool' }, (b) => b.use_cage),
];

/** Pass filter as given by scripts (a set / list of names, or a single name). */
function filterList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v instanceof Set) return [...v].map(String);
  if (typeof v === 'string' && v) return v.split(/[\s,|]+/).filter(Boolean);
  return [];
}

/** Operator properties → bake options. */
export function bakeOptions(p: Record<string, unknown>): BakeOptions {
  const b = bakeSettings(app.doc.scene.render);
  const cageName = String(p.cage_object ?? '');
  const cage = cageName ? Object.values(app.doc.objects).find((o) => o.name === cageName || o.id === cageName) : null;
  if (cageName && !cage) throw new Error(`No object named "${cageName}" to use as the cage`);
  return {
    type: (String(p.type ?? 'COMBINED').toUpperCase() as BakeType) || 'COMBINED',
    filter: contributions(filterList(p.pass_filter), b),
    margin: Math.max(0, Math.round(Number(p.margin ?? b.margin))),
    margin_type: (p.margin_type as BakeOptions['margin_type']) ?? b.margin_type,
    use_selected_to_active: !!(p.use_selected_to_active ?? b.use_selected_to_active),
    use_cage: !!(p.use_cage ?? b.use_cage),
    cage_object: cage?.id ?? null,
    cage_extrusion: Math.max(0, Number(p.cage_extrusion ?? b.cage_extrusion)),
    max_ray_distance: Math.max(0, Number(p.max_ray_distance ?? b.max_ray_distance)),
    normal_space: (p.normal_space as BakeOptions['normal_space']) ?? b.normal_space,
    normal_r: (p.normal_r as BakeOptions['normal_r']) ?? b.normal_r,
    normal_g: (p.normal_g as BakeOptions['normal_g']) ?? b.normal_g,
    normal_b: (p.normal_b as BakeOptions['normal_b']) ?? b.normal_b,
    target: (p.target as BakeOptions['target']) ?? b.target,
    use_clear: !!(p.use_clear ?? b.use_clear),
  };
}

const bakePoll = (ctx: OpContext) => !bakeState() && !ctx.doc.mode.startsWith('EDIT') && (app.selectedObjects().some((o) => o.type === 'MESH') || app.activeObject?.type === 'MESH');

registerOperators([
  {
    idname: 'object.bake',
    label: 'Bake',
    description: 'Bake a render pass of the selected objects into their image textures or color attributes',
    props: BAKE_PROPS,
    redo: false,
    poll: bakePoll,
    exec: (_ctx, p) => {
      let o: BakeOptions;
      try {
        o = bakeOptions(p);
      } catch (e) {
        app.report('ERROR', (e as Error).message);
        return 'CANCELLED';
      }
      const r = bakeNow(o);
      app.report(r.ok ? 'INFO' : 'ERROR', r.message);
      return r.ok ? 'FINISHED' : 'CANCELLED';
    },
    invoke: (_ctx, p) => {
      let o: BakeOptions;
      try {
        o = bakeOptions(p);
      } catch (e) {
        app.report('ERROR', (e as Error).message);
        return 'CANCELLED';
      }
      void bakeInteractive(o, 'Bake');
      return 'RUNNING_MODAL';
    },
  },
]);

/** The Bake button's properties: the scene's bake type (other settings come from the scene). */
export function bakeButtonProps(): Record<string, unknown> {
  return { type: bakeType(app.doc.scene.render) };
}
