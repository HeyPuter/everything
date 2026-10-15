// Cut Particles to Shape: hair leaving a closed mesh (the shape object) is cut where it exits.
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { app, registerOperators } from '../../app/app';
import type { EditedHair } from '../../physics/types';
import type { EvalMesh } from '../../eval/types';
import { trimPolyline } from '../brushmath';
import { Surface } from '../surface';
import { activePE, peSettings, setEd } from './mode';
import { fromStrandLists, toStrandLists } from './keys';

/** Inside test for a closed mesh: odd number of crossings along a fixed ray. */
export class ShapeVolume {
  private bvh: MeshBVH | null;
  constructor(mesh: EvalMesh) {
    const s = Surface.of(mesh);
    if (!s.tris.length) {
      this.bvh = null;
      return;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    g.setIndex(new BufferAttribute(s.tris.slice(), 1));
    this.bvh = new MeshBVH(g);
  }
  inside(p: Vector3): boolean {
    if (!this.bvh) return false;
    const hits = this.bvh.raycast(new Ray(p.clone(), new Vector3(0.0123, 0.0341, 1).normalize()), DoubleSide);
    return hits.length % 2 === 1;
  }
  /** Distance along a segment to the first surface crossing (or null). */
  crossing(a: Vector3, b: Vector3): number | null {
    if (!this.bvh) return null;
    const d = b.clone().sub(a);
    const len = d.length();
    if (len <= 0) return null;
    const h = this.bvh.raycastFirst(new Ray(a.clone(), d.normalize()), DoubleSide);
    return h && h.distance <= len ? h.distance : null;
  }
}

/** Cut every visible hair at the point where it leaves the shape (keys are kept, spread over the rest). */
export function cutToShape(ed: EditedHair, shape: ShapeVolume, toShape: Matrix4): { ed: EditedHair; cut: number } {
  let cut = 0;
  const a = new Vector3(),
    b = new Vector3();
  const lists = toStrandLists(ed).map((s) => {
    const n = s.weight.length;
    if (s.hide || n < 2) return s;
    a.fromArray(s.co, 0).applyMatrix4(toShape);
    if (!shape.inside(a)) return s;
    let acc = 0;
    for (let k = 0; k + 1 < n; k++) {
      a.fromArray(s.co, k * 3).applyMatrix4(toShape);
      b.fromArray(s.co, k * 3 + 3).applyMatrix4(toShape);
      const segLocal = Math.hypot(s.co[k * 3 + 3] - s.co[k * 3], s.co[k * 3 + 4] - s.co[k * 3 + 1], s.co[k * 3 + 5] - s.co[k * 3 + 2]);
      const d = shape.crossing(a, b);
      if (d !== null) {
        const f = d / Math.max(1e-12, a.distanceTo(b));
        cut++;
        return { ...s, co: trimPolyline(s.co, Math.max(1e-5, acc + segLocal * f), n) };
      }
      acc += segLocal;
    }
    return s;
  });
  return { ed: cut ? fromStrandLists(lists) : ed, cut };
}

registerOperators([
  {
    idname: 'particle.shape_cut',
    label: 'Shape Cut',
    description: 'Cut hair to the shape of the shape object (hair leaving it is shortened)',
    poll: () => {
      const a = activePE();
      const id = a ? peSettings(app.doc).shape_object : null;
      return !!id && app.doc.objects[id]?.type === 'MESH';
    },
    exec: () => {
      const a = activePE()!;
      const id = peSettings(app.doc).shape_object!;
      const ev = app.graph.get(id);
      const ow = app.graph.get(a.ob.id)?.world;
      if (!ev?.mesh || !ow) return 'CANCELLED';
      const toShape = ev.world.clone().invert().multiply(ow);
      const r = cutToShape(a.ed, new ShapeVolume(ev.mesh), toShape);
      app.report('INFO', `Cut ${r.cut} hair${r.cut === 1 ? '' : 's'}`);
      if (!r.cut) return 'CANCELLED';
      setEd(a.psys, r.ed);
    },
  },
]);
