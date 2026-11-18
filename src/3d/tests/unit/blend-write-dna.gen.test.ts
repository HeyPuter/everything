// Generator (manual): the struct layouts and default values the .blend writer starts from, read from the
// probe file written by tests/fixtures/blend/make_write_dna.py (fresh data-blocks of every kind the
// writer stores, saved by a 4.2 LTS host), written to src/io/blend/write/dna.gen.ts.
// The probe also holds one new node of every shader node type ("PROBE:<idname>"): their legacy type
// numbers, storage structs (with the values of a new node) and sockets go to src/io/blend/write/nodes.gen.ts.
// Run: WRITEDNA_BLEND=<probe.blend> WRITEDNA_OUT=src/io/blend/write npx vitest run tests/unit/blend-write-dna.gen.test.ts
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { BlendFile, type BStruct } from '../../src/io/blend/reader';
import type { SdnaStruct } from '../../src/io/blend/container';

const SRC = process.env.WRITEDNA_BLEND ?? '';
const OUT = process.env.WRITEDNA_OUT ?? '';

/** Structs the writer stores as blocks (their embedded structs come along). */
export const ROOTS = [
  'Link',
  'FileGlobal',
  'Scene',
  'ToolSettings',
  'ViewLayer',
  'LayerCollection',
  'Base',
  'Collection',
  'CollectionObject',
  'CollectionChild',
  'Object',
  'Mesh',
  'CustomDataLayer',
  'bDeformGroup',
  'MDeformVert',
  'MDeformWeight',
  'vec2f',
  'vec3f',
  'vec2i',
  'MIntProperty',
  'MFloatProperty',
  'MBoolProperty',
  'MInt8Property',
  'MLoopCol',
  'MPropCol',
  'Camera',
  'Lamp',
  'World',
  'Material',
  'bNodeTree',
  'bNode',
  'bNodeSocket',
  'bNodeLink',
  'bNodePanelState',
  'bNodeSocketValueFloat',
  'bNodeSocketValueInt',
  'bNodeSocketValueBoolean',
  'bNodeSocketValueVector',
  'bNodeSocketValueRGBA',
  'bNodeSocketValueString',
  'NodeTexImage',
  'NodeShaderNormalMap',
  'Image',
  'ImagePackedFile',
  'PackedFile',
  'ImageTile',
  'Stereo3dFormat',
  'AnimData',
  'bAction',
  'bActionGroup',
  'FCurve',
  'BezTriple',
  'IDProperty',
  // looked up by name when a file is read, whether or not the file links libraries
  'Library',
];

/** Which instance holds the defaults when the probe has several (by ID name). */
const PREFERRED: Record<string, string> = { Object: 'OBPROBE_CameraObject' };

/** Fields never carried as defaults: per-session values, padding, runtime data and the ID header. */
const SKIP = /(^|\.)(_pad\w*|session_uid|persistent_uid|runtime|tag|recalc\w*|icon_id|us|name|typemap|totlayer|maxlayer|totsize|totvert|totedge|totpoly|totloop|totface|totcol|totselect|act_face)$/;

