// USD (USDA text, USDC crate, USDZ package) → IR. Layers are parsed into `specsByPath`
// (text: our own parser; crate: three.js' MIT-licensed USDCParser) and composed here:
// local opinions + sublayers + simple references, xformOps, meshes, UsdPreviewSurface,
// cameras, UsdLux and UsdSkel.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js';
import { emptyScene, Y_UP_TO_Z_UP, type IRChannel, type IRMaterial, type IRMesh, type IRScene, type IRTexRef } from '../ir';
import { baseName, sniffMime, stripExt } from '../common';
import { parseUsda, type SpecsByPath } from './usda';
import { readZip } from './zip';
import * as prim from '../../../mesh/primitives';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface UsdReadOptions {
  /** extra files (textures / sublayers) by base name */
  resources?: Map<string, Uint8Array>;
}

const D2R = Math.PI / 180;

export function isCrate(b: Uint8Array) {
  return b.length > 8 && String.fromCharCode(...b.subarray(0, 8)) === 'PXR-USDC';
}
export function isZip(b: Uint8Array) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
}

/**
 * The crate format inlines small vectors as packed int8 components; normalise any such value the
 * crate reader left as a raw number back into a vector.
 */
function fixInlinedVectors(specs: SpecsByPath) {
  for (const s of Object.values(specs)) {
    if (s.specType !== 1) continue;
    const t = String(s.fields.typeName ?? '');
    const m = /^(?:float|double|half|int|point|normal|vector|color|texCoord)(\d)[fdhi]?$/.exec(t);
    if (!m) continue;
    const n = Number(m[1]);
    const fix = (v: any) => {
      if (typeof v !== 'number') return v;
      const out: number[] = [];
      for (let k = 0; k < n; k++) {
        const b = (v >>> (8 * k)) & 0xff;
        out.push(b > 127 ? b - 256 : b);
      }
      return out;
    };
    if (s.fields.default !== undefined) s.fields.default = fix(s.fields.default);
    if (s.fields.timeSamples?.values) s.fields.timeSamples.values = s.fields.timeSamples.values.map(fix);
  }
}

function parseLayer(bytes: Uint8Array, warnings: string[]): SpecsByPath {
  if (isCrate(bytes)) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    try {
      const specs = (new USDCParser().parseData(ab) as { specsByPath: SpecsByPath }).specsByPath;
      fixInlinedVectors(specs);
      return specs;
    } catch (e) {
      throw new Error(`Cannot read the binary USD (crate) layer: ${e instanceof Error ? e.message : e}`);
    }
  }
  const r = parseUsda(new TextDecoder().decode(bytes));
  warnings.push(...r.warnings);
  return r.specsByPath;
}

/** Files referenced by a USD layer (sublayers, references, textures) that are not inside it. */
export function usdExternalFiles(bytes: Uint8Array): string[] {
  if (isZip(bytes)) return [];
  const warnings: string[] = [];
  let specs: SpecsByPath;
  try {
    specs = parseLayer(bytes, warnings);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const [path, s] of Object.entries(specs)) {
    if (s.fields.typeName === 'asset' && typeof s.fields.default === 'string' && path.endsWith('.inputs:file')) out.add(baseName(s.fields.default));
    for (const r of s.fields.references ?? []) if (r?.asset) out.add(baseName(r.asset));
  }
  for (const l of specs['/']?.fields.subLayers ?? []) if (l?.asset) out.add(baseName(l.asset));
  return [...out].filter(Boolean);
}

