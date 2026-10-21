// Generator (manual): derives how modifier / constraint settings are stored in .blend DNA from the
// probe file written by tests/fixtures/blend/make_modifier_props.py, by diffing each probe
// object's data struct against the untouched one, and writes src/io/blend/modprops.gen.ts.
// Line rendering settings come from tests/fixtures/blend/make_lineset_props.py the same way, Grease
// Pencil layers and materials from tests/fixtures/blend/make_gp_props.py.
// Run: MODPROPS_BLEND=<modifiers.blend>,<linesets.blend> MODPROPS_OUT=src/io/blend/modprops.gen.ts npx vitest run tests/unit/r4-io-modprops.gen.test.ts
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { BlendFile, type BStruct } from '../../src/io/blend/reader';

const SRC = process.env.MODPROPS_BLEND ?? '';
const OUT = process.env.MODPROPS_OUT ?? '';

type Kind = 'MOD' | 'CON' | 'LINESET' | 'LINESTYLE' | 'FREESTYLE' | 'VIEWLAYER' | 'GPLAYER' | 'GPMAT' | 'STRIP';
interface Rec {
  kind: Kind;
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
    if (key === 'id' || key.startsWith('id.') || /(^|\.)(session_uid|persistent_uid)$/.test(key)) continue; // ID header, per-session values
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
  m?: number;
  i?: number;
  e?: Record<number, string>;
  b?: number;
  k?: number;
  ptr?: boolean;
  s?: boolean;
  n?: number;
}

