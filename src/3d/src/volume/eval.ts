// Depsgraph integration: a Volume object evaluates to its grids (EvalMesh.volume) plus the
// viewport wireframe of the grids as loose edges, and registers the grids as the geometry seen by
// geometry nodes.
import { dataEvaluators } from '../eval/depsgraph';
import type { EvalMesh } from '../eval/types';
import type { DocumentData, ObjectData } from '../data/types';
import { GeometrySet } from '../geonodes/geometry';
import { primeGeometry } from '../geonodes/convert';
import { VolumeComponent } from './component';
import { volumeWire } from './wire';
import { volumeOf } from './data';
import type { VolumeData, VolumeGrid } from './types';

const ids = new WeakMap<object, number>();
let next = 1;
export function aid(a: object | undefined | null): number {
  if (!a) return 0;
  let i = ids.get(a);
  if (!i) ids.set(a, (i = next++));
  return i;
}

export function gridsSignature(grids: VolumeGrid[]) {
  return grids.map((g) => `${g.name}:${aid(g.values)}:${g.transform.join(',')}:${g.background}`).join(';');
}

export function volumeSignature(vo: VolumeData) {
  const d = vo.display;
  return `vo|${gridsSignature(vo.grids)}|${d.wireframe_type}${d.wireframe_detail}|${vo.render.clipping}|${vo.materials.join(',')}`;
}

/** Evaluated mesh standing for volume grids: the wire of the grids, the grids in `volume`. */
export function volumeEvalMesh(grids: VolumeGrid[], vo: Pick<VolumeData, 'display' | 'render'> | null): EvalMesh {
  const w = volumeWire(grids, vo?.display ?? { wireframe_type: 'BOUNDS', wireframe_detail: 'COARSE' }, vo?.render.clipping ?? 0);
  const mesh: EvalMesh = {
    positions: w.positions,
    offsets: new Uint32Array([0]),
    indices: new Uint32Array(0),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
    looseEdges: w.edges,
    volume: grids,
  };
  const g = new GeometrySet();
  g.volume = new VolumeComponent(grids);
  primeGeometry(mesh, g);
  return mesh;
}

/** Volume data of a Volume object, or null. */
export function volumeData(doc: DocumentData, ob: ObjectData) {
  return volumeOf(doc, ob);
}

dataEvaluators.VOLUME = {
  signature(doc, ob) {
    const vo = volumeOf(doc, ob);
    return vo ? volumeSignature(vo) : null;
  },
  build(doc, ob) {
    const vo = volumeOf(doc, ob)!;
    return volumeEvalMesh(vo.grids, vo);
  },
};