export function readUsd(bytes: Uint8Array, opts: UsdReadOptions = {}): IRScene {
  const ir = emptyScene();
  const W = ir.warnings;
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of opts.resources ?? []) files.set(baseName(k).toLowerCase(), v);
  let rootBytes = bytes;
  if (isZip(bytes)) {
    const entries = readZip(bytes);
    const root = entries.find((e) => /\.(usd|usda|usdc)$/i.test(e.name));
    if (!root) throw new Error('The USDZ package contains no USD layer');
    rootBytes = root.data;
    for (const e of entries) {
      files.set(e.name.toLowerCase(), e.data);
      files.set(baseName(e.name).toLowerCase(), e.data);
    }
  }
  const findFile = (p: string) => files.get(p.replace(/^\.\//, '').toLowerCase()) ?? files.get(baseName(p).toLowerCase()) ?? null;
  const specs = parseLayer(rootBytes, W);

  // ------------------------------------------------------------ composition (sublayers + references)
  const layerCache = new Map<string, SpecsByPath>();
  const loadLayer = (asset: string): SpecsByPath | null => {
    if (layerCache.has(asset)) return layerCache.get(asset)!;
    const b = findFile(asset);
    if (!b) return null;
    const l = parseLayer(b, W);
    layerCache.set(asset, l);
    return l;
  };
  const mergeWeak = (into: SpecsByPath, from: SpecsByPath, fromRoot: string, toRoot: string) => {
    for (const [p, s] of Object.entries(from)) {
      if (p === '/' || !(p === fromRoot || p.startsWith(`${fromRoot}/`) || p.startsWith(`${fromRoot}.`))) continue;
      const np = toRoot + p.slice(fromRoot.length);
      const ex = into[np];
      const fields = { ...s.fields };
      // remap target/connection paths inside the grafted subtree
      const remap = (t: string) => (t.startsWith(fromRoot) ? toRoot + t.slice(fromRoot.length) : t);
      if (fields.targetPaths) fields.targetPaths = fields.targetPaths.map(remap);
      if (fields.connectionPaths) fields.connectionPaths = fields.connectionPaths.map(remap);
      if (!ex) into[np] = { specType: s.specType, fields };
      else {
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'primChildren' || k === 'properties') ex.fields[k] = [...new Set([...(ex.fields[k] ?? []), ...(v as string[])])];
          else if (!(k in ex.fields)) ex.fields[k] = v;
        }
      }
    }
  };
  for (const sub of specs['/']?.fields.subLayers ?? []) {
    const asset = sub?.asset ?? sub;
    const l = typeof asset === 'string' ? loadLayer(asset) : null;
    if (l) {
      mergeWeak(specs, l, '', '');
      specs['/'].fields.primChildren = [...new Set([...(specs['/'].fields.primChildren ?? []), ...(l['/']?.fields.primChildren ?? [])])];
    } else W.push(`Sublayer ${asset} was not found`);
  }
  let refDepth = 0;
  const resolveRefs = () => {
    let changed = true;
    while (changed && refDepth++ < 8) {
      changed = false;
      for (const [p, s] of Object.entries(specs)) {
        const refs = s.fields.references;
        if (s.specType !== 6 || !refs?.length || s.fields.__refsDone) continue;
        s.fields.__refsDone = true;
        for (const r of refs as any[]) {
          const asset = typeof r === 'object' ? r.asset : undefined;
          const target = typeof r === 'object' ? r.primPath : undefined;
          const layer = asset ? loadLayer(asset) : specs;
          if (!layer) {
            W.push(`Referenced file ${asset} was not found`);
            continue;
          }
          const src = target ?? (layer['/']?.fields.defaultPrim ? `/${layer['/'].fields.defaultPrim}` : `/${layer['/']?.fields.primChildren?.[0] ?? ''}`);
          if (!layer[src]) {
            W.push(`Reference target ${src} was not found`);
            continue;
          }
          mergeWeak(specs, layer, src, p);
          changed = true;
        }
      }
    }
  };
  resolveRefs();

  // ------------------------------------------------------------ stage metadata
  const root = specs['/']?.fields ?? {};
  const upAxis = String(root.upAxis ?? 'Y');
  const mpu = Number(root.metersPerUnit ?? 0.01);
  ir.axis = upAxis === 'Z' ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : Y_UP_TO_Z_UP;
  ir.unitScale = mpu > 0 ? mpu : 1;
  ir.unitScaleMode = 'ROOT';
  const tcps = Number(root.timeCodesPerSecond ?? root.framesPerSecond ?? 24) || 24;
  if (root.upAxis === undefined) W.push('The stage does not declare upAxis; assuming Y-up');

  const attr = (path: string, name: string) => specs[`${path}.${name}`]?.fields;
  const val = (path: string, name: string, d?: any) => {
    const f = attr(path, name);
    if (!f) return d;
    if (f.default !== undefined && f.default !== null) return f.default;
    if (f.timeSamples?.values?.length) return f.timeSamples.values[0];
    return d;
  };
  const rel = (path: string, name: string): string[] => specs[`${path}.${name}`]?.fields.targetPaths ?? [];
  const typeOf = (path: string) => String(specs[path]?.fields.typeName ?? '');
  const childPaths = (path: string) => ((specs[path]?.fields.primChildren ?? []) as string[]).map((c) => (path === '/' ? `/${c}` : `${path}/${c}`)).filter((c) => specs[c]);


  // ------------------------------------------------------------ transforms
  const opMatrix = (path: string, op: string, t?: number): Matrix4 => {
    const inv = op.startsWith('!invert!');
    const name = inv ? op.slice(8) : op;
    const f = attr(path, name);
    let v = f ? (t !== undefined && f.timeSamples?.times?.length ? sampleAttr(f, t) : (f.default ?? f.timeSamples?.values?.[0])) : undefined;
    const kind = name.split(':')[1] ?? '';
    const m = new Matrix4();
    if (v === undefined || v === null) return m;
    if (ArrayBuffer.isView(v)) v = Array.from(v as Float64Array);
    if (kind === 'translate') m.makeTranslation(v[0], v[1], v[2]);
    else if (kind === 'scale') m.makeScale(...((typeof v === 'number' ? [v, v, v] : v) as [number, number, number]));
    else if (kind === 'rotateX') m.makeRotationX(v * D2R);
    else if (kind === 'rotateY') m.makeRotationY(v * D2R);
    else if (kind === 'rotateZ') m.makeRotationZ(v * D2R);
    else if (/^rotate[XYZ]{3}$/.test(kind)) {
      const order = kind.slice(6).split('').reverse().join('') as Euler['order'];
      m.makeRotationFromEuler(new Euler(v[0] * D2R, v[1] * D2R, v[2] * D2R, order));
    } else if (kind === 'orient') m.makeRotationFromQuaternion(new Quaternion(v[0], v[1], v[2], v[3]).normalize());
    else if (kind === 'transform') m.fromArray(v);
    return inv ? m.invert() : m;
  };
  const localMatrix = (path: string, t?: number): Matrix4 => {
    const order = (val(path, 'xformOpOrder') ?? []) as string[];
    const m = new Matrix4();
    for (const op of order) {
      if (op === '!resetXformStack!') {
        m.identity();
        resetStack.add(path);
        continue;
      }
      m.multiply(opMatrix(path, op, t));
    }
    return m;
  };
  const resetStack = new Set<string>();
  const animatedTimes = (path: string): number[] => {
    const order = (val(path, 'xformOpOrder') ?? []) as string[];
    const set = new Set<number>();
    for (const op of order) {
      const f = attr(path, op.replace('!invert!', ''));
      for (const t of f?.timeSamples?.times ?? []) set.add(Number(t));
    }
    return [...set].sort((a, b) => a - b);
  };

  // ------------------------------------------------------------ materials
  const matIndex = new Map<string, number>();
  const imageIndex = new Map<string, number>();
  const imageFor = (file: string): number => {
    const key = file.toLowerCase();
    if (imageIndex.has(key)) return imageIndex.get(key)!;
    const b = findFile(file);
    const idx = ir.images.length;
    ir.images.push({ name: stripExt(baseName(file)), mime: b ? sniffMime(b, file) : '', bytes: b, uri: file });
    imageIndex.set(key, idx);
    return idx;
  };
  const connectedShader = (path: string, name: string): { shader: string; output: string } | null => {
    const c = attr(path, name)?.connectionPaths?.[0] as string | undefined;
    if (!c) return null;
    const [sp, out] = c.split('.');
    return { shader: sp, output: out ?? '' };
  };
  const texInput = (shaderPath: string, input: string): (IRTexRef & { scaleFactor?: number[] }) | null => {
    const c = connectedShader(shaderPath, input);
    if (!c) return null;
    let tex = c.shader;
    // follow through simple passthrough shaders (e.g. UsdTransform2d chains are on the st input)
    if (val(tex, 'info:id') !== 'UsdUVTexture') return null;
    const file = val(tex, 'inputs:file');
    if (typeof file !== 'string' || !file) return null;
    const out = c.output.replace('outputs:', '');
    const ref: IRTexRef & { scaleFactor?: number[] } = {
      image: imageFor(file),
      channel: out === 'r' ? 'R' : out === 'g' ? 'G' : out === 'b' ? 'B' : out === 'a' ? 'A' : 'RGB',
      extension: ({ clamp: 'EXTEND', mirror: 'MIRROR', black: 'CLIP' } as Record<string, IRTexRef['extension']>)[String(val(tex, 'inputs:wrapS', 'repeat'))] ?? 'REPEAT',
    };
    const sc = val(tex, 'inputs:scale');
    if (sc) ref.scaleFactor = Array.from(sc as number[]);
    // texture transform
    const st = connectedShader(tex, 'inputs:st');
    if (st && val(st.shader, 'info:id') === 'UsdTransform2d') {
      const scale = (val(st.shader, 'inputs:scale', [1, 1]) as number[]).map(Number);
      const tr = (val(st.shader, 'inputs:translation', [0, 0]) as number[]).map(Number);
      const rot = Number(val(st.shader, 'inputs:rotation', 0));
      // bottom-left (USD) → top-left (glTF-style IR) conventions
      if (scale[0] !== 1 || scale[1] !== 1) ref.scale = [scale[0], scale[1]];
      if (tr[0] || tr[1] || scale[1] !== 1) ref.offset = [tr[0], 1 - scale[1] - tr[1]];
      if (rot) ref.rotation = -rot * D2R;
    }
    return ref;
  };
  const materialFor = (mpath: string): number => {
    if (matIndex.has(mpath)) return matIndex.get(mpath)!;
    const name = String(val(mpath, 'userProperties:name') ?? mpath.split('/').pop() ?? 'Material');
    const mat: IRMaterial = { name, baseColor: [0.18, 0.18, 0.18, 1], metallic: 0, roughness: 0.5 };
    let surf = connectedShader(mpath, 'outputs:surface')?.shader;
    if (!surf) for (const c of childPaths(mpath)) if (val(c, 'info:id') === 'UsdPreviewSurface') surf = c;
    if (!surf || val(surf, 'info:id') !== 'UsdPreviewSurface') W.push(`Material "${name}" does not use UsdPreviewSurface; default settings were used`);
    else {
      const num = (n: string, d: number) => Number(val(surf!, `inputs:${n}`, d));
      const dc = val(surf, 'inputs:diffuseColor', [0.18, 0.18, 0.18]) as number[];
      mat.baseColor = [dc[0], dc[1], dc[2], num('opacity', 1)];
      mat.metallic = num('metallic', 0);
      mat.roughness = num('roughness', 0.5);
      mat.ior = num('ior', 1.5);
      const ec = val(surf, 'inputs:emissiveColor') as number[] | undefined;
      if (ec && (ec[0] || ec[1] || ec[2])) {
        mat.emissive = [ec[0], ec[1], ec[2]];
        mat.emissiveStrength = 1;
      }
      const cc = num('clearcoat', 0);
      if (cc) {
        mat.clearcoat = cc;
        mat.clearcoatRoughness = num('clearcoatRoughness', 0.01);
      }
      const base = texInput(surf, 'inputs:diffuseColor');
      if (base) {
        mat.baseColorTex = base;
        mat.baseColor = [1, 1, 1, mat.baseColor[3]];
        if (base.scaleFactor) mat.baseColor = [base.scaleFactor[0], base.scaleFactor[1], base.scaleFactor[2], mat.baseColor[3]];
      }
      const metal = texInput(surf, 'inputs:metallic');
      if (metal) mat.metallicTex = { ...metal, channel: metal.channel === 'RGB' ? 'R' : metal.channel };
      const rough = texInput(surf, 'inputs:roughness');
      if (rough) mat.roughnessTex = { ...rough, channel: rough.channel === 'RGB' ? 'R' : rough.channel };
      const op = texInput(surf, 'inputs:opacity');
      if (op) {
        if (base && op.image === base.image && op.channel === 'A') mat.alphaMode = 'BLEND';
        else mat.alphaTex = op;
        mat.alphaMode = 'BLEND';
      }
      if (mat.baseColor[3] < 1) mat.alphaMode = 'BLEND';
      const thr = attr(surf, 'inputs:opacityThreshold') ? num('opacityThreshold', 0) : 0;
      if (thr > 0) {
        mat.alphaMode = 'MASK';
        mat.alphaCutoff = thr;
      }
      const nrm = texInput(surf, 'inputs:normal');
      if (nrm) mat.normalTex = { ...nrm, channel: 'RGB', strength: 1 };
      const em = texInput(surf, 'inputs:emissiveColor');
      if (em) {
        mat.emissiveTex = em;
        mat.emissive = [1, 1, 1];
      }
      if (connectedShader(surf, 'inputs:occlusion')) W.push(`Material "${name}": ambient occlusion textures are not supported and were ignored`);
      if (Number(val(surf, 'inputs:useSpecularWorkflow', 0))) W.push(`Material "${name}": the specular workflow is approximated with metallic/roughness`);
    }
    const idx = ir.materials.length;
    ir.materials.push(mat);
    matIndex.set(mpath, idx);
    return idx;
  };
  const boundMaterial = (path: string): string | null => {
    for (let p = path; p && p !== '/'; p = p.slice(0, p.lastIndexOf('/')) || '/') {
      const t = rel(p, 'material:binding')[0] ?? rel(p, 'material:binding:preview')[0];
      if (t) return t;
    }
    return null;
  };

  // ------------------------------------------------------------ nodes
  const nodeOf = new Map<string, number>();
  const skeletons: { path: string; node: number; joints: string[]; jointNodes: number[]; bind: Matrix4[] }[] = [];
  const skinnedMeshes: { path: string; node: number; mesh: number }[] = [];
  const addNode = (path: string, parent: number, matrix: Matrix4, name?: string): number => {
    const idx = ir.nodes.length;
    ir.nodes.push({ name: name ?? String(val(path, 'userProperties:name') ?? path.split('/').pop()), parent, matrix: matrix.toArray() });
    nodeOf.set(path, idx);
    return idx;
  };
  const SKIP = new Set(['Material', 'Shader', 'NodeGraph', 'GeomSubset', 'BlendShape', 'SkelAnimation']);
  const LIGHTS = new Set(['SphereLight', 'DistantLight', 'RectLight', 'DiskLight', 'CylinderLight', 'DomeLight', 'DomeLight_1', 'PortalLight']);
  const DATA = new Set(['Mesh', 'Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane', 'Camera', ...LIGHTS]);
  const visit = (path: string, parent: number) => {
    const s = specs[path];
    if (!s || s.specType !== 6) return;
    const type = typeOf(path);
    if (s.fields.specifier === 2) return; // class
    if (s.fields.specifier === 1 && !type) return; // over without def
    if (s.fields.active === false) return;
    if (SKIP.has(type)) return;
    // scopes that only hold materials/shaders (e.g. "_materials", "Looks") are not objects
    if (
      (type === 'Scope' || type === '') &&
      childPaths(path).length &&
      childPaths(path).every(
        (c) => ['Material', 'Shader', 'NodeGraph', 'Scope'].includes(typeOf(c)) && (typeOf(c) !== 'Scope' || childPaths(c).every((g) => ['Material', 'Shader', 'NodeGraph'].includes(typeOf(g)))),
      )
    )
      return;
    const purpose = val(path, 'purpose');
    if (purpose === 'guide' || purpose === 'proxy') return;
    // an Xform holding exactly one data prim (or one named like itself) becomes a single object
    if ((type === 'Xform' || type === '' || type === 'SkelRoot') && !collapsed.has(path)) {
      const kids = childPaths(path).filter((c) => !SKIP.has(typeOf(c)) && specs[c].fields.active !== false && !isTrivialSkeleton(c));
      const data = kids.filter((c) => DATA.has(typeOf(c)) && !childPaths(c).some((g) => !SKIP.has(typeOf(g))));
      const self = data.length === 1 && (kids.length === 1 || data[0].split('/').pop() === path.split('/').pop()) ? data[0] : null;
      if (self) {
        collapsed.add(self);
        collapsedInto.set(path, self);
        const node = visitData(self, parent, localMatrix(path).multiply(localMatrix(self)), String(val(path, 'userProperties:name') ?? path.split('/').pop()));
        nodeOf.set(path, node);
        if (val(path, 'visibility') === 'invisible') ir.nodes[node].hidden = true;
        for (const c of childPaths(path)) if (c !== self) visit(c, node);
        return;
      }
    }
    if (type === 'Skeleton' && isTrivialSkeleton(path)) {
      trivialSkeletons.push(path);
      return;
    }
    let node: number;
    const twinSkel =
      type === 'SkelRoot' || type === 'Xform' ? childPaths(path).find((c) => typeOf(c) === 'Skeleton' && c.split('/').pop() === path.split('/').pop() && !isTrivialSkeleton(c)) : undefined;
    if (twinSkel) {
      // SkelRoot + same-named Skeleton → one armature object (joints hang directly below it)
      node = addNode(path, parent, localMatrix(path).multiply(localMatrix(twinSkel)));
      nodeOf.set(twinSkel, node);
      readSkeleton(twinSkel, node);
      if (val(path, 'visibility') === 'invisible') ir.nodes[node].hidden = true;
      for (const c of childPaths(path)) if (c !== twinSkel) visit(c, node);
      return;
    }
    if (DATA.has(type)) node = visitData(path, parent, localMatrix(path));
    else if (type === 'Skeleton') {
      node = addNode(path, parent, localMatrix(path));
      readSkeleton(path, node);
    } else if (['Points', 'BasisCurves', 'NurbsCurves', 'NurbsPatch', 'PointInstancer', 'HermiteCurves', 'TetMesh'].includes(type)) {
      W.push(`"${path}": ${type} prims are not supported and were skipped`);
      return;
    } else node = addNode(path, parent, localMatrix(path));
    if (val(path, 'visibility') === 'invisible') ir.nodes[node].hidden = true;
    for (const c of childPaths(path)) visit(c, node);
  };
  const collapsed = new Set<string>();
  const collapsedInto = new Map<string, string>();
  const trivialSkeletons: string[] = [];
  function isTrivialSkeleton(path: string) {
    if (typeOf(path) !== 'Skeleton') return false;
    const joints = (val(path, 'joints') ?? []) as string[];
    if (joints.length !== 1) return false;
    const isId = (a: ArrayLike<number> | undefined) => !a || Array.from(a).every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
    if (!isId(val(path, 'bindTransforms')) || !isId(val(path, 'restTransforms'))) return false;
    const anim = rel(path, 'skel:animationSource')[0];
    return !anim || !['translations', 'rotations', 'scales'].some((n) => attr(anim, n)?.timeSamples?.times?.length);
  }
  function visitData(path: string, parent: number, matrix: Matrix4, name?: string): number {
    const type = typeOf(path);
    let node: number;
    if (type === 'Mesh' || type === 'Cube' || type === 'Sphere' || type === 'Cylinder' || type === 'Cone' || type === 'Capsule' || type === 'Plane') {
      node = addNode(path, parent, matrix, name);
      const mi = type === 'Mesh' ? readMesh(path) : implicitMesh(path, type);
      if (mi !== null) {
        ir.nodes[node].mesh = mi;
        if (val(path, 'primvars:skel:jointIndices') !== undefined && !attr(path, 'skel:blendShapes')?.default?.length) skinnedMeshes.push({ path, node, mesh: mi });
        else if (val(path, 'primvars:skel:jointIndices') !== undefined) skinnedMeshes.push({ path, node, mesh: mi });
      }
    } else if (type === 'Camera') {
      node = addNode(path, parent, matrix, name);
      const proj = String(val(path, 'projection', 'perspective'));
      const k = 100 * ir.unitScale;
      const ha = Number(val(path, 'horizontalAperture', 20.955)),
        va = Number(val(path, 'verticalAperture', 15.2908));
      const cr = (val(path, 'clippingRange', [1, 1000000]) as number[]).map(Number);
      ir.nodes[node].camera =
        proj === 'orthographic'
          ? { type: 'ORTHO', orthoScale: Math.max(ha, va), clipStart: cr[0], clipEnd: cr[1], scaleClip: true }
          : {
              type: 'PERSP',
              lens: Number(val(path, 'focalLength', 50)) * k,
              sensorWidth: ha * k,
              sensorHeight: va * k,
              sensorFit: 'HORIZONTAL',
              clipStart: cr[0],
              clipEnd: cr[1],
              scaleClip: true,
              shiftX: Number(val(path, 'horizontalApertureOffset', 0)) / ha || 0,
              shiftY: Number(val(path, 'verticalApertureOffset', 0)) / ha || 0,
            };
    } else {
      node = addNode(path, parent, matrix, name);
      const inp = (n: string, d: number) => Number(val(path, `inputs:${n}`, val(path, n, d)));
      const c = (val(path, 'inputs:color', val(path, 'color', [1, 1, 1])) as number[]).map(Number) as [number, number, number];
      const intensity = inp('intensity', 1) * 2 ** inp('exposure', 0);
      if (type === 'DistantLight') ir.nodes[node].light = { type: 'SUN', color: c, energy: intensity * 4 };
      else if (type === 'RectLight')
        ir.nodes[node].light = {
          type: 'AREA',
          color: c,
          energy: intensity * Math.PI,
          size: inp('width', 1),
          sizeY: inp('height', 1),
          shape: inp('width', 1) === inp('height', 1) ? 'SQUARE' : 'RECTANGLE',
        };
      else if (type === 'DiskLight') ir.nodes[node].light = { type: 'AREA', color: c, energy: intensity * Math.PI, size: inp('radius', 0.5) * 2, shape: 'DISK' };
      else if (type === 'SphereLight' || type === 'CylinderLight') {
        const cone = attr(path, 'inputs:shaping:cone:angle') || attr(path, 'shaping:cone:angle');
        const angle = inp('shaping:cone:angle', 90);
        ir.nodes[node].light =
          cone && angle < 90
            ? { type: 'SPOT', color: c, energy: intensity * Math.PI, spotSize: 2 * angle * D2R, spotBlend: inp('shaping:cone:softness', 0), radius: inp('radius', 0.5) }
            : { type: 'POINT', color: c, energy: intensity * Math.PI, radius: val(path, 'treatAsPoint') ? 0 : inp('radius', 0.5) };
        if (type === 'CylinderLight') W.push(`Light "${path}": cylinder lights are imported as point lights`);
      } else W.push(`Light "${path}" (${type}) is not supported; environment/dome lights are not imported`);
    }
    return node;
  }

  function readMesh(path: string): number | null {
    const P = val(path, 'points');
    const counts = val(path, 'faceVertexCounts');
    const idx = val(path, 'faceVertexIndices');
    if (!P || !counts || !idx) return null;
    const positions = Float32Array.from(P as ArrayLike<number>);
    let faceSizes = Uint32Array.from(counts as ArrayLike<number>);
    let indices = Uint32Array.from(idx as ArrayLike<number>);
    if (attr(path, 'points')?.timeSamples?.times?.length > 1) W.push(`"${path}": animated points (vertex caches) are imported at the first sample only`);
    const nc = indices.length,
      nf = faceSizes.length,
      nv = positions.length / 3;
    const faceStart = new Uint32Array(nf + 1);
    for (let f = 0; f < nf; f++) faceStart[f + 1] = faceStart[f] + faceSizes[f];
    const cornerFace = new Uint32Array(nc);
    for (let f = 0; f < nf; f++) for (let c = faceStart[f]; c < faceStart[f + 1]; c++) cornerFace[c] = f;
    // primvar expansion to per-corner
    const primvar = (name: string, comps: number): Float32Array | null => {
      const f = attr(path, name);
      if (!f) return null;
      const data = f.default ?? f.timeSamples?.values?.[0];
      if (!data || !(data as ArrayLike<number>).length) return null;
      const ind = val(path, `${name}:indices`) as ArrayLike<number> | undefined;
      const interp = String(f.interpolation ?? (name === 'normals' ? 'vertex' : 'vertex'));
      const out = new Float32Array(nc * comps);
      const n = (data as ArrayLike<number>).length / comps;
      for (let c = 0; c < nc; c++) {
        let e = interp === 'faceVarying' ? c : interp === 'uniform' ? cornerFace[c] : interp === 'constant' ? 0 : indices[c];
        if (ind) e = ind[e] ?? 0;
        if (e >= n) e = 0;
        for (let k = 0; k < comps; k++) out[c * comps + k] = Number((data as ArrayLike<number>)[e * comps + k]);
      }
      return out;
    };
    const normals = primvar('primvars:normals', 3) ?? primvar('normals', 3);
    const props: string[] = specs[path].fields.properties ?? [];
    const uvName =
      ['primvars:st', 'primvars:UVMap', 'primvars:uv', 'primvars:st0', 'primvars:map1'].find((n) => attr(path, n)) ??
      props.map((p) => `${p}`).find((p) => p.startsWith('primvars:') && !p.endsWith(':indices') && /texCoord2|float2/.test(String(attr(path, p)?.typeName)));
    const uvs = uvName ? primvar(uvName, 2) : null;
    let colors: IRMesh['colors'];
    const dc = attr(path, 'primvars:displayColor');
    if (dc && dc.interpolation && dc.interpolation !== 'constant') {
      const c3 = primvar('primvars:displayColor', 3);
      if (c3) {
        const d = new Float32Array(nc * 4);
        for (let c = 0; c < nc; c++) d.set([c3[c * 3], c3[c * 3 + 1], c3[c * 3 + 2], 1], c * 4);
        colors = [{ name: 'displayColor', domain: 'CORNER', data: d }];
      }
    }
    for (const p of props) {
      if (!p.startsWith('primvars:') || p === 'primvars:displayColor' || p.endsWith(':indices')) continue;
      if (!/^color3[fhd]\[\]$/.test(String(attr(path, p)?.typeName))) continue;
      const c3 = primvar(p, 3);
      if (!c3) continue;
      const d = new Float32Array(nc * 4);
      for (let c = 0; c < nc; c++) d.set([c3[c * 3], c3[c * 3 + 1], c3[c * 3 + 2], 1], c * 4);
      (colors ??= []).push({ name: p.slice(9), domain: 'CORNER', data: d });
    }
    // holes and orientation
    const holes = new Set(Array.from((val(path, 'holeIndices') ?? []) as ArrayLike<number>));
    const leftHanded = val(path, 'orientation') === 'leftHanded';
    // materials: subsets
    const slots: number[] = [];
    const faceMat = new Uint16Array(nf);
    const slotOf = (mpath: string | null) => {
      const mi = mpath ? materialFor(mpath) : -1;
      let s = slots.indexOf(mi);
      if (s < 0) {
        s = slots.length;
        slots.push(mi);
      }
      return s;
    };
    const meshMat = boundMaterial(path);
    const subsets = childPaths(path).filter((c) => typeOf(c) === 'GeomSubset' && val(c, 'familyName', 'materialBind') === 'materialBind' && val(c, 'elementType', 'face') === 'face');
    if (meshMat || subsets.length) {
      const UNSET = 0xffff;
      faceMat.fill(UNSET);
      for (const sub of subsets) {
        const t = rel(sub, 'material:binding')[0];
        if (!t) continue;
        const s = slotOf(t);
        for (const f of Array.from((val(sub, 'indices') ?? []) as ArrayLike<number>)) if (f < nf) faceMat[f] = s;
      }
      // faces outside every subset use the mesh binding (or an empty slot)
      if (faceMat.some((v) => v === UNSET)) {
        const def = slotOf(meshMat);
        for (let f = 0; f < nf; f++) if (faceMat[f] === UNSET) faceMat[f] = def;
      }
    }
    // assemble (drop holes, flip winding)
    const keepFaces: number[] = [];
    for (let f = 0; f < nf; f++) if (!holes.has(f)) keepFaces.push(f);
    const cornerMap: number[] = [];
    const sizes: number[] = [];
    for (const f of keepFaces) {
      sizes.push(faceSizes[f]);
      const cs = Array.from({ length: faceSizes[f] }, (_, k) => faceStart[f] + k);
      if (leftHanded) cs.reverse();
      cornerMap.push(...cs);
    }
    const pick = (src: Float32Array | null, comps: number) => {
      if (!src) return undefined;
      const out = new Float32Array(cornerMap.length * comps);
      cornerMap.forEach((c, i) => out.set(src.subarray(c * comps, c * comps + comps), i * comps));
      return out;
    };
    indices = Uint32Array.from(cornerMap, (c) => indices[c]);
    faceSizes = Uint32Array.from(sizes);
    for (const i of indices) if (i >= nv) throw new Error(`Mesh ${path} has a face index outside its points`);
    const mesh: IRMesh = {
      name: path.split('/').pop() || 'Mesh',
      positions,
      faceSizes,
      indices,
      normals: pick(normals, 3),
      uvs: pick(uvs, 2),
      materialIndex: Uint16Array.from(keepFaces, (f) => faceMat[f]),
      materials: slots,
      colors: colors?.map((c) => ({ ...c, data: pick(c.data, 4)! })),
    };
    if (!normals && !leftHanded) mesh.smooth = new Uint8Array(faceSizes.length).fill(val(path, 'subdivisionScheme', 'catmullClark') === 'none' ? 0 : 1);
    if (!slots.length) {
      // constant displayColor as a material
      const c = val(path, 'primvars:displayColor') as number[] | undefined;
      if (c && c.length >= 3 && (!dc?.interpolation || dc.interpolation === 'constant')) {
        ir.materials.push({ name: `${mesh.name}_displayColor`, baseColor: [c[0], c[1], c[2], 1], metallic: 0, roughness: 0.5 });
        mesh.materials = [ir.materials.length - 1];
      }
    }
    // blend shapes
    const shapeNames = (val(path, 'skel:blendShapes') ?? []) as string[];
    const targets = rel(path, 'skel:blendShapeTargets');
    if (shapeNames.length && targets.length) {
      mesh.shapeKeys = shapeNames.map((name, k) => {
        const t = targets[k];
        const pos = new Float32Array(positions);
        const off = (val(t, 'offsets') ?? []) as ArrayLike<number>;
        const pi = val(t, 'pointIndices') as ArrayLike<number> | undefined;
        const count = off.length / 3;
        for (let i = 0; i < count; i++) {
          const v = pi ? pi[i] : i;
          if (v >= nv) continue;
          pos[v * 3] += off[i * 3];
          pos[v * 3 + 1] += off[i * 3 + 1];
          pos[v * 3 + 2] += off[i * 3 + 2];
        }
        return { name, positions: pos };
      });
    }
    ir.meshes.push(mesh);
    return ir.meshes.length - 1;
  }

  function implicitMesh(path: string, type: string): number | null {
    let arrays: ReturnType<typeof prim.cube>;
    const axis = String(val(path, 'axis', 'Z'));
    if (type === 'Cube') arrays = prim.cube(Number(val(path, 'size', 2)));
    else if (type === 'Sphere') arrays = prim.uvSphere(32, 16, Number(val(path, 'radius', 1)));
    else if (type === 'Cylinder' || type === 'Capsule') arrays = prim.cylinder(32, Number(val(path, 'radius', 1)), Number(val(path, 'height', 2)));
    else if (type === 'Cone') arrays = prim.cone(32, Number(val(path, 'radius', 1)), 0, Number(val(path, 'height', 2)));
    else arrays = prim.plane(Number(val(path, 'width', 2)));
    if (type === 'Capsule') W.push(`"${path}": capsules are imported as cylinders`);
    let pos = arrays.positions;
    if (axis !== 'Z' && type !== 'Cube' && type !== 'Sphere') {
      pos = Float32Array.from(pos);
      for (let i = 0; i < pos.length; i += 3) {
        const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
        if (axis === 'X') [pos[i], pos[i + 1], pos[i + 2]] = [z, x, y];
        else [pos[i], pos[i + 1], pos[i + 2]] = [y, z, x];
      }
    }
    const nf = arrays.offsets.length - 1;
    const mesh: IRMesh = {
      name: path.split('/').pop() || type,
      positions: pos,
      faceSizes: Uint32Array.from({ length: nf }, (_, f) => arrays.offsets[f + 1] - arrays.offsets[f]),
      indices: arrays.indices,
      uvs: arrays.uvs,
      smooth: new Uint8Array(nf).fill(type === 'Cube' ? 0 : 1),
      materials: [],
    };
    const m = boundMaterial(path);
    if (m) {
      mesh.materials = [materialFor(m)];
      mesh.materialIndex = new Uint16Array(nf);
    }
    ir.meshes.push(mesh);
    return ir.meshes.length - 1;
  }

  function readSkeleton(path: string, node: number) {
    const joints = ((val(path, 'joints') ?? []) as string[]).map(String);
    const rest = val(path, 'restTransforms') as ArrayLike<number> | undefined;
    const bind = val(path, 'bindTransforms') as ArrayLike<number> | undefined;
    const mat = (a: ArrayLike<number> | undefined, i: number) => (a && a.length >= (i + 1) * 16 ? new Matrix4().fromArray(Array.from(a).slice(i * 16, i * 16 + 16)) : null);
    const bindM = joints.map((_, i) => mat(bind, i) ?? new Matrix4());
    const restLocal = joints.map((j, i) => {
      const r = mat(rest, i);
      if (r) return r;
      // derive from bind transforms
      const parent = joints.indexOf(j.includes('/') ? j.slice(0, j.lastIndexOf('/')) : '');
      return parent >= 0 ? bindM[parent].clone().invert().multiply(bindM[i]) : bindM[i].clone();
    });
    const jointNodes: number[] = [];
    joints.forEach((j, i) => {
      const parentJoint = j.includes('/') ? joints.indexOf(j.slice(0, j.lastIndexOf('/'))) : -1;
      const n = ir.nodes.length;
      ir.nodes.push({ name: j.split('/').pop() || `joint${i}`, parent: parentJoint >= 0 ? jointNodes[parentJoint] : node, matrix: restLocal[i].toArray(), isBone: true });
      jointNodes.push(n);
    });
    const lengths = val(path, 'primvars:blender:bone_lengths') as ArrayLike<number> | undefined;
    if (lengths?.length === joints.length) jointNodes.forEach((n, i) => (ir.nodes[n].boneLength = Number(lengths[i])));
    skeletons.push({ path, node, joints, jointNodes, bind: bindM });
  }

  // exporter-generated wrapper roots (identity, marked or documented as generated) are not imported
  const rootPrims = childPaths('/');
  const isGeneratedRoot = (p: string) => {
    const f = specs[p]?.fields ?? {};
    if ((val(p, 'xformOpOrder') ?? []).length) return false;
    if (`/${root.defaultPrim}` !== p && rootPrims.length > 1) return false;
    const cd = f.customData ?? {};
    // any exporter's "generated" marker dictionary, or a stage documented as written by an application ("App v1.2")
    if (Object.values(cd as Record<string, unknown>).some((d) => !!(d as { generated?: unknown } | null)?.generated)) return true;
    return /^(\S+ v\d+\.\d+|Puter 3D)/.test(String(root.documentation ?? root.doc ?? ''));
  };
  for (const c of rootPrims) {
    if (isGeneratedRoot(c)) for (const k of childPaths(c)) visit(k, -1);
    else visit(c, -1);
  }
  if (resetStack.size) W.push('Prims with !resetXformStack! are placed relative to the world');

  // world matrices at default time (source space)
  const worldOf = (i: number): Matrix4 => {
    const m = new Matrix4().fromArray(ir.nodes[i].matrix);
    return ir.nodes[i].parent >= 0 ? worldOf(ir.nodes[i].parent).multiply(m) : m;
  };

  // ------------------------------------------------------------ skinning
  const skelOfPath = (p: string): string | null => {
    for (let q = p; q && q !== '/'; q = q.slice(0, q.lastIndexOf('/')) || '/') {
      const t = rel(q, 'skel:skeleton')[0];
      if (t) return t;
    }
    return null;
  };
  for (const sm of skinnedMeshes) {
    const skelPath = skelOfPath(sm.path);
    const sk = skeletons.find((s) => s.path === skelPath);
    const mesh = ir.meshes[sm.mesh];
    if (skelPath && trivialSkeletons.includes(skelPath)) continue; // blend-shape carrier only
    if (!sk) {
      W.push(`"${sm.path}": skinned mesh without a skeleton binding`);
      continue;
    }
    const ji = val(sm.path, 'primvars:skel:jointIndices') as ArrayLike<number>;
    const jw = val(sm.path, 'primvars:skel:jointWeights') as ArrayLike<number>;
    const f = attr(sm.path, 'primvars:skel:jointIndices');
    const nv = mesh.positions.length / 3;
    const elem = Number(f?.elementSize ?? Math.max(1, Math.round(ji.length / nv)));
    const constant = f?.interpolation === 'constant';
    const local = (val(sm.path, 'skel:joints') as string[] | undefined)?.map((j) => sk.joints.indexOf(String(j)));
    const weights = sk.joints.map(() => new Float32Array(nv));
    let anyWeight = false;
    for (let v = 0; v < nv; v++)
      for (let k = 0; k < elem; k++) {
        const e = (constant ? 0 : v) * elem + k;
        let j = Number(ji[e]);
        if (local) j = local[j] ?? -1;
        const wgt = Number(jw?.[e] ?? 0);
        if (j >= 0 && j < weights.length && wgt > 0) {
          weights[j][v] += wgt;
          anyWeight = true;
        }
      }
    if (!anyWeight) continue;
    // bind-space positions: SkelWorld · geomBind · p ; IBM_j = bind_j⁻¹ · SkelWorld⁻¹
    const geomBind = (() => {
      const g = val(sm.path, 'primvars:skel:geomBindTransform');
      return g ? new Matrix4().fromArray(Array.from(g as ArrayLike<number>)) : worldOf(sk.node).invert().multiply(worldOf(sm.node));
    })();
    const S = worldOf(sk.node);
    const toBind = S.clone().multiply(geomBind);
    const v3 = new Vector3();
    const tr = (src: Float32Array) => {
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        v3.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(toBind);
        out.set([v3.x, v3.y, v3.z], i);
      }
      return out;
    };
    const nmat = new Matrix4().copy(toBind).invert().transpose();
    let normals = mesh.normals;
    if (normals) {
      normals = Float32Array.from(normals);
      for (let i = 0; i < normals.length; i += 3) {
        v3.set(normals[i], normals[i + 1], normals[i + 2]).transformDirection(nmat);
        normals.set([v3.x, v3.y, v3.z], i);
      }
    }
    const bound: IRMesh = {
      ...mesh,
      positions: tr(mesh.positions),
      normals,
      shapeKeys: mesh.shapeKeys?.map((k) => ({ name: k.name, positions: tr(k.positions) })),
      groups: { names: sk.joints.map((j) => j.split('/').pop()!), weights },
    };
    ir.meshes.push(bound);
    ir.nodes[sm.node].mesh = ir.meshes.length - 1;
    ir.nodes[sm.node].skin = ir.skins.length;
    const Sinv = S.clone().invert();
    ir.skins.push({ name: specs[sk.path] ? sk.path.split('/').pop() || 'Armature' : 'Armature', joints: sk.jointNodes, inverseBind: sk.bind.map((b) => b.clone().invert().multiply(Sinv).toArray()) });
  }
  // skeletons without skinned meshes still become armatures
  for (const sk of skeletons) {
    if (ir.skins.some((s) => s.joints[0] === sk.jointNodes[0])) continue;
    if (!sk.jointNodes.length) continue;
    const S = worldOf(sk.node);
    ir.skins.push({ name: sk.path.split('/').pop() || 'Armature', joints: sk.jointNodes, inverseBind: sk.bind.map((b) => S.clone().multiply(b).invert().toArray()) });
  }

  // ------------------------------------------------------------ animation
  const channels: IRChannel[] = [];
  const toSec = (t: number) => t / tcps;
  // xformOp time samples
  for (const [path, ni] of nodeOf) {
    if (collapsed.has(path)) continue;
    const self = collapsedInto.get(path);
    const times = [...new Set([...animatedTimes(path), ...(self ? animatedTimes(self) : [])])].sort((a, b) => a - b);
    if (times.length < 2) continue;
    const at = (t: number) => (self ? localMatrix(path, t).multiply(localMatrix(self, t)) : localMatrix(path, t));
    const values: number[] = [];
    for (const t of times) values.push(...at(t).elements);
    channels.push({ node: ni, path: 'matrix', times: times.map(toSec), values, interpolation: 'LINEAR' });
    ir.nodes[ni].matrix = at(times[0]).toArray();
  }
  // skeletal animation
  for (const sk of [...skeletons, ...trivialSkeletons.map((p) => ({ path: p, node: -1, joints: [] as string[], jointNodes: [] as number[], bind: [] as Matrix4[] }))]) {
    let animPath = rel(sk.path, 'skel:animationSource')[0];
    if (!animPath) for (let q = sk.path; q && q !== '/' && !animPath; q = q.slice(0, q.lastIndexOf('/')) || '/') animPath = rel(q, 'skel:animationSource')[0];
    if (!animPath || !specs[animPath]) continue;
    const ajoints = ((val(animPath, 'joints') ?? []) as string[]).map(String);
    const map = ajoints.map((j) => sk.joints.indexOf(j));
    const tf = attr(animPath, 'translations'),
      rf = attr(animPath, 'rotations'),
      sf = attr(animPath, 'scales');
    // defaults → joint node matrices
    const tDef = tf?.default as ArrayLike<number> | undefined,
      rDef = rf?.default as ArrayLike<number> | undefined,
      sDef = sf?.default as ArrayLike<number> | undefined;
    map.forEach((j, k) => {
      if (j < 0) return;
      const n = ir.nodes[sk.jointNodes[j]];
      const cur = new Matrix4().fromArray(n.matrix);
      const p = new Vector3(),
        q = new Quaternion(),
        s = new Vector3();
      cur.decompose(p, q, s);
      if (tDef?.length) p.set(tDef[k * 3], tDef[k * 3 + 1], tDef[k * 3 + 2]);
      if (rDef?.length) q.set(rDef[k * 4], rDef[k * 4 + 1], rDef[k * 4 + 2], rDef[k * 4 + 3]).normalize();
      if (sDef?.length) s.set(sDef[k * 3], sDef[k * 3 + 1], sDef[k * 3 + 2]);
      n.matrix = new Matrix4().compose(p, q, s).toArray();
    });
    const addCh = (f: any, comps: number, path: IRChannel['path']) => {
      const ts = f?.timeSamples;
      if (!ts?.times?.length) return;
      const times = (ts.times as number[]).map(Number);
      map.forEach((j, k) => {
        if (j < 0) return;
        const values: number[] = [];
        for (const v of ts.values as ArrayLike<number>[]) for (let c = 0; c < comps; c++) values.push(Number(v[k * comps + c]));
        channels.push({ node: sk.jointNodes[j], path, times: times.map(toSec), values, interpolation: 'LINEAR' });
      });
    };
    addCh(tf, 3, 'translation');
    addCh(rf, 4, 'rotation');
    addCh(sf, 3, 'scale');
    // blend shape weights for meshes bound to this skeleton
    const bsNames = ((val(animPath, 'blendShapes') ?? []) as string[]).map(String);
    const wf = attr(animPath, 'blendShapeWeights');
    if (bsNames.length && wf) {
      for (const [mpath, ni] of nodeOf) {
        if (skelOfPath(mpath) !== sk.path) continue;
        const shapes = ((val(mpath, 'skel:blendShapes') ?? []) as string[]).map(String);
        if (!shapes.length) continue;
        const order = shapes.map((s) => bsNames.indexOf(s));
        const def = wf.default as ArrayLike<number> | undefined;
        if (def?.length) ir.nodes[ni].morphWeights = order.map((o) => (o >= 0 ? Number(def[o]) : 0));
        const ts = wf.timeSamples;
        if (ts?.times?.length) {
          const values: number[] = [];
          for (const v of ts.values as ArrayLike<number>[]) for (const o of order) values.push(o >= 0 ? Number(v[o]) : 0);
          channels.push({ node: ni, path: 'weights', times: (ts.times as number[]).map((t) => toSec(Number(t))), values, interpolation: 'LINEAR' });
        }
      }
    }
  }
  if (channels.length) ir.animations.push({ name: String(root.defaultPrim ?? 'Animation'), channels });
  return ir;
}

function sampleAttr(f: any, t: number): any {
  const times: number[] = f.timeSamples.times.map(Number);
  const values: any[] = f.timeSamples.values;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= t) i++;
  const a = values[i],
    b = values[i + 1];
  const u = (t - times[i]) / (times[i + 1] - times[i] || 1);
  if (typeof a === 'number') return a + (b - a) * u;
  if (Array.isArray(a) || ArrayBuffer.isView(a)) return Array.from(a as ArrayLike<number>, (x, k) => x + ((b as ArrayLike<number>)[k] - x) * u);
  return a;
}
