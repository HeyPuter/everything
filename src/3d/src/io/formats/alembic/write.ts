// Alembic (Ogawa) writer: the inverse of ogawa.ts / archive.ts plus the geometry schemas
// (Xform, PolyMesh with UVs / normals / face sets, Camera). Independent implementation from the
// publicly described layout:
//   file   = "Ogawa" | frozen 0xff | u16 version | u64 root group offset, then blocks
//   group  = u64 count | u64 child offsets (high bit = data block, 0 = empty)
//   data   = u64 size | bytes
//   archive root = [i32 file version, i32 library version, top object, metadata, time samplings, indexed metadata]
//   object = [property compound, …child objects, child headers + 32 hash bytes]
//   compound = [one group per property, property headers]
//   scalar property = one data block per stored sample (16-byte key + values)
//   array property  = data + dimensions per stored sample

import type { Pod } from './archive';

const PODS: Pod[] = ['bool', 'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64', 'float16', 'float32', 'float64', 'string', 'wstring'];
const DATA_BIT = 0x8000000000000000n;

// ---------------------------------------------------------------------------
// Ogawa layer

type Child = { data: number } | { group: number };

class OgawaWriter {
  private chunks: Uint8Array[] = [];
  private pos = 16;
  /** identical data blocks are stored once */
  private dedup = new Map<string, { bytes: Uint8Array; offset: number }[]>();

  data(bytes: Uint8Array, key?: string): Child {
    if (!bytes.length) return { data: 0 };
    const k = key ?? `${bytes.length}:${hashHex(bytes)}`;
    const same = this.dedup.get(k)?.find((e) => equalBytes(e.bytes, bytes));
    if (same) return { data: same.offset };
    const head = new Uint8Array(8);
    new DataView(head.buffer).setBigUint64(0, BigInt(bytes.length), true);
    const offset = this.pos;
    this.chunks.push(head, bytes);
    this.pos += 8 + bytes.length;
    const list = this.dedup.get(k) ?? [];
    list.push({ bytes, offset });
    this.dedup.set(k, list);
    return { data: offset };
  }

  group(children: Child[]): Child {
    if (!children.length) return { group: 0 };
    const b = new Uint8Array(8 + children.length * 8);
    const dv = new DataView(b.buffer);
    dv.setBigUint64(0, BigInt(children.length), true);
    children.forEach((c, i) => dv.setBigUint64(8 + i * 8, 'data' in c ? BigInt(c.data) | DATA_BIT : BigInt(c.group), true));
    const offset = this.pos;
    this.chunks.push(b);
    this.pos += b.length;
    return { group: offset };
  }

  finish(root: Child): Uint8Array {
    const out = new Uint8Array(this.pos);
    out.set([0x4f, 0x67, 0x61, 0x77, 0x61, 0xff], 0); // "Ogawa", frozen
    const dv = new DataView(out.buffer);
    dv.setUint16(6, 1, false); // version 1, stored high byte first
    dv.setBigUint64(8, BigInt('group' in root ? root.group : 0), true);
    let p = 16;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 128-bit content digest (four independently seeded 32-bit multiply-xor lanes). */
export function digest(bytes: Uint8Array): Uint8Array {
  const seeds = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];
  const h = seeds.map((s) => (s ^ bytes.length) >>> 0);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    for (let l = 0; l < 4; l++) {
      let x = (h[l] ^ (v + l * 0x3b)) >>> 0;
      x = Math.imul(x, 0x01000193 + l * 2) >>> 0;
      h[l] = ((x << (13 + l)) | (x >>> (19 - l))) >>> 0;
    }
  }
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  h.forEach((x, l) => {
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    x ^= x >>> 16;
    dv.setUint32(l * 4, x >>> 0, true);
  });
  return out;
}

