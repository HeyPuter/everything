import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDwg } from '../src/io/dwg/import.js';
import { readDatabase } from '../src/io/dwg/database.js';
import { dwgVersion, readContainer } from '../src/io/dwg/container.js';
import { parseDxf } from '../src/io/dxf/reader.js';
import { handleMessage } from '../src/io/dxf/worker.js';

/*
 * The fixtures are drawings of this app (sample.dxf, extras.dxf with the
 * entity types its DXF writer does not produce, hatches.dxf with edge-path,
 * spline-edge and gradient hatches) saved in each DWG version by the ODA
 * File Converter. Read from DWG they must match the DXF they came from.
 */
const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/dwg/${name}`, import.meta.url)));
const ref = (name) => parseDxf(fx(name)).drawing;

/** Paths where two drawings differ (numbers compared with a tolerance). */
function diff(a, b, path = '', out = []) {
  if (out.length > 50) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) out.push(`${path}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

const MODERN = ['2000', '2004', '2007', '2010', '2013', '2018'];

describe('DWG reader: versions', () => {
  for (const v of MODERN) {
    it(`reads the sample drawing saved as DWG ${v} exactly`, () => {
      const res = parseDwg(fx(`sample-r${v}.dwg`));
      expect(res.release).toBe(v);
      expect(diff(res.drawing, ref('sample.dxf'))).toEqual([]);
      expect(res.warnings.filter((w) => /damaged|could not/i.test(w))).toEqual([]);
    });
  }

  it('reads R14 and R13 drawings, which cannot hold lineweights or hatches', () => {
    const r14 = parseDwg(fx('sample-r14.dwg'));
    expect(r14.release).toBe('R14');
    // R14 has no lineweights: ByBlock comes back as ByLayer
    expect(diff(r14.drawing, ref('sample.dxf'))).toEqual(['.blocks[0].entities[0].lineweight: -1 vs -2']);
    const r13 = parseDwg(fx('sample-r13.dwg'));
    expect(r13.release).toBe('R13');
    const d = r13.drawing;
    const s = ref('sample.dxf');
    expect(d.layers.map((l) => l.name)).toEqual(s.layers.map((l) => l.name));
    // R13 stores hatches as anonymous blocks of lines
    expect(d.entities.filter((e) => e.type !== 'hatch' && e.type !== 'insert').length).toBe(s.entities.filter((e) => e.type !== 'hatch' && e.type !== 'insert').length);
  });

  for (const v of ['2000', '2007', '2018']) {
    it(`reads polylines, attributes, block arrays, solids and text alignments from DWG ${v}`, () => {
      const res = parseDwg(fx(`extras-r${v}.dwg`));
      expect(diff(res.drawing, ref('extras.dxf'))).toEqual([]);
      const d = res.drawing;
      const poly = d.entities.find((e) => e.type === 'polyline' && e.closed && e.width === 0.5);
      expect(poly.pts).toEqual([0, 0, 0, 20, 0, 0.5, 20, 10, 0, 0, 10, -0.25]);
      expect(d.entities.filter((e) => e.type === 'insert' && e.name === 'Sq').length).toBe(6);
      expect(d.entities.find((e) => e.type === 'text' && e.value === 'Pump 7')).toBeTruthy();
      expect(d.entities.find((e) => e.type === 'text' && e.value.startsWith('Ω 25°'))).toBeTruthy();
      expect(d.layers.find((l) => l.name === 'Off').on).toBe(false);
      expect(d.layers.find((l) => l.name === 'Frozen').frozen).toBe(true);
      expect(d.layers.find((l) => l.name === 'Locked').locked).toBe(true);
      expect(d.layers.find((l) => l.name === 'TrueColor').color).toBe('#3366cc');
      expect(d.layers.find((l) => l.name === 'Ünïcode Layer')).toBeTruthy();
      expect(res.stats.skipped).toEqual({ ATTDEF: 1, POLYLINE: 1, '3DFACE': 1 });
    });
  }

  it('reads R14 drawings saved by newer versions with their original names', () => {
    const d = parseDwg(fx('extras-r14.dwg')).drawing;
    // R14 only stores upper-case names; the round-trip record keeps the real ones
    expect(d.layers.map((l) => l.name)).toContain('TrueColor');
    expect(d.layers.find((l) => l.name === 'TrueColor').color).toBe('#3366cc');
    expect(d.textStyles.map((s) => s.name)).toContain('Narrow');
  });

  for (const v of ['2004', '2018']) {
    it(`reads edge-path, spline-edge and gradient hatches from DWG ${v}`, () => {
      expect(diff(parseDwg(fx(`hatches-r${v}.dwg`)).drawing, ref('hatches.dxf'))).toEqual([]);
    });
  }
});

