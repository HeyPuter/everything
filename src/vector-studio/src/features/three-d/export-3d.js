/**
 * 3D objects as 3D files: Wavefront OBJ (with an MTL material library) and
 * binary glTF 2.0 (.glb).
 *
 * Every object with a 3D effect contributes its solids (the same meshes
 * the effect draws: caps, sides, bevels, revolved and inflated surfaces),
 * optionally turned to the orientation the effect shows. Coordinates are
 * right-handed with y up; objects keep their places relative to each
 * other, measured from the document origin. Each source shape gets a
 * material from its color and the effect's material settings.
 *
 *   threeDObjects(doc, ids?, rect?) -> nodes with a 3D effect
 *   collectSolids(doc, nodes, { orientation }) -> [{ name, parts }]
 *   writeOBJ(solids, { scale, name }) -> { obj, mtl }
 *   writeGLB(solids, { scale, name }) -> Uint8Array
 */
import { visualBounds } from '../../model/geometry.js';
import { threeDOf } from './params.js';
import { hasThreeD, sourceItems } from './live-kind.js';
import { buildModels } from './scene.js';
import { rotationMatrix, apply3, newellNormal, normalize } from './math.js';
import { baseColorOf, rgbOf } from './shading.js';
import { triangulate } from './triangulate.js';

/** Points to millimeters and meters. */
export const PT_MM = 25.4 / 72;
export const PT_M = 0.0254 / 72;

const overlaps = (a, b) => Boolean(a && b) && a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** Visible objects with a 3D effect: under `ids` (or the whole document), touching `rect` when given. */
export function threeDObjects(doc, ids = null, rect = null) {
  const out = [];
  const visit = (id) => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    if (hasThreeD(n)) {
      if (!rect || overlaps(visualBounds(doc, n), rect)) out.push(n);
      return;
    }
    for (const c of n.children || []) visit(c);
  };
  for (const id of ids?.length ? ids : doc.root.children) visit(id);
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Triangles of one polygon face (3D points, with holes) as flat lists:
 * positions and normals (3 numbers per vertex, 3 vertices per triangle),
 * wound counterclockwise around `n` (the outward normal).
 */
function faceTriangles(outer, holes, n, cornerNormals, out) {
  // Drop the axis the face is most perpendicular to.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const flat = (p) => [p[u], p[v]];
  const pts = [...outer, ...holes.flat()];
  const norms = [...outer.map((_, i) => cornerNormals?.[i] || n), ...holes.flat().map(() => n)];
  for (const [a, b, c] of triangulate(outer.map(flat), holes.map((h) => h.map(flat)))) {
    let tri = [a, b, c];
    const tn = crossV(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    if (dot(tn, n) < 0) tri = [a, c, b];
    for (const k of tri) {
      out.positions.push(pts[k][0], pts[k][1], pts[k][2]);
      out.normals.push(norms[k][0], norms[k][1], norms[k][2]);
    }
  }
}

/**
 * The solids of 3D objects in output space (y up, units: points):
 * [{ name, parts: [{ material: { color [r,g,b] (sRGB 0..1), metallic,
 * roughness, opacity, doubleSided }, positions, normals }] }].
 * opts.orientation: 'view' (as the effect shows it) or 'model' (unturned).
 */
export function collectSolids(doc, nodes, { orientation = 'view' } = {}) {
  const solids = [];
  for (const node of nodes) {
    const fx = threeDOf(node)?.fx;
    const items = fx && sourceItems(doc, node);
    if (!items?.length) continue;
    const scene = buildModels(items, fx);
    if (!scene) continue;
    const R = orientation === 'model' ? rotationMatrix(0, 0, 0) : rotationMatrix(fx.rotX, fx.rotY, fx.rotZ);
    // Model space is y down with z toward the viewer: flip y for a right-handed y-up file.
    const [ox, oy] = scene.origin;
    const place = (p) => {
      const q = apply3(R, p);
      return [q[0] + ox, -(q[1] + oy), q[2]];
    };
    const turn = (nv) => {
      const q = apply3(R, nv);
      return normalize([q[0], -q[1], q[2]]);
    };
    const byMaterial = new Map();
    const partFor = (style, twoSided) => {
      const color = rgbOf(baseColorOf(style, fx.color));
      const material = { color, metallic: fx.metallic ?? 0, roughness: fx.roughness ?? 0.5, opacity: fx.opacity ?? 1, doubleSided: Boolean(twoSided) };
      const key = JSON.stringify(material);
      if (!byMaterial.has(key)) byMaterial.set(key, { material, positions: [], normals: [] });
      return byMaterial.get(key);
    };
    for (const m of scene.models) {
      if (fx.kind === 'rotate') {
        // Flat artwork turned in space: its closed outlines as two-sided faces.
        const part = partFor(m.item.style, true);
        const rings = (m.polys || []).filter((p) => p.closed && p.pts.length >= 3).map((p) => p.pts.map(([x, y]) => place([x - ox, y - oy, 0])));
        const nrm = turn([0, 0, 1]);
        for (const r of rings) faceTriangles(r, [], nrm, null, part);
        continue;
      }
      const mesh = m.mesh;
      const verts = mesh.verts.map(place);
      mesh.faces.forEach((f, fi) => {
        const part = partFor(m.item.style, f.twoSided || !mesh.closed);
        const outer = f.rings[0].map((i) => verts[i]);
        const holes = f.rings.slice(1).map((r) => r.map((i) => verts[i]));
        let n = m.normals[fi] ? turn(m.normals[fi]) : normalize(newellNormal(outer));
        // Smooth faces keep their corner normals; flat ones use the face normal.
        const corners = f.smooth && m.corners?.[fi] ? m.corners[fi].map(turn) : null;
        if (!Number.isFinite(n[0])) n = [0, 0, 1];
        faceTriangles(outer, holes, n, corners, part);
      });
    }
    const parts = [...byMaterial.values()].filter((p) => p.positions.length);
    if (parts.length) solids.push({ name: node.name || `${fx.kind[0].toUpperCase()}${fx.kind.slice(1)} ${solids.length + 1}`, parts });
  }
  return solids;
}

const fmt = (v) => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === '-0' ? '0' : s;
};
const safeName = (s) => String(s || 'Object').replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || 'Object';

