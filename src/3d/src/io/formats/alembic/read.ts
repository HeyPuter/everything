// Alembic (Ogawa) → IR: Xform (static/animated), PolyMesh/SubD (n-gons, UVs, normals, face sets,
// vertex animation as per-sample shape keys), Camera. Alembic data is Y-up with clockwise faces.
import { Matrix4, Vector3 } from 'three';
import { AlembicArchive, findProp, type AbcObject, type AbcProperty } from './archive';
import { emptyScene, Y_UP_TO_Z_UP, type IRChannel, type IRMesh, type IRScene } from '../ir';

const MAX_CACHE_FLOATS = 30_000_000;
const D2R = Math.PI / 180;

const schemaOf = (o: AbcObject) => o.metadata.schema ?? '';
const isShape = (o: AbcObject) => /AbcGeom_(PolyMesh|SubD|Camera|Points|Curve|NuPatch|Light)/.test(schemaOf(o));

export function readAlembic(bytes: Uint8Array): IRScene {
  const abc = new AlembicArchive(bytes);
  const ir = emptyScene();
  const W = ir.warnings;
  ir.axis = Y_UP_TO_Z_UP;
  ir.unitScale = 1;
  const fpsMeta = Number(abc.metadata.FramesPerTimeUnit);
  if (fpsMeta > 0) ir.fps = fpsMeta;
  const channels: IRChannel[] = [];

  const xformAt = (xf: AbcProperty, i: number): { m: Matrix4; inherits: boolean } => {
    const ops = (abc.sample(findProp(xf, '.ops')!, 0) as number[] | null) ?? [];
    const valsProp = findProp(xf, '.vals');
    const vals = valsProp ? ((abc.sample(valsProp, i) as number[] | null) ?? []) : [];
    const inh = findProp(xf, '.inherits');
    const inherits = inh ? ((abc.sample(inh, i) as number[] | null)?.[0] ?? 1) !== 0 : true;
    const m = new Matrix4();
    let k = 0;
    for (const op of ops) {
      const type = op >> 4;
      const t = new Matrix4();
      if (type === 0) {
        t.makeScale(vals[k], vals[k + 1], vals[k + 2]);
        k += 3;
      } else if (type === 1) {
        t.makeTranslation(vals[k], vals[k + 1], vals[k + 2]);
        k += 3;
      } else if (type === 2) {
        const axis = new Vector3(vals[k], vals[k + 1], vals[k + 2]);
        if (axis.lengthSq() > 0) t.makeRotationAxis(axis.normalize(), vals[k + 3] * D2R);
        k += 4;
      } else if (type === 3) {
        t.fromArray(vals.slice(k, k + 16));
        k += 16;
      } else if (type === 4) t.makeRotationX(vals[k++] * D2R);
      else if (type === 5) t.makeRotationY(vals[k++] * D2R);
      else if (type === 6) t.makeRotationZ(vals[k++] * D2R);
      m.multiply(t);
    }
    return { m, inherits };
  };

  const visit = (o: AbcObject, parent: number) => {
    const schema = schemaOf(o);
    if (/Xform/.test(schema)) {
      const xf = findProp(o.properties, '.xform');
      const shapes = o.children.filter(isShape);
      const shape = shapes.length === 1 ? shapes[0] : null;
      const node = ir.nodes.length;
      ir.nodes.push({ name: o.name, parent, matrix: new Matrix4().toArray() });
      if (xf) {
        const { m, inherits } = xformAt(xf, 0);
        if (!inherits) {
          W.push(`"${o.name}": transforms that do not inherit their parent are placed in world space`);
          ir.nodes[node].parent = -1;
        }
        ir.nodes[node].matrix = m.toArray();
        const vals = findProp(xf, '.vals');
        if (vals && !abc.isConstant(vals)) {
          const times: number[] = [],
            values: number[] = [];
          for (let i = 0; i < vals.numSamples; i++) {
            times.push(abc.sampleTime(vals.timeSampling, i));
            values.push(...xformAt(xf, i).m.elements);
          }
          channels.push({ node, path: 'matrix', times, values, interpolation: 'LINEAR' });
        }
      }
      const vis = findProp(o.properties, 'visible');
      if (vis && (abc.sample(vis, 0) as number[] | null)?.[0] === 0) ir.nodes[node].hidden = true;
      if (shape) shapeInto(shape, node);
      for (const c of o.children) if (c !== shape) visit(c, node);
      return;
    }
    if (isShape(o)) {
      const node = ir.nodes.length;
      ir.nodes.push({ name: o.name, parent, matrix: new Matrix4().toArray() });
      shapeInto(o, node);
      for (const c of o.children) if (!/FaceSet/.test(schemaOf(c))) visit(c, node);
      return;
    }
    // unknown object types: keep hierarchy as empties
    const node = ir.nodes.length;
    ir.nodes.push({ name: o.name || 'Object', parent, matrix: new Matrix4().toArray() });
    if (schema) W.push(`"${o.name}": ${schema} objects are not supported`);
    for (const c of o.children) visit(c, node);
  };

  const shapeInto = (o: AbcObject, node: number) => {
    const schema = schemaOf(o);
    const geom = findProp(o.properties, '.geom');
    if (/PolyMesh|SubD/.test(schema) && geom) {
      const mi = readMesh(o, geom, node);
      if (mi !== null) ir.nodes[node].mesh = mi;
      if (/SubD/.test(schema)) W.push(`"${o.name}": subdivision surfaces are imported as their control mesh`);
    } else if (/Camera/.test(schema) && geom) {
      const core = findProp(geom, '.core');
      const v = core ? ((abc.sample(core, 0) as number[] | null) ?? []) : [];
      // focal length (mm), apertures (cm), clipping planes
      ir.nodes[node].camera = {
        type: 'PERSP',
        lens: v[0] || 35,
        sensorWidth: (v[1] || 3.6) * 10,
        sensorHeight: (v[3] || 2.4) * 10,
        sensorFit: 'AUTO',
        clipStart: v[14] || 0.1,
        clipEnd: v[15] || 100000,
        shiftX: v[1] ? (v[2] || 0) / v[1] : 0,
        shiftY: v[3] ? (v[4] || 0) / v[1] : 0,
      };
      if (core && core.numSamples > 1) W.push(`Camera "${o.name}": animated lens settings are imported at the first sample`);
    } else W.push(`"${o.name}": ${schema.replace('AbcGeom_', '')} is not supported`);
  };

  const readMesh = (o: AbcObject, geom: AbcProperty, node: number): number | null => {
    const P = findProp(geom, 'P');
    const fi = findProp(geom, '.faceIndices');
    const fc = findProp(geom, '.faceCounts');
    if (!P || !fi || !fc) return null;
    const pts = abc.sample(P, 0) as number[] | null;
    const idx = abc.sample(fi, 0) as number[] | null;
    const cnt = abc.sample(fc, 0) as number[] | null;
    if (!pts || !idx || !cnt) return null;
    const nv = pts.length / 3;
    // reverse winding (Alembic is clockwise) and remap face-varying data the same way
    const order: number[] = [];
    let c = 0;
    for (const n of cnt) {
      for (let k = 0; k < n; k++) order.push(k === 0 ? c : c + n - k);
      c += n;
    }
    const corners = order.length;
    const fvr = (prop: AbcProperty | undefined, comps: number): Float32Array | undefined => {
      if (!prop) return undefined;
      let valsP = prop,
        indP: AbcProperty | undefined;
      if (prop.kind === 'compound') {
        valsP = findProp(prop, '.vals')!;
        indP = findProp(prop, '.indices');
        if (!valsP) return undefined;
      }
      const vals = abc.sample(valsP, 0) as number[] | null;
      if (!vals) return undefined;
      const ind = indP ? (abc.sample(indP, 0) as number[] | null) : null;
      const scope = valsP.metadata.geoScope ?? prop.metadata.geoScope ?? 'fvr';
      const out = new Float32Array(corners * comps);
      const count = vals.length / comps;
      for (let k = 0; k < corners; k++) {
        const src = order[k];
        let e = scope === 'vtx' || scope === 'var' ? idx[src] : scope === 'uni' ? faceOfCorner(src) : scope === 'con' ? 0 : src;
        if (ind) e = ind[e] ?? 0;
        if (e >= count) e = 0;
        for (let j = 0; j < comps; j++) out[k * comps + j] = vals[e * comps + j];
      }
      return out;
    };
    const faceStarts: number[] = [];
    {
      let s = 0;
      for (const n of cnt) {
        faceStarts.push(s);
        s += n;
      }
    }
    const faceOfCorner = (k: number) => {
      let lo = 0,
        hi = faceStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (faceStarts[mid] <= k) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const uvProp = findProp(geom, 'uv') ?? findProp(geom, 'st');
    const nProp = findProp(geom, 'N');
    const mesh: IRMesh = {
      name: o.name,
      positions: Float32Array.from(pts),
      faceSizes: Uint32Array.from(cnt),
      indices: Uint32Array.from(order, (k) => idx[k]),
      uvs: fvr(uvProp, 2),
      normals: fvr(nProp, 3),
      materials: [],
    };
    if (!mesh.normals) mesh.smooth = new Uint8Array(cnt.length).fill(/SubD/.test(schemaOf(o)) ? 1 : 0);
    // face sets → material slots
    const sets = o.children.filter((c) => /FaceSet/.test(schemaOf(c)));
    if (sets.length) {
      const mat = new Uint16Array(cnt.length);
      sets.forEach((s, si) => {
        const faces = findProp(findProp(s.properties, '.faceset'), '.faces');
        const list = faces ? ((abc.sample(faces, 0) as number[] | null) ?? []) : [];
        let mi = ir.materials.findIndex((m) => m.name === s.name);
        if (mi < 0) {
          mi = ir.materials.length;
          ir.materials.push({ name: s.name, baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 });
        }
        mesh.materials.push(mi);
        for (const f of list) if (f < mat.length) mat[f] = si;
      });
      // faces outside every face set use the first one
      mesh.materialIndex = mat;
    }
    // vertex animation → one shape key per sample with "hat" weights (exact linear interpolation)
    const topoChanges = !abc.isConstant(fi) || !abc.isConstant(fc);
    if (!abc.isConstant(P)) {
      if (topoChanges) W.push(`"${o.name}": changing topology is not supported; the first sample was imported`);
      else if (P.numSamples * nv * 3 > MAX_CACHE_FLOATS) W.push(`"${o.name}": the vertex animation is too large (${P.numSamples} samples); the first sample was imported`);
      else {
        const keys: { name: string; positions: Float32Array }[] = [];
        const times: number[] = [];
        for (let i = 0; i < P.numSamples; i++) {
          const s = abc.sample(P, i) as number[] | null;
          if (!s || s.length !== pts.length) continue;
          keys.push({ name: `Frame ${i + 1}`, positions: Float32Array.from(s) });
          times.push(abc.sampleTime(P.timeSampling, i));
        }
        mesh.shapeKeys = keys;
        const nk = keys.length;
        const values: number[] = [];
        for (let i = 0; i < nk; i++) for (let k = 0; k < nk; k++) values.push(i === k ? 1 : 0);
        channels.push({ node, path: 'weights', times, values, interpolation: 'LINEAR' });
        W.push(`"${o.name}": vertex animation was imported as ${nk} shape keys`);
      }
    }
    const arb = (findProp(geom, '.arbGeomParams')?.children ?? []).map((c) => c.name).filter((n) => n !== 'Pref');
    if (arb.length) W.push(`"${o.name}": geometry parameters ${arb.join(', ')} were not imported`);
    ir.meshes.push(mesh);
    return ir.meshes.length - 1;
  };

  for (const c of abc.top.children) visit(c, -1);
  if (channels.length) ir.animations.push({ name: 'Alembic', channels });
  return ir;
}