describe('DWG reader: multileaders', () => {
  for (const v of ['2007', '2018']) {
    it(`reads multileader lines and text from DWG ${v}`, () => {
      const d = parseDwg(fx(`mleader-r${v}.dwg`)).drawing;
      // the sample drawing has one leader of its own, drawn first
      const leaders = d.entities.filter((e) => e.type === 'leader').slice(1);
      expect(leaders.map((e) => e.pts)).toEqual([
        [200, 120, 215, 134.75, 217, 134.75],
        [10, 10, 25, 30, 40, 29.333333333333332, 42, 29.333333333333332],
      ]);
      const notes = d.entities.filter((e) => e.type === 'mtext' && (e.value.startsWith('Drill') || e.value.startsWith('Two')));
      expect(notes.map((e) => [e.value, e.x, e.y, e.h])).toEqual([
        ['Drill 4x ∅ 8', 218, 136, 2.5],
        ['Two segment note', 43, 31, 2.5],
      ]);
    });
  }
});

describe('DWG reader: objects', () => {
  const files = ['sample-r2000.dwg', 'sample-r2004.dwg', 'sample-r2007.dwg', 'extras-r2000.dwg', 'extras-r2007.dwg', 'hatches-r2004.dwg', 'extras-r14.dwg'];
  for (const f of files) {
    it(`decodes every object of ${f} to its last bit`, () => {
      const db = readDatabase(fx(f), { check: true });
      expect(db.warnings).toEqual([]);
      const bad = [];
      for (const o of db.objects.values()) {
        if (o.error) bad.push(`${o.type}: ${o.error}`);
        else if (o.left && (o.left.data < 0 || o.left.data > 7 || o.left.handles < 0 || o.left.handles > 7 || o.left.strings > 7)) bad.push(`${o.type}: ${JSON.stringify(o.left)}`);
      }
      // R14 has no layout objects; its dictionary-with-default is laid out differently
      expect(bad.filter((b) => !b.startsWith('ACDBDICTIONARYWDFLT'))).toEqual([]);
    });
  }

  it('gives anonymous blocks unique numbered names', () => {
    const db = readDatabase(fx('sample-r2018.dwg'));
    const names = [...db.objects.values()].filter((o) => o.type === 'BLOCK_HEADER').map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => /^\*D\d+$/.test(n))).toBe(true);
  });

  it('reads the header variables', () => {
    for (const v of MODERN) {
      const h = readDatabase(fx(`sample-r${v}.dwg`)).header;
      expect(h.LTSCALE).toBe(0.5);
      expect(h.TEXTSIZE).toBe(3.5);
      expect(h.INSUNITS).toBe(4);
      expect(h.HANDSEED).toBeGreaterThan(0);
    }
  });
});

describe('DWG reader: other files', () => {
  it('recognises DWG signatures', () => {
    expect(dwgVersion(fx('sample-r2018.dwg'))).toBe('AC1032');
    expect(dwgVersion(new TextEncoder().encode('  0\r\nSECTION\r\n'))).toBe(null);
    expect(dwgVersion(new TextEncoder().encode('AC1009xxxxxx'))).toBe('AC1009');
  });

  it('explains which versions it cannot read', () => {
    const old = new Uint8Array(64);
    old.set(new TextEncoder().encode('AC1009'));
    expect(() => parseDwg(old)).toThrow(/R11\/R12.*DXF/);
    const newer = new Uint8Array(64);
    newer.set(new TextEncoder().encode('AC1040'));
    expect(() => parseDwg(newer)).toThrow(/newer format/);
    expect(() => parseDwg(new TextEncoder().encode('hello world'))).toThrow(/Not a DWG/);
  });

  it('explains that password-protected drawings cannot be opened', () => {
    const b = fx('sample-r2018.dwg').slice();
    b[0x18] |= 1;
    expect(() => parseDwg(b)).toThrow(/password/);
  });

  it('fails cleanly on truncated files', () => {
    for (const v of ['2000', '2004', '2007', '2018']) {
      const b = fx(`sample-r${v}.dwg`);
      for (const n of [0x40, 0x200, b.length >> 1]) {
        let res = null;
        try {
          res = parseDwg(b.slice(0, n));
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err.message.length).toBeGreaterThan(0);
          continue;
        }
        expect(res.drawing.layers.length).toBeGreaterThan(0);
      }
    }
  });

  it('reads the R2004+ section layout', () => {
    const c = readContainer(fx('sample-r2018.dwg'));
    expect(c.version).toBe('AC1032');
    expect(c.codepage).toBe(30);
    expect([...c.sections.header.subarray(0, 4)]).toEqual([0xcf, 0x7b, 0x1f, 0x23]);
  });

  it('opens DWG files through the worker', () => {
    const buffer = fx('sample-r2010.dwg').buffer;
    const reply = handleMessage({ id: 3, op: 'parse', buffer });
    expect(reply.ok).toBe(true);
    expect(reply.result.version).toBe('AC1024');
    expect(diff(reply.result.drawing, ref('sample.dxf'))).toEqual([]);
    // DXF still goes to the DXF reader
    expect(handleMessage({ id: 4, op: 'parse', buffer: fx('sample.dxf').buffer }).result.drawing.entities.length).toBeGreaterThan(0);
  });
});
