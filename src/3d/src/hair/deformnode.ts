// Deform Curves on Surface (geometry node): curves follow the deformation of their surface. Each
// curve root is found on the undeformed surface mesh through its stored surface UV; the curve is
// carried along with the frame of that triangle from the undeformed to the evaluated surface.
import { Matrix4, Vector3 } from 'three';
import { gn } from '../geonodes/curves/defs';
import { place } from '../geonodes/curves/menu';
import { GeometrySet } from '../geonodes/geometry';
import { realizeInstances } from '../geonodes/ops/join';
import type { EvalMesh } from '../eval/types';
import type { MeshData } from '../data/types';
import { Surface } from './surface';
import { SURFACE_UV } from './data';

/** Orthonormal frame (tangent, bitangent, normal) and origin of a triangle point. */
function frame(P: ArrayLike<number>, a: number, b: number, c: number, bary: [number, number, number]) {
  const pa = new Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]),
    pb = new Vector3(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]),
    pc = new Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
  const o = pa.clone().multiplyScalar(bary[0]).addScaledVector(pb, bary[1]).addScaledVector(pc, bary[2]);
  const n = pb.clone().sub(pa).cross(pc.clone().sub(pa)).normalize();
  const t = pb.clone().sub(pa);
  t.addScaledVector(n, -t.dot(n)).normalize();
  const bt = n.clone().cross(t);
  return new Matrix4().makeBasis(t, bt, n).setPosition(o);
}

/**
 * Deform curve points (surface object space). `restMesh` is the undeformed surface with UVs,
 * `deformed` the evaluated positions of the same vertices. Returns new positions (or null when
 * nothing could be attached).
 */
export function deformOnSurface(positions: Float32Array, offsets: ArrayLike<number>, uvs: ArrayLike<number>, restMesh: EvalMesh, deformed: ArrayLike<number>): Float32Array | null {
  const s = Surface.of(restMesh);
  if (!s.hasUV || deformed.length !== restMesh.positions.length) return null;
  const out = positions.slice();
  const p = new Vector3();
  let any = false;
  for (let c = 0; c + 1 < offsets.length; c++) {
    const hit = s.lookupUV([uvs[c * 2], uvs[c * 2 + 1]]);
    if (!hit) continue;
    const a = s.tris[hit.tri * 3],
      b = s.tris[hit.tri * 3 + 1],
      d = s.tris[hit.tri * 3 + 2];
    const rest = frame(restMesh.positions, a, b, d, hit.bary);
    const def = frame(deformed, a, b, d, hit.bary);
    const m = def.multiply(rest.invert());
    for (let i = offsets[c]; i < offsets[c + 1]; i++) p.fromArray(positions, i * 3).applyMatrix4(m).toArray(out, i * 3);
    any = true;
  }
  return any ? out : null;
}

const restCache = new WeakMap<Float32Array, EvalMesh>();
function restMeshOf(me: MeshData): EvalMesh {
  let m = restCache.get(me.positions);
  if (!m || m.indices !== me.indices) {
    m = { positions: me.positions, offsets: me.offsets, indices: me.indices, uvs: me.uvs, normals: new Float32Array(0), smooth: me.smooth };
    restCache.set(me.positions, m);
  }
  return m;
}

gn('GeometryNodeDeformCurvesOnSurface', 'geometry', {
  exec: (ctx) => {
    const g = realizeInstances(ctx.geometry('Curves'));
    const curves = g.curves;
    const env = ctx.env;
    const ob = env.ob;
    if (!curves) return { Curves: g };
    if (!ob || ob.type !== 'CURVES' || !ob.data) {
      ctx.warn('Only works on hair curves objects');
      return { Curves: g };
    }
    const hc = env.doc.hair_curves?.[ob.data];
    const sob = hc?.surface ? env.doc.objects[hc.surface] : null;
    const me = sob?.type === 'MESH' && sob.data ? env.doc.meshes[sob.data] : null;
    if (!hc || !sob || !me) {
      ctx.warn('The curves have no mesh surface');
      return { Curves: g };
    }
    const uv = curves.attrs.get(SURFACE_UV);
    if (!uv || uv.domain !== 'CURVE') {
      ctx.warn('The curves have no surface UV coordinates (snap them to the surface first)');
      return { Curves: g };
    }
    const evaluated = env.objectGeometry(sob.id)?.mesh;
    if (!evaluated || evaluated.positions.length !== me.positions.length) {
      ctx.warn('The surface changed its topology after deformation');
      return { Curves: g };
    }
    // hair space ↔ surface space
    const self = new Matrix4().fromArray(Array.from(env.selfWorld));
    const surf = new Matrix4().fromArray(Array.from(env.objectWorld(sob.id) ?? new Matrix4().elements));
    const toSurface = surf.clone().invert().multiply(self);
    const fromSurface = toSurface.clone().invert();
    const P = curves.positions.slice();
    const v = new Vector3();
    for (let i = 0; i < P.length; i += 3) v.fromArray(P, i).applyMatrix4(toSurface).toArray(P, i);
    const moved = deformOnSurface(P, curves.curveOffsets, uv.data, restMeshOf(me), evaluated.positions);
    if (!moved) return { Curves: g };
    for (let i = 0; i < moved.length; i += 3) v.fromArray(moved, i).applyMatrix4(fromSurface).toArray(moved, i);
    const out = curves.copy();
    out.positions = moved;
    return { Curves: g.with(out) };
  },
  sig: (_node, env) => {
    const ob = env.ob;
    const hc = ob?.data ? env.doc.hair_curves?.[ob.data] : undefined;
    return hc?.surface ? env.objectSig(hc.surface) : '';
  },
  deps: (_node, doc) => {
    const ids: string[] = [];
    for (const ob of Object.values(doc.objects)) {
      const hc = ob.type === 'CURVES' && ob.data ? doc.hair_curves?.[ob.data] : undefined;
      if (hc?.surface) ids.push(hc.surface);
    }
    return ids;
  },
});

place('Curve/Operations', 'GeometryNodeDeformCurvesOnSurface');
