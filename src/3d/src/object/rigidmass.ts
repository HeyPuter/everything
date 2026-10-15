// Rigid Body ▸ Calculate Mass: mass from the collision shape's volume and a material density.
import { Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import type { ObjectData, RigidBodyData } from '../data/types';
import type { EvalMesh } from '../eval/types';

/** Approximate densities in kg/m³. */
export const DENSITIES: [string, string, number][] = [
  ['AIR', 'Air', 1.2],
  ['WATER', 'Water', 1000],
  ['ICE', 'Ice', 917],
  ['WOOD', 'Wood (Oak)', 750],
  ['PLASTIC', 'Plastic', 1200],
  ['RUBBER', 'Rubber', 1100],
  ['CONCRETE', 'Concrete', 2400],
  ['GLASS', 'Glass', 2500],
  ['ALUMINIUM', 'Aluminium', 2700],
  ['STEEL', 'Steel', 7850],
  ['GOLD', 'Gold', 19300],
];

function meshVolume(m: EvalMesh, scale: Vector3): number {
  const P = m.positions;
  let v = 0;
  for (let f = 0; f + 1 < m.offsets.length; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const a = m.indices[s];
    for (let c = s + 1; c + 1 < e; c++) {
      const b = m.indices[c],
        d = m.indices[c + 1];
      v += (P[a * 3] * (P[b * 3 + 1] * P[d * 3 + 2] - P[b * 3 + 2] * P[d * 3 + 1]) - P[a * 3 + 1] * (P[b * 3] * P[d * 3 + 2] - P[b * 3 + 2] * P[d * 3]) + P[a * 3 + 2] * (P[b * 3] * P[d * 3 + 1] - P[b * 3 + 1] * P[d * 3])) / 6;
    }
  }
  return Math.abs(v * scale.x * scale.y * scale.z);
}

/** Volume (m³) of an object's collision shape. */
export function shapeVolume(shape: RigidBodyData['collision_shape'], m: EvalMesh, scale: Vector3): number {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.positions[i + k]);
      hi[k] = Math.max(hi[k], m.positions[i + k]);
    }
  if (!isFinite(lo[0])) return 0;
  const dx = (hi[0] - lo[0]) * Math.abs(scale.x),
    dy = (hi[1] - lo[1]) * Math.abs(scale.y),
    dz = (hi[2] - lo[2]) * Math.abs(scale.z);
  const r2 = Math.max(dx, dy) / 2;
  switch (shape) {
    case 'BOX':
      return dx * dy * dz;
    case 'SPHERE': {
      const r = Math.max(dx, dy, dz) / 2;
      return (4 / 3) * Math.PI * r ** 3;
    }
    case 'CAPSULE': {
      const h = Math.max(0, dz - 2 * r2);
      return Math.PI * r2 * r2 * h + (4 / 3) * Math.PI * r2 ** 3;
    }
    case 'CYLINDER':
      return Math.PI * r2 * r2 * dz;
    case 'CONE':
      return (Math.PI * r2 * r2 * dz) / 3;
    default:
      return meshVolume(m, scale) || dx * dy * dz;
  }
}

registerOperators([
  {
    idname: 'rigidbody.mass_calculate',
    label: 'Calculate Mass',
    description: 'Set the mass of the selected rigid bodies from their shape volume and a material density',
    props: [
      { id: 'material', label: 'Material Preset', type: 'enum', default: 'DEFAULT', items: [['DEFAULT', 'Custom'], ...DENSITIES.map(([v, l, d]): [string, string] => [v, `${l} (${d} kg/m³)`])] },
      { id: 'density', label: 'Density', type: 'float', default: 1, min: 0.001, showIf: (p) => p.material === 'DEFAULT' },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => !!o.rigid_body),
    exec: (_ctx, p) => {
      const density = p.material === 'DEFAULT' ? (p.density as number) : DENSITIES.find(([v]) => v === p.material)?.[2] ?? 1;
      let n = 0;
      for (const ob of app.selectedObjects() as ObjectData[]) {
        const ev = app.graph.get(ob.id);
        if (!ob.rigid_body || !ev?.mesh) continue;
        const scale = new Vector3();
        ev.world.decompose(new Vector3(), new Quaternion(), scale);
        const vol = shapeVolume(ob.rigid_body.collision_shape, ev.mesh, scale);
        ob.rigid_body.mass = Math.max(0.001, vol * density);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
]);
