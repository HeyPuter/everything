// Adding Curves (hair) objects: Empty Hair attached to the active mesh, and Fur grown on the
// selected meshes.
import { app, onAppReady, operators, registerOperators, type PropDef } from '../app/app';
import { addObjectToScene } from '../ops/object';
import { newObject, IDENTITY } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { newHairCurves, uniqueHairName, appendCurves } from './data';
import { Surface } from './surface';
import { growStrands } from './generate';
import { newNodeGroup, uid } from '../data/defaults';
import { newModifier } from '../eval/modifiers';
import { addNode } from '../nodes/tree';

/** A "Surface Deform" geometry nodes modifier: the curves follow their deformed surface. */
export function addSurfaceDeform(doc: DocumentData, ob: ObjectData) {
  let ng = Object.values(doc.node_groups).find((g) => g.name === 'Surface Deform' && g.tree.nodes.some((n) => n.type === 'GeometryNodeDeformCurvesOnSurface'));
  if (!ng) {
    ng = newNodeGroup('Surface Deform');
    const t = ng.tree;
    const gi = t.nodes.find((n) => n.type === 'NodeGroupInput')!,
      go = t.nodes.find((n) => n.type === 'NodeGroupOutput')!;
    const d = addNode(t, 'GeometryNodeDeformCurvesOnSurface', [0, 0]);
    t.links = [
      { id: uid('link'), from_node: gi.id, from_socket: 'Geometry', to_node: d.id, to_socket: 'Curves' },
      { id: uid('link'), from_node: d.id, from_socket: 'Curves', to_node: go.id, to_socket: 'Geometry' },
    ];
    doc.node_groups[ng.id] = ng;
  }
  const m = newModifier('NODES', uid('md'), ob.modifiers);
  m.name = 'Surface Deform';
  m.node_group = ng.id;
  ob.modifiers = [...ob.modifiers, m];
}
import type { HairCurvesData } from './types';

/** Name of the UV map used for attaching to a mesh surface. */
export function surfaceUVName(doc: DocumentData, ob: ObjectData): string {
  const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : undefined;
  return me?.uv_map_name || (me && me.uvs.length ? 'UVMap' : '');
}

/** Create a Curves object (with data) attached to `surface`, parented without offset. */
export function addHairObject(doc: DocumentData, name: string, surface: ObjectData | null, props: Record<string, unknown> = {}): { ob: ObjectData; hc: HairCurvesData } {
  doc.hair_curves ??= {};
  const hc = newHairCurves(uniqueHairName(doc, name));
  doc.hair_curves[hc.id] = hc;
  const ob = newObject(name, 'CURVES', hc.id);
  if (surface) {
    hc.surface = surface.id;
    hc.surface_uv_map = surfaceUVName(doc, surface);
    // share the surface's material slots so the strands start with a sensible look
    addObjectToScene(doc, ob, { location: [0, 0, 0], rotation: [0, 0, 0] });
    ob.parent = surface.id;
    ob.parent_type = 'OBJECT';
    ob.matrix_parent_inverse = [...IDENTITY];
    addSurfaceDeform(doc, ob);
  } else {
    const p = { ...props };
    if (p.location === null || p.location === undefined) p.location = [...doc.scene.cursor.location];
    if (p.rotation === null) delete p.rotation;
    addObjectToScene(doc, ob, p);
  }
  return { ob, hc };
}

const transformProps: PropDef[] = [
  { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
  { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
  { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
];

const DENSITY: Record<string, number> = { LOW: 1000, MEDIUM: 5000, HIGH: 20000 };

registerOperators([
  {
    idname: 'object.curves_empty_hair_add',
    label: 'Add Empty Curves',
    description: 'Add an empty hair object attached to the active mesh (its surface)',
    props: transformProps,
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const act = app.activeObject;
      const surface = act && act.type === 'MESH' && act.select ? act : null;
      addHairObject(ctx.doc, 'Curves', surface, p);
    },
  },
]);

/** Fur: hair curves grown on every selected mesh (one Curves object per mesh). */
function quickFur(doc: DocumentData, p: Record<string, unknown>): number {
  const meshes = app.selectedObjects().filter((o) => o.type === 'MESH');
  let made = 0;
  const created: ObjectData[] = [];
  for (const mo of meshes) {
    const m = app.graph.get(mo.id)?.mesh;
    if (!m || !m.indices.length) continue;
    const s = Surface.of(m);
    const { ob, hc } = addHairObject(doc, 'Fur', mo);
    hc.materials = [...((mo.data ? doc.meshes[mo.data]?.materials : null) ?? [])].slice(0, 1);
    const count = Math.round((DENSITY[p.density as string] ?? 5000) * Math.min(1, Math.max(0.01, (p.view_percentage as number) ?? 1)));
    appendCurves(
      hc,
      growStrands(s, {
        count,
        length: p.length as number,
        radius: p.radius as number,
        points: 6,
        seed: made,
        lengthRandom: 0.3,
        noise: p.use_noise ? 0.35 : 0,
        frizz: p.use_frizz ? 0.3 : 0,
      }),
    );
    created.push(ob);
    made++;
  }
  for (const o of Object.values(doc.objects)) o.select = false;
  for (const o of created) o.select = true;
  if (created.length) doc.scene.active_object = created[created.length - 1].id;
  return made;
}

const FUR_PROPS: PropDef[] = [
  { id: 'density', label: 'Density', type: 'enum', default: 'MEDIUM', items: [['LOW', 'Low'], ['MEDIUM', 'Medium'], ['HIGH', 'High']] },
  { id: 'length', label: 'Length', type: 'float', default: 0.1, min: 0.001, subtype: 'distance' },
  { id: 'radius', label: 'Hair Radius', type: 'float', default: 0.001, min: 0, subtype: 'distance' },
  { id: 'view_percentage', label: 'View Percentage', type: 'float', default: 1, min: 0.01, max: 1, subtype: 'factor' },
  { id: 'use_noise', label: 'Noise', type: 'bool', default: true },
  { id: 'use_frizz', label: 'Frizz', type: 'bool', default: true },
];

// Quick Fur grows hair curves (the particle-based variant stays reachable for files without the hair module)
onAppReady(() => {
  const prev = operators.get('object.quick_fur');
  registerOperators([
    {
      idname: 'object.quick_fur',
      label: 'Quick Fur',
      description: 'Grow hair curves on the selected meshes',
      props: FUR_PROPS,
      poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => o.type === 'MESH'),
      exec: (ctx, p) => {
        if (quickFur(ctx.doc, p)) return 'FINISHED';
        return prev?.exec ? prev.exec(ctx, p) : 'CANCELLED';
      },
    },
  ]);
});
