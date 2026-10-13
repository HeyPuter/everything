// Parasolid XT binary transmit reader.
//
// A transmit is a header followed by node records. The first record of each
// node type carries its field layout: "as in the base schema", a delta against
// the base schema, or a full embedded definition. Values are big-endian.
// Follows the Parasolid XT Format Reference and the ps-parser project (MIT),
// whose base schema file (sch_13006.s_t) ships alongside this module.

import schemaText from './sch_13006.s_t?raw';

export type XtValue = number | string | boolean | null | number[] | XtValue[];

export interface XtNode {
  type: number;
  name: string;
  id: number;
  f: Record<string, XtValue>;
}

interface FieldDef { name: string; code: string; n: number }
interface TypeDef { name: string; variable: boolean; fields: FieldDef[] }

const NULL_F64 = [0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00];
const NULL_I16 = -32764;
const CODES = new Set(['u', 'c', 'l', 'n', 'w', 'd', 'p', 'f', 'i', 'v', 'h', 'b']);

let base: Map<number, TypeDef> | null = null;

/** Transmitted types and fields of the base schema text. */
function baseSchema(): Map<number, TypeDef> {
  if (base) return base;
  base = new Map();
  const lines = schemaText.split('\n');
  const head = /^(\d+) ([A-Z_]+); ([^;]+); (\d+) (\d+) (\d+) $/;
  const field = /^([a-z]\w*); (\w); (\d+) (\d+) (\d+) $/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i].replace(/\r$/, ''));
    if (!m) continue;
    const fields: FieldDef[] = [];
    let ok = true;
    for (let j = i + 1; j < lines.length; j++) {
      const fm = field.exec(lines[j].replace(/\r$/, ''));
      if (!fm) break;
      if (fm[3] === '0') continue; // not transmitted
      if (!CODES.has(fm[2])) { ok = false; break; }
      fields.push({ name: fm[1], code: fm[2], n: Number(fm[5]) });
    }
    if (ok && m[4] !== '0') base.set(Number(m[1]), { name: m[2], variable: m[6] !== '0', fields });
  }
  return base;
}

export class XtError extends Error {}

class Reader {
  pos = 0;
  private dv: DataView;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private need(n: number) { if (this.pos + n > this.b.length) throw new XtError('The Parasolid data is truncated.'); }
  get eof() { return this.pos >= this.b.length; }
  u8() { this.need(1); return this.b[this.pos++]; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
  f64(): number | null {
    this.need(8);
    const p = this.pos;
    this.pos += 8;
    if (NULL_F64.every((x, i) => this.b[p + i] === x)) return null;
    return this.dv.getFloat64(p);
  }
  chars(n: number) { this.need(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.pos + i]); this.pos += n; return s; }
  utf16(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.i16() & 0xffff); return s; }
  str8() { return this.chars(this.u8()); }
  str32() { const n = this.i32(); if (n < 0 || n > 1 << 20) throw new XtError('Bad Parasolid header.'); return this.chars(n); }
}

function readOne(r: Reader, code: string): XtValue {
  switch (code) {
    case 'u': return r.u8();
    case 'c': return r.chars(1);
    case 'l': return r.u8() !== 0;
    case 'n': { const v = r.i16(); return v === NULL_I16 ? null : v; }
    case 'w': return r.utf16(1);
    case 'd': return r.i32();
    case 'p': { const v = r.i16(); return v === 1 ? null : v; }
    case 'f': return r.f64();
    case 'i': return [r.f64() ?? NaN, r.f64() ?? NaN];
    case 'v': case 'h': return [r.f64() ?? NaN, r.f64() ?? NaN, r.f64() ?? NaN];
    case 'b': return Array.from({ length: 6 }, () => r.f64() ?? NaN);
  }
  throw new XtError(`Unknown Parasolid field type '${code}'.`);
}

/** `count` is the repeat count of a variable-length node's last field (always
 *  read as a list), or null for an ordinary field. */
function readField(r: Reader, f: FieldDef, count: number | null): XtValue {
  const n = count ?? f.n;
  if (count === null && n <= 1) return readOne(r, f.code);
  if (f.code === 'c') return r.chars(n);
  if (f.code === 'w') return r.utf16(n);
  const out: XtValue[] = [];
  for (let i = 0; i < n; i++) out.push(readOne(r, f.code));
  return out;
}

function embeddedField(r: Reader): FieldDef & { variable: boolean } {
  const name = r.str8();
  const ptrClass = r.i16();
  const n = r.i16();
  const code = ptrClass === 0 ? r.str8() : 'p';
  const variable = n === 2 ? r.u8() !== 0 : false;
  if (!CODES.has(code)) throw new XtError(`Unknown Parasolid field type '${code}'.`);
  return { name, code, n, variable };
}

export interface XtTransmit {
  version: string;
  schema: string;
  nodes: Map<number, XtNode>;
}

export function parseTransmit(data: Uint8Array): XtTransmit {
  const r = new Reader(data);
  if (r.chars(2) !== 'PS') throw new XtError('Not a binary Parasolid transmit.');
  const version = r.str32();
  const schema = r.str32();
  const maxType = r.i16();
  r.i16();
  r.u8();
  r.u8();
  if (!/_13006$/.test(schema)) throw new XtError(`Unsupported Parasolid schema ${schema}.`);
  const types = new Map(baseSchema());
  const layouts = new Map<number, FieldDef[]>();
  const nodes = new Map<number, XtNode>();
  for (;;) {
    const type = r.i16();
    if (type === 1) break; // terminator
    if (type > maxType || type < 2) throw new XtError(`Unexpected Parasolid node type ${type}.`);
    let layout = layouts.get(type);
    if (!layout) {
      const count = r.u8();
      const known = types.get(type);
      if (count === 255) {
        if (!known) throw new XtError(`Parasolid node type ${type} has no schema.`);
        layout = known.fields;
      } else if (known) {
        // Delta against the base layout: Copy, Delete, Insert, Append, then Z.
        layout = [];
        let k = 0;
        for (let op = r.chars(1); op !== 'Z'; op = r.chars(1)) {
          if (op === 'C') { const f = known.fields[k++]; if (!f) throw new XtError('Bad Parasolid schema delta.'); layout.push(f); }
          else if (op === 'D') k++;
          else if (op === 'I' || op === 'A') {
            const f = embeddedField(r);
            // Inserted arrays store their length one too high.
            if (op === 'I' && f.n > 2) f.n -= 1;
            layout.push(f);
          } else throw new XtError('Bad Parasolid schema delta.');
        }
      } else {
        const name = r.str8();
        r.str8(); // description
        const fields = Array.from({ length: count }, () => embeddedField(r));
        types.set(type, { name, variable: fields.length > 0 && fields[fields.length - 1].variable, fields });
        layout = fields;
      }
      layouts.set(type, layout);
    }
    const def = types.get(type)!;
    const repeat = def.variable ? r.i32() : 1;
    const id = r.i16();
    const f: Record<string, XtValue> = {};
    for (let i = 0; i < layout.length; i++) {
      f[layout[i].name] = readField(r, layout[i], def.variable && i === layout.length - 1 ? repeat : null);
    }
    nodes.set(id, { type, name: def.name, id, f });
  }
  return { version, schema, nodes };
}
