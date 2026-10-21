// Generator (manual): derives how modifier / constraint settings are stored in .blend DNA from the
// probe file written by tests/fixtures/blend/make_modifier_props.py, by diffing each probe
// object's data struct against the untouched one, and writes src/io/blend/modprops.gen.ts.
// Run: MODPROPS_BLEND=<probe.blend> MODPROPS_OUT=src/io/blend/modprops.gen.ts npx vitest run tests/unit/r4-io-modprops.gen.test.ts
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { BlendFile, type BStruct } from '../../src/io/blend/reader';

const SRC = process.env.MODPROPS_BLEND ?? '';
const OUT = process.env.MODPROPS_OUT ?? '';

interface Rec {
  kind: 'MOD' | 'CON';
  rna: string;
  prop: string | null;
  type: string | null;
  value: unknown;
  default: unknown;
}

type Flat = Map<string, unknown>;

function flatten(s: BStruct, prefix = '', depth = 0, out: Flat = new Map()): Flat {
  for (const f of s.st.fields) {
    const key = prefix + f.name;
    if (key === 'modifier' || key.startsWith('modifier.')) continue; // the shared header
    if (f.nameInfo.pointer) out.set(key, `ptr:${s.ptr(f.name)}`);
    else if (f.structIndex >= 0) {
      if (depth < 3 && f.nameInfo.arrayLen <= 1) {
        const sub = s.sub(f.name);
        if (sub) flatten(sub, `${key}.`, depth + 1, out);
      }
    } else if (f.type === 'char' && f.nameInfo.arrayLen > 1) out.set(key, s.str(f.name));
    else if (f.nameInfo.arrayLen > 1) out.set(key, s.nums(f.name));
    else out.set(key, s.num(f.name));
  }
  return out;
}

const eq = (a: unknown, b: unknown, tol = 1e-4): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length >= b.length && b.every((x, i) => eq(a[i], x, tol));
  return a === b;
};

interface Rule {
  f: string;
  e?: Record<number, string>;
  b?: number;
  k?: number;
  ptr?: boolean;
  s?: boolean;
  n?: number;
}

