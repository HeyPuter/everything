// Depsgraph integration: a Curves object evaluates to its curves (evaluated to polylines for
// display) and registers its full curves component as the geometry seen by geometry nodes.
import { dataEvaluators } from '../eval/depsgraph';
import type { EvalMesh } from '../eval/types';
import { GeometrySet } from '../geonodes/geometry';
import { primeGeometry } from '../geonodes/convert';
import { evaluatedCurves } from '../geonodes/curves/curvedata';
import { hairOf, DEFAULT_RADIUS } from './data';
import { hairToComponent } from './component';
import type { HairCurvesData } from './types';

let ids = new WeakMap<object, number>(),
  next = 1;
export function aid(a: object | undefined | null): number {
  if (!a) return 0;
  let i = ids.get(a);
  if (!i) ids.set(a, (i = next++));
  return i;
}
export function resetIds() {
  ids = new WeakMap();
}

export function hairSignature(hc: HairCurvesData) {
  return `hc|${aid(hc.positions)}|${aid(hc.curve_offsets)}|${hc.attributes.map((a) => `${a.name}:${aid(a.data)}`).join(',')}|${hc.materials.join(',')}`;
}

/** Display data of an evaluated hair mesh: radius and selection per evaluated point. */
export interface HairDisplay {
  radius: Float32Array;
  selection: Float32Array | null;
  /** curve of each evaluated point */
  curveOf: Uint32Array;
}
export const hairDisplay = new WeakMap<EvalMesh, HairDisplay>();

export function hairEvalMesh(hc: HairCurvesData): EvalMesh {
  const comp = hairToComponent(hc);
  const ev = evaluatedCurves(comp);
  const curves: { points: Float32Array; cyclic: boolean }[] = [];
  for (let k = 0; k < ev.curveCount; k++) curves.push({ points: ev.positions.subarray(ev.curveOffsets[k] * 3, ev.curveOffsets[k + 1] * 3), cyclic: !!ev.cyclic[k] });
  const mesh: EvalMesh = {
    positions: ev.positions,
    offsets: new Uint32Array([0]),
    indices: new Uint32Array(0),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
    curves,
  };
  const r = ev.attrs.get('radius');
  const s = ev.attrs.get('.selection');
  const np = ev.pointCount;
  const sel = s ? (s.domain === 'POINT' ? (s.data as Float32Array) : spread(s.data as Float32Array, ev.curveOffsets, np)) : null;
  hairDisplay.set(mesh, { radius: r && r.domain === 'POINT' ? (r.data as Float32Array) : new Float32Array(np).fill(DEFAULT_RADIUS), selection: sel, curveOf: ev.pointCurve() });
  primeGeometry(mesh, new GeometrySet(undefined, undefined, comp));
  return mesh;
}

function spread(v: Float32Array, offs: Uint32Array, np: number) {
  const out = new Float32Array(np);
  for (let c = 0; c + 1 < offs.length; c++) out.fill(v[c], offs[c], offs[c + 1]);
  return out;
}

dataEvaluators.CURVES = {
  signature(doc, ob) {
    const hc = hairOf(doc, ob);
    return hc ? hairSignature(hc) : null;
  },
  build(doc, ob) {
    return hairEvalMesh(hairOf(doc, ob)!);
  },
};
