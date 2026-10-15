// Object ▸ Quick Effects ▸ Quick Liquid: the selected meshes become liquid sources inside a new
// liquid domain that encloses them with room to fall and spread.
import { Box3, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { newMeshData, newObject, uid } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { newModifier } from '../eval/modifiers';
import * as prim from '../mesh/primitives';
import { addObjectToScene, uniqueName } from '../ops/object';
import type { FluidModifier } from './fluid';

const meshes = () => app.selectedObjects().filter((o) => o.type === 'MESH');

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

function fluidModifier(ob: ObjectData): FluidModifier {
  let m = ob.modifiers.find((x) => x.type === 'FLUID') as FluidModifier | undefined;
  if (!m) {
    m = newModifier('FLUID', uid('md'), ob.modifiers) as FluidModifier;
    ob.modifiers = [...ob.modifiers, m];
  }
  return m;
}

registerOperators([
  {
    idname: 'object.quick_liquid',
    label: 'Quick Liquid',
    description: 'Make the selected meshes liquid inside a new liquid domain around them',
    props: [{ id: 'show_flows', label: 'Render Liquid Objects', type: 'bool', default: false }],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' && meshes().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const flows = meshes();
      for (const ob of flows) {
        const m = fluidModifier(ob);
        m.fluid_type = 'FLOW';
        m.flow_settings = { ...m.flow_settings, flow_type: 'LIQUID', flow_behavior: 'GEOMETRY', surface_distance: 0 };
        if (!p.show_flows) {
          ob.display_type = 'WIRE';
          ob.hide_render = true;
        }
      }
      // domain: wider than the liquid and reaching well below it
      const box = worldBounds(flows);
      const size = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      const m = Math.max(size.x, size.y, size.z, 0.2);
      const half = new Vector3(Math.max(size.x, m), Math.max(size.y, m), Math.max(size.z, m) * 1.25);
      const loc = new Vector3(center.x, center.y, box.max.z + size.z * 0.1 - half.z);
      const me = newMeshData(uniqueName(doc, 'Liquid Domain', 'meshes'), prim.cube(2));
      doc.meshes[me.id] = me;
      const dom = newObject('Liquid Domain', 'MESH', me.id);
      addObjectToScene(doc, dom, { location: [loc.x, loc.y, loc.z], rotation: [0, 0, 0] });
      dom.scale = [half.x, half.y, half.z];
      const dm = fluidModifier(dom);
      dm.fluid_type = 'DOMAIN';
      dm.domain_settings = {
        ...dm.domain_settings,
        domain_type: 'LIQUID',
        use_collision_border_front: true,
        use_collision_border_back: true,
        use_collision_border_right: true,
        use_collision_border_left: true,
        use_collision_border_top: true,
        use_collision_border_bottom: true,
      };
    },
  },
]);