/** OBJ text and its MTL material library. opts: { scale (output units per point), name (file stem) } */
export function writeOBJ(solids, { scale = PT_MM, name = 'model' } = {}) {
  const obj = ['# Vector Studio 3D export', `mtllib ${safeName(name)}.mtl`];
  const mtl = ['# Vector Studio materials'];
  const materials = new Map();
  let vBase = 1;
  for (const s of solids) {
    obj.push(`o ${safeName(s.name)}`);
    for (const part of s.parts) {
      const key = JSON.stringify(part.material);
      if (!materials.has(key)) {
        const id = `material_${materials.size + 1}`;
        materials.set(key, id);
        const m = part.material;
        const spec = (1 - m.roughness) * (m.metallic ? 0.9 : 0.5);
        mtl.push('', `newmtl ${id}`, `Kd ${m.color.map(fmt).join(' ')}`, 'Ka 0 0 0', `Ks ${[spec, spec, spec].map(fmt).join(' ')}`, `Ns ${fmt(2 + (1 - m.roughness) ** 2 * 900)}`, `d ${fmt(m.opacity)}`, `Pr ${fmt(m.roughness)}`, `Pm ${fmt(m.metallic)}`, `illum ${m.opacity < 1 ? 4 : 2}`);
      }
      const p = part.positions;
      const nn = part.normals;
      for (let i = 0; i < p.length; i += 3) obj.push(`v ${fmt(p[i] * scale)} ${fmt(p[i + 1] * scale)} ${fmt(p[i + 2] * scale)}`);
      for (let i = 0; i < nn.length; i += 3) obj.push(`vn ${fmt(nn[i])} ${fmt(nn[i + 1])} ${fmt(nn[i + 2])}`);
      obj.push(`usemtl ${materials.get(key)}`);
      const count = p.length / 3;
      for (let k = 0; k < count; k += 3) {
        const a = vBase + k;
        obj.push(`f ${a}//${a} ${a + 1}//${a + 1} ${a + 2}//${a + 2}`);
      }
      vBase += count;
    }
  }
  return { obj: `${obj.join('\n')}\n`, mtl: `${mtl.join('\n')}\n` };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A binary glTF 2.0 file. opts: { scale (meters per point), name } */
export function writeGLB(solids, { scale = PT_M, name = 'model' } = {}) {
  const views = [];
  const accessors = [];
  const chunks = [];
  let offset = 0;
  const addView = (array, target) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return views.length - 1;
  };
  const materials = [];
  const materialIndex = new Map();
  const meshes = [];
  const nodes = [];
  for (const s of solids) {
    const primitives = [];
    for (const part of s.parts) {
      const count = part.positions.length / 3;
      const pos = new Float32Array(part.positions.length);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < part.positions.length; i++) {
        const v = part.positions[i] * scale;
        pos[i] = v;
        const k = i % 3;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      const nrm = Float32Array.from(part.normals);
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count, type: 'VEC3', min: Array.from(new Float32Array(min)), max: Array.from(new Float32Array(max)) });
      const posAcc = accessors.length - 1;
      accessors.push({ bufferView: addView(nrm, 34962), componentType: 5126, count, type: 'VEC3' });
      const nrmAcc = accessors.length - 1;
      accessors.push({ bufferView: addView(idx, 34963), componentType: 5125, count, type: 'SCALAR' });
      const idxAcc = accessors.length - 1;
      const key = JSON.stringify(part.material);
      if (!materialIndex.has(key)) {
        const m = part.material;
        const mat = {
          name: `Material ${materials.length + 1}`,
          pbrMetallicRoughness: { baseColorFactor: [...m.color.map(srgbToLinear), m.opacity], metallicFactor: m.metallic, roughnessFactor: m.roughness },
        };
        if (m.opacity < 1) mat.alphaMode = 'BLEND';
        if (m.doubleSided) mat.doubleSided = true;
        materials.push(mat);
        materialIndex.set(key, materials.length - 1);
      }
      primitives.push({ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc, material: materialIndex.get(key), mode: 4 });
    }
    meshes.push({ name: s.name, primitives });
    nodes.push({ name: s.name, mesh: meshes.length - 1 });
  }
  const gltf = {
    asset: { version: '2.0', generator: 'Vector Studio' },
    scene: 0,
    scenes: [{ name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(json.length + jsonPad).fill(0x20);
    padded.set(json);
    json = padded;
  }
  const total = 12 + 8 + json.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(json, 20);
  let p = 20 + json.length;
  dv.setUint32(p, offset, true);
  dv.setUint32(p + 4, 0x004e4942, true); // BIN
  p += 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
