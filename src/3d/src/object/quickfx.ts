// Object ▸ Quick Effects: one-click setups built from the physics systems (smoke, fur).
import { Box3, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { newMeshData, newObject, uid } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { newModifier } from '../eval/modifiers';
import * as prim from '../mesh/primitives';
import { addObjectToScene, uniqueName } from '../ops/object';
import type { FluidModifier } from '../physics/fluid';
import { defaultParticleSettings, defaultPointCache, type ObjectPhysics, type ParticleSystemX } from '../physics/types';

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';
const meshes = () => app.selectedObjects().filter((o) => o.type === 'MESH');

/** World bounds of the evaluated geometry of some objects. */
function worldBounds(obs: ObjectData[]): Box3 {
  const box = new Box3();
  const v = new Vector3();
  for (const o of obs) {
    const ev = app.graph.get(o.id);
    const P = ev?.mesh?.positions;
    if (!ev || !P) continue;
    for (let i = 0; i < P.length; i += 3) box.expandByPoint(v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(ev.world));
  }
  return box;
}

function fluidOf(ob: ObjectData): FluidModifier {
  let m = ob.modifiers.find((x) => x.type === 'FLUID') as FluidModifier | undefined;
  if (!m) {
    m = newModifier('FLUID', uid('md'), ob.modifiers) as FluidModifier;
    ob.modifiers = [...ob.modifiers, m];
  }
  return m;
}

registerOperators([
  {
    idname: 'object.quick_smoke',
    label: 'Quick Smoke',
    description: 'Make the selected meshes emit smoke inside a new smoke domain that encloses them',
    props: [
      { id: 'style', label: 'Smoke Style', type: 'enum', default: 'SMOKE', items: [['SMOKE', 'Smoke'], ['FIRE', 'Fire'], ['BOTH', 'Smoke & Fire']] },
      { id: 'show_flows', label: 'Render Smoke Objects', type: 'bool', default: false },
    ],
    poll: (ctx) => objectMode(ctx) && meshes().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const flows = meshes();
      for (const ob of flows) {
        const m = fluidOf(ob);
        m.fluid_type = 'FLOW';
        m.flow_settings = { ...m.flow_settings, flow_type: p.style as FluidModifier['flow_settings']['flow_type'] };
        // emitters are drawn as wires unless they should stay visible
        if (!p.show_flows) {
          ob.display_type = 'WIRE';
          ob.hide_render = true;
        }
      }
      // domain: twice the emitters' size, with extra room above for the rising smoke
      const box = worldBounds(flows);
      const size = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      const half = new Vector3(size.x, size.y, size.z * 1.5);
      const loc = new Vector3(center.x, center.y, box.min.z - size.z / 2 + half.z);
      const me = newMeshData(uniqueName(doc, 'Smoke Domain', 'meshes'), prim.cube(2));
      doc.meshes[me.id] = me;
      const dom = newObject('Smoke Domain', 'MESH', me.id);
      addObjectToScene(doc, dom, { location: [loc.x, loc.y, loc.z], rotation: [0, 0, 0] });
      dom.scale = [Math.max(half.x, 0.1), Math.max(half.y, 0.1), Math.max(half.z, 0.1)];
      dom.display_type = 'WIRE';
      // the smoke itself is drawn by the simulation; the box is only its container
      dom.hide_render = true;
      const dm = fluidOf(dom);
      dm.fluid_type = 'DOMAIN';
    },
  },
  {
    idname: 'object.quick_fur',
    label: 'Quick Fur',
    description: 'Grow hair on the selected meshes',
    props: [
      { id: 'density', label: 'Density', type: 'enum', default: 'MEDIUM', items: [['LOW', 'Low'], ['MEDIUM', 'Medium'], ['HIGH', 'High']] },
      { id: 'length', label: 'Length', type: 'float', default: 0.1, min: 0.001, subtype: 'distance' },
    ],
    poll: (ctx) => objectMode(ctx) && meshes().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const count = { LOW: 1000, MEDIUM: 5000, HIGH: 20000 }[p.density as string] ?? 5000;
      for (const o of meshes()) {
        const ob = o as ObjectPhysics;
        let name = 'Fur';
        for (let i = 1; Object.values(doc.particles).some((x) => x.name === name); i++) name = `Fur.${String(i).padStart(3, '0')}`;
        const s = defaultParticleSettings(uid('pa'), name);
        Object.assign(s, { type: 'HAIR', count, hair_length: p.length as number, frame_start: doc.scene.frame_start, frame_end: doc.scene.frame_start + 199, child_radius: Math.max(0.001, (p.length as number) * 0.5) });
        doc.particles[s.id] = s;
        let psName = 'Fur';
        for (let i = 1; ob.particle_systems.some((x) => x.name === psName); i++) psName = `Fur.${String(i).padStart(3, '0')}`;
        const ps: ParticleSystemX & { id: string } = { name: psName, settings: s.id, seed: ob.particle_systems.length, id: uid('psys'), point_cache: defaultPointCache(doc.scene.frame_start, doc.scene.frame_end) };
        ob.particle_systems = [...ob.particle_systems, ps];
        const m = newModifier('PARTICLE_SYSTEM', uid('md'), ob.modifiers);
        m.name = psName;
        m.particle_system = ps.id;
        ob.modifiers = [...ob.modifiers, m];
        ob.active_particle_system_index = ob.particle_systems.length - 1;
      }
    },
  },
]);