async function derive(SRC: string, out: Record<string, { rna: string; kind: string; props: Record<string, Rule> }>) {
  const file = await BlendFile.open(new Uint8Array(readFileSync(SRC)));
  const recs = JSON.parse(readFileSync(`${SRC}.json`, 'utf8')) as Record<string, Rec>;
  const obs = new Map<string, BStruct>();
  for (const ob of file.ids('OB')) obs.set(ob.idName, ob);
  const scene = file.ids('SC')[0];
  const layers = scene ? scene.list('view_layers', 10000) : [];
  const styles = new Map(file.ids('LS').map((s) => [s.idName, s]));
  const gpLayers = new Map<string, BStruct>();
  const walkGp = (g: BStruct) => {
    for (const c of g.list('children', 100000)) {
      const b = c.sub('base');
      const nm = b ? file.cstringAt(b.ptr('name'), 256, b.block) : null;
      if (c.type === 'GreasePencilLayer' && nm) gpLayers.set(nm, c);
      else if (c.type === 'GreasePencilLayerTreeGroup') walkGp(c);
    }
  };
  for (const gp of file.ids('GP')) {
    const root = gp.ref('root_group_ptr');
    if (root) walkGp(root);
  }
  const mats = new Map(file.ids('MA').map((m) => [m.idName, m]));
  // sequencer strips of the probe scene, by name (stored with a two-letter prefix)
  const strips = new Map<string, BStruct>();
  const probeScene = file.ids('SC').find((x) => x.idName === 'Probe');
  const sed = probeScene?.ref('ed');
  for (const st of sed ? (sed.has('seqbase') ? sed.list('seqbase', 100000) : sed.list('strips', 100000)) : []) strips.set(st.str('name').slice(2), st);
  const dataOf = (name: string, kind: Kind): BStruct | null => {
    if (kind === 'STRIP') return strips.get(name) ?? null;
    if (kind === 'GPLAYER') return gpLayers.get(name) ?? null;
    if (kind === 'GPMAT') return mats.get(name)?.ref('gp_style') ?? null;
    if (kind === 'LINESET') return layers[0]?.sub('freestyle_config')?.list('linesets', 10000).find((l) => l.str('name') === name) ?? null;
    if (kind === 'LINESTYLE') return styles.get(name) ?? null;
    if (kind === 'FREESTYLE') return layers.find((l) => l.str('name') === name)?.sub('freestyle_config') ?? null;
    if (kind === 'VIEWLAYER') return layers.find((l) => l.str('name') === name) ?? null;
    const ob = obs.get(name);
    if (!ob) return null;
    if (kind === 'MOD') return ob.list('modifiers', 10)[0] ?? null;
    return ob.list('constraints', 10)[0]?.ref('data') ?? null;
  };
  // baselines per kind + rna type
  const base = new Map<string, { flat: Flat; dna: string }>();
  const groups = new Map<string, { name: string; rec: Rec }[]>();
  /** strips keep settings behind pointers: their data block, its transform / crop, and the effect data */
  const flatOf = (d: BStruct, kind: Kind): Flat => {
    const fl = flatten(d);
    if (kind !== 'STRIP') return fl;
    // each probe strip sits at its own frame: placement fields are not settings
    for (const k of ['start', 'startdisp', 'enddisp']) fl.delete(k);
    const sd = d.ref('strip') ?? d.ref('data');
    const field = d.has('strip') ? 'strip' : 'data';
    if (sd) {
      flatten(sd, `${field}.`, 1, fl);
      for (const p of ['transform', 'crop']) {
        const x = sd.ref(p);
        if (x) flatten(x, `${field}.${p}.`, 1, fl);
      }
    }
    const eff = d.ref('effectdata');
    if (eff) flatten(eff, 'effectdata.', 1, fl);
    return fl;
  };
  for (const [name, rec] of Object.entries(recs)) {
    const key = `${rec.kind}:${rec.rna}`;
    if (rec.prop === null) {
      const d = dataOf(name, rec.kind);
      if (d) base.set(key, { flat: flatOf(d, rec.kind), dna: rec.kind === 'STRIP' ? `${d.type}:${rec.rna}` : d.type });
      continue;
    }
    const g = `${key}:${rec.prop}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ name, rec });
  }
  for (const [g, list] of groups) {
    const [kind, rna, prop] = g.split(':');
    const b = base.get(`${kind}:${rna}`);
    if (!b) continue;
    const entry = (out[b.dna] ??= { rna, kind, props: {} });
    const flats = list.map((x) => ({ rec: x.rec, flat: (() => { const d = dataOf(x.name, kind as Kind); return d ? flatOf(d, kind as Kind) : null; })() })).filter((x) => x.flat);
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
          // values that differ only in some bits (an enum kept in a flags field): mask them
          const raws = Object.keys(e).map(Number);
          let mask = 0;
          for (const r of raws) mask |= (r ^ raws[0]) >>> 0;
          // only when the field also holds other settings (bits outside the enum in the untouched struct)
          const baseRaw = Number(b.flat.get(k) ?? 0);
          const shared = raws.reduce((a, r) => a & r, -1) & ~mask;
          if (mask && shared && (baseRaw & ~mask) !== 0) {
            const me: Record<number, string> = {};
            for (const r of raws) me[r & mask] = e[r];
            rule = { f: k, m: mask, e: me };
          } else rule = { f: k, e };
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
        if (Array.isArray(got)) {
          // one element of an array field (e.g. hsv[3])
          const base = b.flat.get(k) as number[] | undefined;
          const idx = got.findIndex((g, i) => eq(g as number, v) && !(base && eq(base[i], v)));
          if (idx >= 0) {
            rule = { f: k, i: idx };
            break;
          }
          continue;
        }
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
      // the field pointing at an ID block of the kind the probe assigned
      const want = /Collection/.test(String(x.rec.value)) ? 'GR' : /Texture/.test(String(x.rec.value)) ? 'TE' : /Image/.test(String(x.rec.value)) ? 'IM' : 'OB';
      for (const k of changed(x.flat!)) {
        const v = String(x.flat!.get(k));
        if (!v.startsWith('ptr:') || v === 'ptr:0') continue;
        const raw = v.slice(4);
        const hit = file.blockAt(/^\d+$/.test(raw) ? Number(raw) : raw);
        if (hit?.block.code === want) {
          rule = { f: k, ptr: true };
          break;
        }
      }
    }
    if (rule) entry.props[prop] = rule;
  }
}

it.skipIf(!SRC || !OUT)('derive modifier / constraint / line rendering DNA rules', async () => {
  const out: Record<string, { rna: string; kind: string; props: Record<string, Rule> }> = {};
  for (const src of SRC.split(',')) await derive(src, out);
  const lines = [
    '// GENERATED (see tests/fixtures/blend/make_modifier_props.py and tests/unit/r4-io-modprops.gen.test.ts):',
    '// for every modifier and constraint type, one object per changed setting was written by a bpy script',
    "// and the DNA field that changed was recorded by reading the file back with this package's reader.",
    '// Keyed by DNA struct name; f = field path, e = value -> enum identifier (m: of the masked bits), b = bit mask (negative =',
    '// inverted bit, 0 = whole value), k = stored value / property value, n = array length, i = element',
    '// of an array field, s = string,',
    '// ptr = ID pointer.',
    'export interface DnaPropRule {',
    '  f: string;',
    '  e?: Record<number, string>;',
    '  m?: number;',
    '  i?: number;',
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
    lines.push(`  ${/^\w+$/.test(dna) ? dna : JSON.stringify(dna)}: {`, `    rna: ${JSON.stringify(e.rna)},`, `    kind: ${JSON.stringify(e.kind)},`, '    props: {');
    for (const p of Object.keys(e.props).sort()) lines.push(`      ${/^[a-z_][a-z0-9_]*$/i.test(p) ? p : JSON.stringify(p)}: ${JSON.stringify(e.props[p]).replace(/"(\w+)":/g, '$1: ')},`);
    lines.push('    },', '  },');
  }
  lines.push('};', '');
  writeFileSync(OUT, lines.join('\n'));
}, 300000);
