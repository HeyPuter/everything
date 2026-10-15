// Import nodes: OBJ, PLY, STL, CSV and text files read with the app's file readers.
//
// Browsers cannot read arbitrary paths, so files are packed into the document (`packed_files`)
// with the node's Open button; the Path input names a packed file (by file name).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu } from '../../ui/menu';
import { app } from '../../app/app';
import { uid } from '../../data/defaults';
import type { DocumentData, ID, NodeData } from '../../data/types';
import type { NodeDrawContext } from '../../nodes/types';
import { gn } from './defs';
import { GeometrySet, InstancesComponent, MeshComponent, PointsComponent, mulMat, type AttrMap, type InstanceReference } from '../geometry';
import { readObj } from '../../io/formats/obj';
import { readPly } from '../../io/formats/ply';
import { readStl } from '../../io/formats/stl';
import { applyBasis } from '../../io/formats/common';
import type { IRMesh, IRScene } from '../../io/formats/ir';
import type { ExecContext } from '../exec';
import { place } from './menu';

/** A file stored in the document for import nodes. */
export interface PackedFile {
  id: ID;
  name: string;
  bytes: Uint8Array;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Packed file for a path (exact name, then file name, case-insensitive). */
export function packedFile(doc: DocumentData, path: string): PackedFile | null {
  if (!path) return null;
  const files = Object.values(doc.packed_files ?? {});
  const b = baseName(path).toLowerCase();
  return files.find((f) => f.name === path) ?? files.find((f) => baseName(f.name).toLowerCase() === b) ?? null;
}

/** Store a file in the document (replacing a packed file of the same name). */
export function packFile(doc: DocumentData, name: string, bytes: Uint8Array): PackedFile {
  doc.packed_files ??= {};
  const old = Object.values(doc.packed_files).find((f) => f.name === name);
  const f: PackedFile = { id: old?.id ?? uid('pf'), name, bytes };
  doc.packed_files[f.id] = f;
  return f;
}

// ---------------------------------------------------------------------------
// Parsing (cached per file contents)

const parsed = new WeakMap<Uint8Array, Map<string, unknown>>();
function cached<T>(bytes: Uint8Array, kind: string, fn: () => T): T {
  let m = parsed.get(bytes);
  if (!m) parsed.set(bytes, (m = new Map()));
  if (!m.has(kind)) m.set(kind, fn());
  return m.get(kind) as T;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Mesh component from an importer mesh (positions converted by the scene's axes and scale). */
export function irMeshToComponent(ir: IRScene, m: IRMesh, matrix?: ArrayLike<number>): MeshComponent {
  let pos = m.positions;
  if (matrix) {
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i],
        y = pos[i + 1],
        z = pos[i + 2];
      out[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      out[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      out[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    pos = out;
  }
  pos = applyBasis(ir.axis, ir.unitScale, pos);
  const nf = m.faceSizes.length;
  const offsets = new Uint32Array(nf + 1);
  for (let f = 0; f < nf; f++) offsets[f + 1] = offsets[f] + m.faceSizes[f];
  const attrs: AttrMap = new Map();
  const nc = m.indices.length;
  if (m.uvs && m.uvs.length === nc * 2) attrs.set(m.uvName || 'UVMap', { domain: 'CORNER', type: 'FLOAT2', data: m.uvs });
  if (nf) {
    const sharp = new Uint8Array(nf);
    for (let f = 0; f < nf; f++) sharp[f] = m.smooth ? (m.smooth[f] ? 0 : 1) : 1;
    attrs.set('sharp_face', { domain: 'FACE', type: 'BOOLEAN', data: sharp });
    attrs.set('material_index', { domain: 'FACE', type: 'INT', data: m.materialIndex ? Int32Array.from(m.materialIndex) : new Int32Array(nf) });
  }
  for (const c of m.colors ?? []) attrs.set(c.name, { domain: c.domain, type: 'FLOAT_COLOR', data: c.data });
  return new MeshComponent(pos, offsets, new Uint32Array(m.indices), new Uint32Array(0), attrs);
}

/** World matrices of importer nodes (source space). */
function worldMatrices(ir: IRScene): Float64Array[] {
  const out: Float64Array[] = [];
  ir.nodes.forEach((n, i) => {
    const local = Float64Array.from(n.matrix);
    out[i] = n.parent >= 0 && n.parent < i ? mulMat(out[n.parent], local) : local;
  });
  return out;
}

/** One instance per object of the file (instance transforms are identity). */
export function importObj(bytes: Uint8Array): GeometrySet {
  return cached(bytes, 'obj', () => {
    const ir = readObj(text(bytes), { forward: 'Y', up: 'Z' });
    const W = worldMatrices(ir);
    const refs: InstanceReference[] = [];
    ir.nodes.forEach((n, i) => {
      if (n.mesh === undefined) return;
      const mesh = irMeshToComponent(ir, ir.meshes[n.mesh], W[i]);
      refs.push({ type: 'GEOMETRY', geometry: new GeometrySet(mesh), key: `obj:${i}:${n.name}` });
    });
    if (!refs.length) return GeometrySet.empty();
    const T = new Float32Array(refs.length * 16);
    for (let i = 0; i < refs.length; i++) T.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16);
    return new GeometrySet(
      undefined,
      undefined,
      undefined,
      new InstancesComponent(
        T,
        Int32Array.from(refs, (_, i) => i),
        refs,
      ),
    );
  });
}

function singleMesh(ir: IRScene): GeometrySet {
  const W = worldMatrices(ir);
  const parts = ir.nodes.flatMap((n, i) => (n.mesh === undefined ? [] : [irMeshToComponent(ir, ir.meshes[n.mesh], W[i])]));
  if (!parts.length) return GeometrySet.empty();
  if (parts.length === 1) return new GeometrySet(parts[0]);
  // join the parts (importers usually return one mesh)
  let nv = 0,
    nc = 0,
    nf = 0;
  for (const p of parts) {
    nv += p.vertCount;
    nc += p.cornerCount;
    nf += p.faceCount;
  }
  const pos = new Float32Array(nv * 3),
    corners = new Uint32Array(nc),
    offs = new Uint32Array(nf + 1);
  let v = 0,
    c = 0,
    f = 0;
  for (const p of parts) {
    pos.set(p.positions, v * 3);
    for (let i = 0; i < p.cornerCount; i++) corners[c + i] = p.corners[i] + v;
    for (let i = 0; i < p.faceCount; i++) offs[f + i + 1] = p.faceOffsets[i + 1] + c;
    v += p.vertCount;
    c += p.cornerCount;
    f += p.faceCount;
  }
  return new GeometrySet(new MeshComponent(pos, offs, corners));
}

export const importPly = (bytes: Uint8Array) => cached(bytes, 'ply', () => singleMesh(readPly(bytes, { forward: 'Y', up: 'Z', colorSpace: 'SRGB' })));
export const importStl = (bytes: Uint8Array) => cached(bytes, 'stl', () => singleMesh(readStl(bytes, { forward: 'Y', up: 'Z', mergeVertices: true })));

/** Points with one attribute per numeric column (integer columns stay integers). */
export function importCsv(bytes: Uint8Array, delimiter: string): GeometrySet {
  return cached(bytes, `csv:${delimiter}`, () => {
    const lines = text(bytes)
      .split(/\r?\n/)
      .filter((l) => l.trim().length);
    if (lines.length < 2) return GeometrySet.empty();
    const d = delimiter || ',';
    const header = lines[0].split(d).map((s) => s.trim());
    const rows = lines.slice(1).map((l) => l.split(d).map((s) => s.trim()));
    const n = rows.length;
    const attrs: AttrMap = new Map();
    header.forEach((name, col) => {
      if (!name) return;
      const vals = rows.map((r) => r[col] ?? '');
      if (!vals.every((s) => s === '' || Number.isFinite(Number(s)))) return;
      const ints = vals.every((s) => s === '' || /^[-+]?\d+$/.test(s));
      const data = ints ? new Int32Array(n) : new Float32Array(n);
      vals.forEach((s, i) => (data[i] = s === '' ? 0 : Number(s)));
      attrs.set(name, { domain: 'POINT', type: ints ? 'INT' : 'FLOAT', data });
    });
    return new GeometrySet(undefined, new PointsComponent(new Float32Array(n * 3), attrs));
  });
}

// ---------------------------------------------------------------------------
// Nodes

function fileOf(ctx: ExecContext): Uint8Array | null {
  const path = ctx.string('Path');
  if (!path) return null;
  const f = packedFile(ctx.env.doc, path);
  if (!f) {
    ctx.warn(`File not found: "${path}" (open it with the node's file button)`);
    return null;
  }
  return f.bytes;
}

const fileSig = (node: NodeData, env: { doc: DocumentData }) => {
  const p = node.inputs.Path;
  const f = typeof p === 'string' ? packedFile(env.doc, p) : null;
  return f ? `${f.id}:${f.bytes.length}` : '-';
};

/** File row in the node body: pick a packed file or open one from disk. */
export function fileBody(extensions: string[], accept: string, socket = 'Path') {
  return (ctx: NodeDrawContext): Child => {
    const { node, tree } = ctx;
    const linked = tree.links.some((l) => l.to_node === node.id && l.to_socket === socket);
    const files = Object.values(app.doc.packed_files ?? {}).filter((f) => extensions.some((e) => f.name.toLowerCase().endsWith(e)));
    const cur = typeof node.inputs[socket] === 'string' ? (node.inputs[socket] as string) : '';
    const open = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        packFile(app.doc, file.name, bytes);
        node.inputs[socket] = file.name;
        ctx.changed('Open File', true);
      };
      input.click();
    };
    return h(
      'div',
      { class: 'nd-image-sel' },
      h(
        'button',
        {
          class: 'nd-ids-browse',
          'data-tip': 'Choose a file stored in the project',
          disabled: linked,
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              files.length
                ? files.map((f) => ({ label: f.name, icon: 'file_blank', active: f.name === cur, action: () => ((node.inputs[socket] = f.name), ctx.changed('Choose File', true)) }))
                : [{ label: 'No stored files', disabled: true }],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('file_blank'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('span', { class: 'nd-ids-name', title: cur }, linked ? `${socket} is linked` : cur || 'No file'),
      h('button', { class: 'nd-ids-open', 'data-tip': 'Open a file from disk and store it in the project', disabled: linked, onclick: open }, icon('file_folder')),
    );
  };
}

const fileUI = (exts: string[]) => ({ drawBody: fileBody(exts, exts.join(',')), bodyHeight: () => 26 });

gn(
  'GeometryNodeImportOBJ',
  'input',
  {
    exec: (ctx) => {
      const b = fileOf(ctx);
      return { Instances: b ? importObj(b) : GeometrySet.empty() };
    },
    sig: fileSig,
  },
  fileUI(['.obj']),
);

gn(
  'GeometryNodeImportPLY',
  'input',
  {
    exec: (ctx) => {
      const b = fileOf(ctx);
      return { Mesh: b ? importPly(b) : GeometrySet.empty() };
    },
    sig: fileSig,
  },
  fileUI(['.ply']),
);

gn(
  'GeometryNodeImportSTL',
  'input',
  {
    exec: (ctx) => {
      const b = fileOf(ctx);
      return { Mesh: b ? importStl(b) : GeometrySet.empty() };
    },
    sig: fileSig,
  },
  fileUI(['.stl']),
);

gn(
  'GeometryNodeImportCSV',
  'input',
  {
    exec: (ctx) => {
      const b = fileOf(ctx);
      return { 'Point Cloud': b ? importCsv(b, ctx.string('Delimiter')) : GeometrySet.empty() };
    },
    sig: fileSig,
  },
  fileUI(['.csv', '.tsv', '.txt']),
);

gn(
  'GeometryNodeImportText',
  'input',
  {
    exec: (ctx) => {
      const b = fileOf(ctx);
      return { String: b ? text(b) : '' };
    },
    sig: fileSig,
  },
  fileUI(['.txt', '.text', '.md', '.csv', '.json']),
);

place('Input/Import', 'GeometryNodeImportCSV', 'CSV (.csv)');
place('Input/Import', 'GeometryNodeImportOBJ', 'Wavefront (.obj)');
place('Input/Import', 'GeometryNodeImportPLY', 'Stanford PLY (.ply)');
place('Input/Import', 'GeometryNodeImportSTL', 'STL (.stl)');
place('Input/Import', 'GeometryNodeImportText', 'Text (.txt)');