it.skipIf(!SRC || !OUT)('derive modifier / constraint DNA rules', async () => {
  const file = await BlendFile.open(new Uint8Array(readFileSync(SRC)));
  const recs = JSON.parse(readFileSync(`${SRC}.json`, 'utf8')) as Record<string, Rec>;
  const obs = new Map<string, BStruct>();
  for (const ob of file.ids('OB')) obs.set(ob.idName, ob);
  const dataOf = (name: string, kind: 'MOD' | 'CON'): BStruct | null => {
    const ob = obs.get(name);
    if (!ob) return null;
    if (kind === 'MOD') return ob.list('modifiers', 10)[0] ?? null;
    return ob.list('constraints', 10)[0]?.ref('data') ?? null;
  };
  // baselines per kind + rna type
  const base = new Map<string, { flat: Flat; dna: string }>();
  const groups = new Map<string, { name: string; rec: Rec }[]>();
  for (const [name, rec] of Object.entries(recs)) {
    const key = `${rec.kind}:${rec.rna}`;
    if (rec.prop === null) {
      const d = dataOf(name, rec.kind);
      if (d) base.set(key, { flat: flatten(d), dna: d.type });
      continue;
    }
    const g = `${key}:${rec.prop}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ name, rec });
  }
  const out: Record<string, { rna: string; kind: string; props: Record<string, Rule> }> = {};
  for (const [g, list] of groups) {
    const [kind, rna, prop] = g.split(':');
    const b = base.get(`${kind}:${rna}`);
    if (!b) continue;
    const entry = (out[b.dna] ??= { rna, kind, props: {} });
    const flats = list.map((x) => ({ rec: x.rec, flat: (() => { const d = dataOf(x.name, kind as 'MOD'); return d ? flatten(d) : null; })() })).filter((x) => x.flat);
    if (!flats.length) continue;
    const t = list[0].rec.type;
    const changed = (f: Flat) => [...f.keys()].filter((k) => !eq(f.get(k), b.flat.get(k), 0) && JSON.stringify(f.get(k)) !== JSON.stringify(b.flat.get(k)));
    let rule: Rule | null = null;
    if (t === 'ENUM') {
      // a field whose value differs per item
      const cand = new Set<string>();
      for (const x of flats) for (const k of changed(x.flat!)) cand.add(k);
      for (const k of cand) {
        const e: Record<number, string> = {};
        let ok = true;
        for (const x of flats) {
          const v = x.flat!.get(k);
          if (typeof v !== 'number') {
            ok = false;
            break;
          }
          if (e[v] !== undefined && e[v] !== x.rec.value) {
            ok = false;
            break;
          }
          e[v] = String(x.rec.value);
        }
        if (ok && Object.keys(e).length >= Math.min(2, flats.length)) {
          rule = { f: k, e };
          break;
        }
      }
    } else if (t === 'BOOLEAN') {
      const on = flats.find((x) => x.rec.value === true)?.flat,
        off = flats.find((x) => x.rec.value === false)?.flat;
      if (on && off) {
        for (const k of on.keys()) {
          const a = on.get(k),
            c = off.get(k);
          if (typeof a !== 'number' || typeof c !== 'number' || a === c) continue;
          const x = (a ^ c) >>> 0;
          if (x && (x & (x - 1)) === 0) {
            rule = { f: k, b: a & x ? x : -x };
            break;
          }
          if (a === 1 && c === 0) {
            rule = { f: k, b: 0 };
            break;
          }
        }
      }
    } else if (t === 'INT' || t === 'FLOAT') {
      const x = flats[0];
      const v = Number(x.rec.value);
      for (const k of changed(x.flat!)) {
        const got = x.flat!.get(k);
        if (typeof got !== 'number') continue;
        if (eq(got, v)) {
          rule = { f: k };
          break;
        }
        for (const s of [100, 0.01, Math.PI / 180, 180 / Math.PI, 2, 0.5])
          if (eq(got, v * s)) {
            rule = { f: k, k: s };
            break;
          }
        if (rule) break;
      }
    } else if (t === 'FLOAT_ARRAY') {
      const x = flats[0];
      const v = x.rec.value as number[];
      for (const k of changed(x.flat!)) if (eq(x.flat!.get(k), v)) rule = { f: k, n: v.length };
    } else if (t === 'STRING') {
      const x = flats[0];
      for (const k of changed(x.flat!)) if (x.flat!.get(k) === x.rec.value) rule = { f: k, s: true };
    } else if (t === 'POINTER') {
      const x = flats[0];
      for (const k of changed(x.flat!)) if (String(x.flat!.get(k)).startsWith('ptr:') && x.flat!.get(k) !== 'ptr:0') rule = { f: k, ptr: true };
    }
    if (rule) entry.props[prop] = rule;
  }
  const lines = [
    '// GENERATED (see tests/fixtures/blend/make_modifier_props.py and tests/unit/r4-io-modprops.gen.test.ts):',
    '// for every modifier and constraint type, one object per changed setting was written by a bpy script',
    "// and the DNA field that changed was recorded by reading the file back with this package's reader.",
    '// Keyed by DNA struct name; f = field path, e = value -> enum identifier, b = bit mask (negative =',
    '// inverted bit, 0 = whole value), k = stored value / property value, n = array length, s = string,',
    '// ptr = ID pointer.',
    'export interface DnaPropRule {',
    '  f: string;',
    '  e?: Record<number, string>;',
    '  b?: number;',
    '  k?: number;',
    '  n?: number;',
    '  s?: boolean;',
    '  ptr?: boolean;',
    '}',
    '',
    'export const DNA_PROP_RULES: Record<string, { rna: string; kind: string; props: Record<string, DnaPropRule> }> = {',
  ];
  for (const dna of Object.keys(out).sort()) {
    const e = out[dna];
    lines.push(`  ${dna}: {`, `    rna: ${JSON.stringify(e.rna)},`, `    kind: ${JSON.stringify(e.kind)},`, '    props: {');
    for (const p of Object.keys(e.props).sort()) lines.push(`      ${/^[a-z_][a-z0-9_]*$/i.test(p) ? p : JSON.stringify(p)}: ${JSON.stringify(e.props[p]).replace(/"(\w+)":/g, '$1: ')},`);
    lines.push('    },', '  },');
  }
  lines.push('};', '');
  writeFileSync(OUT, lines.join('\n'));
}, 300000);