it.skipIf(!SRC || !OUT)('writes src/io/blend/write/dna.gen.ts and nodes.gen.ts', () => {
  const f = new BlendFile(new Uint8Array(readFileSync(SRC)));
  const sdna = f.sdna;

  // ---------------------------------------------------------------- node types
  const nodeTypes: Record<string, unknown[]> = {};
  const storageTypes = new Set<string>();
  const valueTypes = new Set<string>();
  for (const b of f.blocks) {
    if (f.structOf(b.sdna)?.type !== 'bNode') continue;
    for (const n of f.blockStructs(b)) {
      const name = n.str('name');
      if (!name.startsWith('PROBE:')) continue;
      const idname = n.str('idname');
      const st = n.ref('storage');
      if (st) storageTypes.add(st.type);
      const sockets = (list: string) =>
        n.list(list, 1000).map((so) => {
          const dv = so.ref('default_value');
          if (dv) valueTypes.add(dv.type);
          return [so.str('identifier'), so.str('name'), so.str('idname'), so.num('type'), dv?.type ?? ''];
        });
      const storage = st ? flatten(st, '', {}) : null;
      nodeTypes[idname] = [n.num('type'), st?.type ?? '', storage ?? {}, sockets('inputs'), sockets('outputs'), n.num('width')];
    }
  }
  const roots = [...ROOTS, ...storageTypes, ...valueTypes, 'CurveMapping', 'CurveMap', 'CurveMapPoint', 'ColorBand'];
  const glob = f.blocks.find((b) => b.code === 'GLOB')!;
  const g = f.blockStruct(glob)!;

  // closure of the roots over embedded (non-pointer) struct fields
  const order: SdnaStruct[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (seen.has(name)) return;
    const st = sdna.structByType.get(name);
    if (!st) throw new Error(`no struct ${name} in the probe file`);
    seen.add(name);
    for (const fl of st.fields) if (fl.structIndex >= 0) add(sdna.structs[fl.structIndex].type);
    order.push(st);
  };
  for (const r of roots) add(r);
  // 'Link' first: block SDNA index 0 marks untyped (raw) data
  order.sort((a, b) => Number(b.type === 'Link') - Number(a.type === 'Link'));

  const types = new Map<string, number>();
  for (const st of order) {
    types.set(st.type, st.size);
    for (const fl of st.fields) if (!types.has(fl.type)) types.set(fl.type, sdna.typeSizes[fl.typeIndex]);
  }

  // defaults: the first (or preferred) instance of each root that the probe stores as a block
  const defaults: Record<string, Record<string, unknown>> = {};
  function flatten(s: BStruct, prefix: string, out: Record<string, unknown>): Record<string, unknown> {
    // lengths of arrays held by pointers are left out: the writer stores the pointer empty unless it
    // writes the array (and then its length), and a length without its array makes readers overrun it
    const pointers = s.st.fields.filter((fl) => fl.nameInfo.pointer).map((fl) => fl.name);
    const isLength = (name: string) => pointers.some((p) => name === `${p}_len` || name === `${p}_num` || name === `${p}_count` || name === `tot${p}`);
    for (const fl of s.st.fields) {
      if (isLength(fl.name)) continue;
      const key = prefix + fl.name;
      if (SKIP.test(key) || (prefix === '' && fl.name === 'id')) continue;
      if (fl.nameInfo.pointer) continue;
      if (fl.structIndex >= 0) {
        if (fl.nameInfo.arrayLen > 1) continue;
        const sub = s.sub(fl.name);
        if (sub) flatten(sub, `${key}.`, out);
      } else if (fl.type === 'char' && fl.nameInfo.arrayLen > 1) {
        const v = s.str(fl.name);
        if (v) out[key] = v;
      } else if (fl.nameInfo.arrayLen > 1) {
        const v = s.nums(fl.name);
        if (v.some((x) => x !== 0)) out[key] = v.map((x) => (Number.isInteger(x) ? x : Math.fround(x)));
      } else {
        const v = s.num(fl.name);
        if (v !== 0) out[key] = v;
      }
    }
    return out;
  }
  for (const r of ROOTS) {
    const st = sdna.structByType.get(r)!;
    const blocks = f.blocks.filter((b) => b.code !== 'DNA1' && b.code !== 'ENDB' && f.structOf(b.sdna) === st);
    if (!blocks.length) continue;
    const pick = PREFERRED[r] ? blocks.find((b) => f.blockStruct(b)?.idName === PREFERRED[r]) : undefined;
    const inst = f.blockStruct(pick ?? blocks[0])!;
    const d = flatten(inst, '', {});
    if (Object.keys(d).length) defaults[r] = d;
  }

  const lines: string[] = [];
  lines.push('// GENERATED by tests/unit/blend-write-dna.gen.test.ts from the probe written by');
  lines.push('// tests/fixtures/blend/make_write_dna.py (fresh data-blocks saved by a 4.2 LTS host): the layouts');
  lines.push('// (field types and names) of the structs the .blend writer stores, and the non-zero values a new');
  lines.push('// data-block of each kind has. Interface facts for file compatibility; see THIRD_PARTY_NOTICES.md.');
  lines.push('');
  lines.push(`export const DNA_FILE_VERSION = ${JSON.stringify({ version: f.header.version, subversion: g.num('subversion'), minversion: g.num('minversion'), minsubversion: g.num('minsubversion') })};`);
  lines.push('');
  lines.push('/** type name → size in bytes (structs and basic types) */');
  lines.push(`export const DNA_TYPES: [string, number][] = ${JSON.stringify([...types])};`);
  lines.push('');
  lines.push('/** struct name → "type name;type name;…" (names as declared: *pointers, [array] dimensions) */');
  lines.push('export const DNA_STRUCTS: Record<string, string> = {');
  for (const st of order) lines.push(`  ${JSON.stringify(st.type)}: ${JSON.stringify(st.fields.map((fl) => `${fl.type} ${fl.nameInfo.raw}`).join(';'))},`);
  lines.push('};');
  lines.push('');
  lines.push('/** struct name → field path → non-zero value of a new data-block */');
  lines.push('export const DNA_DEFAULTS: Record<string, Record<string, number | number[] | string>> = {');
  for (const [k, v] of Object.entries(defaults)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push('};');
  writeFileSync(`${OUT}/dna.gen.ts`, lines.join('\n') + '\n');

  const nl: string[] = [];
  nl.push('// GENERATED by tests/unit/blend-write-dna.gen.test.ts from the probe written by');
  nl.push('// tests/fixtures/blend/make_write_dna.py: for every shader node type, as a new node of its kind has it,');
  nl.push('// [legacy type number, storage struct, non-zero storage values, inputs, outputs, width], each socket');
  nl.push('// [identifier, name, socket idname, socket type, default value struct]. Interface facts; see THIRD_PARTY_NOTICES.md.');
  nl.push('');
  nl.push('export type GenSocket = [string, string, string, number, string];');
  nl.push('export type GenNode = [number, string, Record<string, number | number[] | string>, GenSocket[], GenSocket[], number];');
  nl.push('');
  nl.push('export const NODE_TYPES: Record<string, GenNode> = {');
  for (const k of Object.keys(nodeTypes).sort()) nl.push(`  ${k}: ${JSON.stringify(nodeTypes[k])},`);
  nl.push('};');
  writeFileSync(`${OUT}/nodes.gen.ts`, nl.join('\n') + '\n');
});