const hashHex = (b: Uint8Array) => Array.from(digest(b), (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Property / object model

export interface ScalarProp {
  kind: 'scalar';
  name: string;
  pod: Pod;
  extent: number;
  metadata?: string;
  timeSampling: number;
  /** encoded values per sample */
  samples: Uint8Array[];
}
export interface ArrayProp {
  kind: 'array';
  name: string;
  pod: Pod;
  extent: number;
  metadata?: string;
  timeSampling: number;
  samples: { bytes: Uint8Array; count: number }[];
}
export interface CompoundProp {
  kind: 'compound';
  name: string;
  metadata?: string;
  children: Prop[];
}
export type Prop = ScalarProp | ArrayProp | CompoundProp;

export interface AbcObjectOut {
  name: string;
  metadata: string;
  props: Prop[];
  children: AbcObjectOut[];
}

export interface TimeSamplingOut {
  timePerCycle: number;
  times: number[];
  maxSamples: number;
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice();
export const f64 = (v: ArrayLike<number>) => bytesOf(Float64Array.from(v));
export const f32 = (v: ArrayLike<number>) => bytesOf(Float32Array.from(v));
export const i32 = (v: ArrayLike<number>) => bytesOf(Int32Array.from(v));
export const u32 = (v: ArrayLike<number>) => bytesOf(Uint32Array.from(v));
export const u8 = (v: ArrayLike<number>) => Uint8Array.from(v);

class ArchiveWriter {
  ow = new OgawaWriter();
  private indexed: string[] = [];

  private mdIndex(md: string): number {
    if (!md) return 0;
    const i = this.indexed.indexOf(md);
    if (i >= 0) return i + 1;
    if (md.length < 256 && this.indexed.length < 254) {
      this.indexed.push(md);
      return this.indexed.length;
    }
    return 0xff;
  }

  /** Writes one property; returns its group and its header bytes. */
  private writeProp(p: Prop): { child: Child; header: Uint8Array; key: Uint8Array } {
    if (p.kind === 'compound') {
      const { child, key } = this.writeCompound(p.children);
      return { child, header: this.header(p, 0, 0, 0, 0), key };
    }
    const n = p.samples.length;
    const raw = p.kind === 'scalar' ? p.samples : p.samples.map((s) => s.bytes);
    // stored samples: up to the last one that differs from its predecessor
    let first = 0,
      last = 0;
    for (let i = 1; i < n; i++)
      if (!equalBytes(raw[i], raw[i - 1])) {
        if (!first) first = i;
        last = i;
      }
    const kids: Child[] = [];
    const keys: Uint8Array[] = [];
    for (let i = 0; i <= last && i < n; i++) {
      const key = digest(raw[i]);
      keys.push(key);
      const block = new Uint8Array(16 + raw[i].length);
      block.set(key, 0);
      block.set(raw[i], 16);
      kids.push(this.ow.data(block));
      // rank-1 arrays: an empty dimensions block means "size / element size"
      if (p.kind === 'array') kids.push({ data: 0 });
    }
    const child = this.ow.group(kids);
    return { child, header: this.header(p, n, first, last, p.timeSampling), key: digest(concat(keys)) };
  }

  private header(p: Prop, n: number, first: number, last: number, ts: number): Uint8Array {
    const name = new TextEncoder().encode(p.name);
    const mdStr = p.metadata ?? '';
    const mi = this.mdIndex(mdStr);
    const md = mi === 0xff ? new TextEncoder().encode(mdStr) : new Uint8Array(0);
    const constant = n > 0 && first === 0 && last === 0;
    const plain = first === 1 && last === n - 1;
    const maxv = Math.max(n, first, last, ts, name.length, md.length);
    const hint = maxv < 256 ? 0 : maxv < 65536 ? 1 : 2;
    let info = 0;
    if (p.kind !== 'compound') {
      const scalarLike = p.kind === 'array' && p.samples.length > 0 && p.samples.every((s) => s.count === 1);
      info |= p.kind === 'scalar' ? 1 : scalarLike ? 3 : 2;
      info |= hint << 2;
      info |= PODS.indexOf(p.pod) << 4;
      if (ts) info |= 0x100;
      if (!constant && !plain) info |= 0x200;
      if (p.kind === 'scalar' || p.extent === 1) info |= 0x400; // homogenous
      if (constant) info |= 0x800;
      info |= (p.extent & 0xff) << 12;
    } else info |= hint << 2;
    info |= mi << 20;
    const out: number[] = [info & 0xff, (info >>> 8) & 0xff, (info >>> 16) & 0xff, (info >>> 24) & 0xff];
    const put = (v: number) => {
      if (hint === 0) out.push(v & 0xff);
      else if (hint === 1) out.push(v & 0xff, (v >> 8) & 0xff);
      else out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    };
    if (p.kind !== 'compound') {
      put(n);
      if (!constant && !plain) {
        put(first);
        put(last);
      }
      if (ts) put(ts);
    }
    put(name.length);
    out.push(...name);
    if (mi === 0xff) {
      put(md.length);
      out.push(...md);
    }
    return Uint8Array.from(out);
  }

  writeCompound(props: Prop[]): { child: Child; key: Uint8Array } {
    if (!props.length) return { child: { group: 0 }, key: new Uint8Array(16) };
    const kids: Child[] = [];
    const headers: Uint8Array[] = [];
    const keys: Uint8Array[] = [];
    for (const p of props) {
      const r = this.writeProp(p);
      kids.push(r.child);
      headers.push(r.header);
      keys.push(r.key);
    }
    kids.push(this.ow.data(concat(headers)));
    return { child: this.ow.group(kids), key: digest(concat(keys)) };
  }

  writeObject(o: AbcObjectOut): { child: Child; key: Uint8Array } {
    const props = this.writeCompound(o.props);
    const kids: Child[] = [props.child];
    const headers: Uint8Array[] = [];
    const childKeys: Uint8Array[] = [];
    for (const c of o.children) {
      const r = this.writeObject(c);
      kids.push(r.child);
      childKeys.push(r.key);
      const name = new TextEncoder().encode(c.name);
      const mi = this.mdIndex(c.metadata);
      const md = mi === 0xff ? new TextEncoder().encode(c.metadata) : new Uint8Array(0);
      const h = new Uint8Array(4 + name.length + 1 + (mi === 0xff ? 4 + md.length : 0));
      const dv = new DataView(h.buffer);
      dv.setUint32(0, name.length, true);
      h.set(name, 4);
      h[4 + name.length] = mi;
      if (mi === 0xff) {
        dv.setUint32(5 + name.length, md.length, true);
        h.set(md, 9 + name.length);
      }
      headers.push(h);
    }
    const childHash = o.children.length ? digest(concat(childKeys)) : new Uint8Array(16);
    kids.push(this.ow.data(concat([...headers, props.key, childHash])));
    return { child: this.ow.group(kids), key: digest(concat([props.key, childHash])) };
  }

  finish(top: AbcObjectOut, metadata: string, samplings: TimeSamplingOut[]): Uint8Array {
    const v0 = this.ow.data(i32([0]));
    const v1 = this.ow.data(i32([10803]));
    const topChild = this.writeObject(top).child;
    const meta = this.ow.data(new TextEncoder().encode(metadata));
    const tsParts: Uint8Array[] = [];
    for (const s of samplings) {
      const b = new Uint8Array(16 + s.times.length * 8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, s.maxSamples, true);
      dv.setFloat64(4, s.timePerCycle, true);
      dv.setUint32(12, s.times.length, true);
      s.times.forEach((t, i) => dv.setFloat64(16 + i * 8, t, true));
      tsParts.push(b);
    }
    const ts = this.ow.data(concat(tsParts));
    const enc = new TextEncoder();
    const im = concat(this.indexed.map((s) => {
      const b = enc.encode(s);
      return concat([u8([b.length]), b]);
    }));
    // the indexed metadata block must exist even when empty: use a real (zero-size) block
    const imChild = im.length ? this.ow.data(im) : { data: 0 };
    const root = this.ow.group([v0, v1, topChild, meta, ts, imChild]);
    return this.ow.finish(root);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encode an archive from objects (children of the top object) and its time samplings. */
export function encodeArchive(objects: AbcObjectOut[], opts: { metadata: Record<string, string>; samplings: TimeSamplingOut[]; topProps?: Prop[] }): Uint8Array {
  const w = new ArchiveWriter();
  const meta = Object.entries(opts.metadata)
    .map(([k, v]) => `${k}=${String(v).replace(/[;=]/g, ' ')}`)
    .join(';');
  return w.finish({ name: 'ABC', metadata: '', props: opts.topProps ?? [], children: objects }, meta, [{ timePerCycle: 1, times: [0], maxSamples: 1 }, ...opts.samplings]);
}

// ---------------------------------------------------------------------------
// Geometry schemas

const XFORM_MD = 'schema=AbcGeom_Xform_v3';
const MESH_MD = 'schema=AbcGeom_PolyMesh_v1;schemaBaseType=AbcGeom_GeomBase_v1';
const CAMERA_MD = 'schema=AbcGeom_Camera_v1';
const FACESET_MD = 'schema=AbcGeom_FaceSet_v1;schemaBaseType=AbcGeom_GeomBase_v1';
const objMd = (schema: string, prop: string) => `${schema};schemaObjTitle=${/schema=([^;]+)/.exec(schema)![1]}:${prop}`;

export interface MeshSample {
  /** Y-up positions */
  positions: Float32Array;
  faceCounts: Int32Array;
  /** clockwise corner order (as stored in the file) */
  faceIndices: Int32Array;
  normals?: Float32Array | null;
  uvs?: { values: Float32Array; indices: Uint32Array; name: string } | null;
}

export interface SceneNode {
  name: string;
  /** local matrices (Y-up, column-major), one per frame (or a single one when static) */
  matrices: Float64Array[];
  visible: boolean[];
  children: SceneNode[];
  mesh?: { name: string; samples: MeshSample[]; faceSets?: { name: string; faces: Int32Array }[] };
  /** camera core values (16 per frame): lens mm, apertures cm, offsets, squeeze, overscan, fstop, focus, shutter, clipping */
  camera?: { name: string; samples: Float64Array[] };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const bounds = (p: Float32Array): number[] => {
  if (!p.length) return [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], p[i + k]);
      b[k + 3] = Math.max(b[k + 3], p[i + k]);
    }
  return b;
};

function xformObject(n: SceneNode, ts: number): AbcObjectOut {
  const anim = n.matrices.length > 1;
  const tsOf = ts;
  const props: Prop[] = [];
  const xprops: Prop[] = [
    { kind: 'scalar', name: '.inherits', pod: 'bool', extent: 1, timeSampling: tsOf, samples: n.matrices.map(() => u8([1])) },
    { kind: 'scalar', name: '.ops', pod: 'uint8', extent: 1, timeSampling: 0, samples: n.matrices.map(() => u8([0x30])) },
    { kind: 'scalar', name: '.vals', pod: 'float64', extent: 16, timeSampling: tsOf, samples: n.matrices.map((m) => f64(m)) },
  ];
  if (n.matrices.some((m) => m.some((v, i) => Math.abs(v - IDENTITY[i]) > 0))) xprops.push({ kind: 'scalar', name: 'isNotConstantIdentity', pod: 'bool', extent: 1, timeSampling: 0, samples: [u8([1])] });
  if (anim) {
    const chans: number[] = [];
    for (let c = 0; c < 16; c++) if (n.matrices.some((m) => m[c] !== n.matrices[0][c])) chans.push(c);
    if (chans.length) xprops.push({ kind: 'array', name: '.animChans', pod: 'uint32', extent: 1, timeSampling: tsOf, samples: [{ bytes: u32(chans), count: chans.length }] });
  }
  props.push({ kind: 'compound', name: '.xform', metadata: XFORM_MD, children: xprops });
  props.push({ kind: 'scalar', name: 'visible', pod: 'int8', extent: 1, timeSampling: tsOf, samples: n.visible.map((v) => u8([v ? 1 : 0])) });
  const children: AbcObjectOut[] = [];
  if (n.mesh) children.push(meshObject(n.mesh, ts));
  if (n.camera) children.push(cameraObject(n.camera, ts));
  for (const c of n.children) children.push(xformObject(c, ts));
  return { name: n.name, metadata: objMd(XFORM_MD, '.xform'), props, children };
}

function meshObject(m: NonNullable<SceneNode['mesh']>, ts: number): AbcObjectOut {
  const s = m.samples;
  const geom: Prop[] = [
    { kind: 'scalar', name: '.selfBnds', pod: 'float64', extent: 6, metadata: 'interpretation=box', timeSampling: ts, samples: s.map((x) => f64(bounds(x.positions))) },
    { kind: 'array', name: 'P', pod: 'float32', extent: 3, metadata: 'geoScope=vtx;interpretation=point', timeSampling: ts, samples: s.map((x) => ({ bytes: f32(x.positions), count: x.positions.length / 3 })) },
    { kind: 'array', name: '.faceIndices', pod: 'int32', extent: 1, timeSampling: ts, samples: s.map((x) => ({ bytes: i32(x.faceIndices), count: x.faceIndices.length })) },
    { kind: 'array', name: '.faceCounts', pod: 'int32', extent: 1, timeSampling: ts, samples: s.map((x) => ({ bytes: i32(x.faceCounts), count: x.faceCounts.length })) },
  ];
  const uv0 = s[0]?.uvs;
  if (uv0 && s.every((x) => x.uvs)) {
    const md = `arrayExtent=1;geoScope=fvr;interpretation=vector;isGeomParam=true;podExtent=2;podName=float32_t;sourceName=${uv0.name.replace(/[;=]/g, '_')}`;
    geom.push({
      kind: 'compound',
      name: 'uv',
      metadata: md,
      children: [
        { kind: 'array', name: '.vals', pod: 'float32', extent: 2, metadata: md, timeSampling: ts, samples: s.map((x) => ({ bytes: f32(x.uvs!.values), count: x.uvs!.values.length / 2 })) },
        { kind: 'array', name: '.indices', pod: 'uint32', extent: 1, timeSampling: ts, samples: s.map((x) => ({ bytes: u32(x.uvs!.indices), count: x.uvs!.indices.length })) },
      ],
    });
  }
  if (s.length && s.every((x) => x.normals))
    geom.push({ kind: 'array', name: 'N', pod: 'float32', extent: 3, metadata: 'arrayExtent=1;geoScope=fvr;interpretation=normal;isGeomParam=true;podExtent=3;podName=float32_t', timeSampling: ts, samples: s.map((x) => ({ bytes: f32(x.normals!), count: x.normals!.length / 3 })) });
  const children: AbcObjectOut[] = (m.faceSets ?? []).map((f) => ({
    name: f.name,
    metadata: objMd(FACESET_MD, '.faceset'),
    props: [
      {
        kind: 'compound',
        name: '.faceset',
        metadata: FACESET_MD,
        children: [
          { kind: 'scalar', name: '.selfBnds', pod: 'float64', extent: 6, metadata: 'interpretation=box', timeSampling: 0, samples: [f64(bounds(new Float32Array(0)))] },
          { kind: 'array', name: '.faces', pod: 'int32', extent: 1, timeSampling: 0, samples: [{ bytes: i32(f.faces), count: f.faces.length }] },
        ],
      },
    ],
    children: [],
  }));
  return { name: m.name, metadata: objMd(MESH_MD, '.geom'), props: [{ kind: 'compound', name: '.geom', metadata: MESH_MD, children: geom }], children };
}

function cameraObject(c: NonNullable<SceneNode['camera']>, ts: number): AbcObjectOut {
  return {
    name: c.name,
    metadata: objMd(CAMERA_MD, '.geom'),
    props: [{ kind: 'compound', name: '.geom', metadata: CAMERA_MD, children: [{ kind: 'scalar', name: '.core', pod: 'float64', extent: 16, timeSampling: ts, samples: c.samples.map((v) => f64(v)) }] }],
    children: [],
  };
}

export interface AlembicSceneOut {
  roots: SceneNode[];
  fps: number;
  /** first frame of the samples */
  frameStart: number;
  /** number of frames sampled (1 = static) */
  frames: number;
  application?: string;
}

export function writeAlembicScene(scene: AlembicSceneOut): Uint8Array {
  const fps = scene.fps > 0 ? scene.fps : 24;
  const ts = 1;
  const all = [...scene.roots];
  const top: Prop[] = [{ kind: 'scalar', name: '.childBnds', pod: 'float64', extent: 6, metadata: 'interpretation=box', timeSampling: ts, samples: Array.from({ length: Math.max(1, scene.frames) }, () => f64(bounds(new Float32Array(0)))) }];
  return encodeArchive(
    all.map((n) => xformObject(n, ts)),
    {
      metadata: {
        FramesPerTimeUnit: fps.toFixed(6),
        _ai_Application: scene.application ?? 'Puter 3D',
        _ai_DateWritten: new Date().toUTCString(),
        _ai_Description: 'unknown',
      },
      samplings: [{ timePerCycle: 1 / fps, times: [scene.frameStart / fps], maxSamples: Math.max(1, scene.frames) }],
      topProps: top,
    },
  );
}
