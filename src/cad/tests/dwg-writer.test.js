import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { writeDwg } from '../src/io/dwg/writer.js';
import { parseDwg } from '../src/io/dwg/import.js';
import { readDatabase, readObjectMap } from '../src/io/dwg/database.js';
import { readContainer } from '../src/io/dwg/container.js';
import { BitReader, crc16, crc32, R2000 } from '../src/io/dwg/bits.js';
import { headerMask, checksum2004 } from '../src/io/dwg/container.js';
import { writeDxf } from '../src/io/dxf/writer.js';
import { parseDxf } from '../src/io/dxf/reader.js';
import { handleMessage } from '../src/io/dxf/worker.js';
import { exportPayload } from '../src/io/dxf-client.js';
import { sampleDrawing } from '../src/core/sample.js';
import { Drawing } from '../src/core/drawing.js';
import { defaultHeader, defaultLayer } from '../src/core/schema.js';
import { defaultTextStyle, defaultDimStyle } from '../src/core/styles.js';

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

const ent = (type, extra) => ({ id: 0, type, layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, ...extra });
const dimBase = { x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0, lx: 0, ly: 0, rot: 0, text: '', style: 'Standard' };

/** A drawing with every entity type and table feature of the model. */
function everything() {
  const entities = [
    ent('line', { layer: 'Walls', color: 1, x1: 0, y1: 0, x2: 100, y2: 50 }),
    ent('xline', { x: 1, y: 2, dx: 0.6, dy: 0.8 }),
    ent('ray', { x: -1, y: -2, dx: 0, dy: 1 }),
    ent('circle', { cx: 10, cy: 20, r: 5, linetype: 'Dashed', lineweight: 50, ltscale: 2 }),
    ent('arc', { cx: 0, cy: 0, r: 7, start: 0.25, end: 4 }),
    ent('ellipse', { cx: 3, cy: 4, mx: 10, my: 5, ratio: 0.4, start: 0.5, end: 5 }),
    ent('polyline', { pts: [0, 0, 0.5, 10, 0, 0, 10, 10, -0.3, 0, 10, 0], closed: true, width: 0.7 }),
    ent('polyline', { pts: [0, 0, 0, 5, 5, 1, 10, 0, 0], closed: false, width: 0 }),
    ent('spline', { degree: 3, ctrl: [0, 0, 2, 5, 6, 5, 8, 0, 12, 3], knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1], fit: [], closed: false }),
    ent('point', { x: 4, y: 5, layer: 'Hidden' }),
    ent('text', { x: 1, y: 2, h: 3, rot: 0.3, value: 'Café 50% ^2\tend', style: 'Notes', halign: 'right', valign: 'top', widthFactor: 0.8, oblique: 0.2 }),
    ent('text', { x: 1, y: 2, h: 3, rot: 0, value: 'plain', style: 'Standard', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 }),
    ent('mtext', { x: 5, y: 6, h: 2.5, rot: 1, style: 'Standard', width: 40, attach: 'mc', lineSpacing: 1.5, value: 'Line {1}\nback\\slash ° caret^x ' + 'long '.repeat(80) }),
    ent('dimension', { ...dimBase, dimType: 'linear', x2: 10, lx: 5, ly: 8, style: 'ISO' }),
    ent('dimension', { ...dimBase, dimType: 'aligned', x2: 10, y2: 10, lx: 2, ly: 9, text: 'L=<>' }),
    ent('dimension', { ...dimBase, dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, lx: 4, ly: 4 }),
    ent('dimension', { ...dimBase, dimType: 'radius', x1: 10, y1: 20, x2: 15, y2: 20, lx: 18, ly: 22 }),
    ent('dimension', { ...dimBase, dimType: 'diameter', x1: 10, y1: 20, x2: 10, y2: 25, lx: 12, ly: 30 }),
    ent('dimension', { ...dimBase, dimType: 'ordinate', x1: 3, y1: 4, x2: 3, y2: 9, lx: 3, ly: 9, ordAxis: 'x' }),
    ent('leader', { pts: [0, 0, 5, 5, 10, 5], text: 'Note', h: 2.5, style: 'Standard' }),
    ent('hatch', { loops: [[0, 0, 0, 10, 0, 0.4, 10, 10, 0, 0, 10, 0], [2, 2, 0, 4, 2, 0, 3, 4, 0]], pattern: 'SOLID', scale: 1, angle: 0, color: 5 }),
    ent('hatch', { loops: [[0, 0, 0, 10, 0, 0, 10, 10, 0]], pattern: 'ANSI31', scale: 2, angle: 0.5 }),
    ent('insert', { name: 'Bolt', x: 50, y: 60, sx: 2, sy: -1, rot: 1.2 }),
  ];
  entities.forEach((e, i) => (e.id = i + 1));
  return {
    version: 1,
    header: { ...defaultHeader(), units: 'in', linearFormat: 'architectural', linearPrecision: 3, ltscale: 2, clayer: 'Walls', textStyle: 'Notes', dimStyle: 'ISO', textHeight: 3, pdmode: 3, pdsize: 1.5, nextId: entities.length + 1 },
    layers: [
      defaultLayer('0'),
      { ...defaultLayer('Walls'), color: 30, on: false },
      { ...defaultLayer('Hidden'), color: 3, frozen: true, locked: true, lineweight: 35, plot: false, transparency: 50, description: 'Hidden stuff', linetype: 'Dashed' },
      { ...defaultLayer('Ünïcode'), color: 2 },
    ],
    linetypes: [
      { name: 'Continuous', description: 'Solid line', pattern: [] },
      { name: 'Dashed', description: 'Dashed __ __', pattern: [12, -6] },
    ],
    textStyles: [defaultTextStyle('Standard'), { ...defaultTextStyle('Notes'), font: 'mono', widthFactor: 0.8, oblique: 0.2 }],
    dimStyles: [defaultDimStyle('Standard'), { ...defaultDimStyle('ISO'), arrowType: 'open', textHeight: 3.5, precision: 3, scale: 2 }],
    blocks: [{ name: 'Bolt', bx: 1, by: 2, entities: [ent('circle', { id: 1, cx: 0, cy: 0, r: 1, color: 0 }), ent('line', { id: 2, x1: -1, y1: 0, x2: 1, y2: 0 })], description: '' }],
    entities,
  };
}

/** Stand-in for the app's dimension renderer. */
function dimensionEntities(d) {
  const b = { layer: '0', color: 0, linetype: 'ByBlock', lineweight: -2, ltscale: 1 };
  return [ent('line', { ...b, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }), ent('text', { ...b, x: d.lx, y: d.ly, h: 2.5, rot: 0, value: '10.00', style: 'Standard', halign: 'center', valign: 'bottom', widthFactor: 1, oblique: 0 })];
}

const hatchPatterns = { ANSI31: [[45, 0, 0, 0, 3.175]] };

describe('DWG writer', () => {
  it('writes the sample drawing so that it reads back exactly', () => {
    const p = exportPayload(sampleDrawing());
    const bytes = writeDwg(p.drawing, p.opts);
    const back = parseDwg(bytes);
    expect(back.version).toBe('AC1018');
    expect(diff(back.drawing, parseDxf(writeDxf(p.drawing, p.opts)).drawing)).toEqual([]);
  });

  it('writes every entity type and table feature', () => {
    const d = everything();
    const opts = { dimensionEntities, hatchPatterns };
    const warnings = [];
    const back = parseDwg(writeDwg(d, { ...opts, warnings }));
    expect(warnings).toEqual([]);
    expect(diff(back.drawing, parseDxf(writeDxf(d, opts)).drawing)).toEqual([]);
    const text = back.drawing.entities.find((e) => e.type === 'text' && e.style === 'Notes');
    // single-line text cannot hold tabs: the DXF writer makes them spaces
    expect(text.value).toBe('Café 50% ^2 end');
    expect(back.drawing.layers.find((l) => l.name === 'Hidden')).toMatchObject({ frozen: true, locked: true, lineweight: 35, plot: false, transparency: 50, description: 'Hidden stuff' });
    expect(back.drawing.layers.find((l) => l.name === 'Walls').on).toBe(false);
  });

  for (const version of [2000, 2004]) it(`produces DWG ${version} objects that decode to their last bit`, () => {
    const db = readDatabase(writeDwg(everything(), { dimensionEntities, hatchPatterns, version }), { check: true });
    expect(db.warnings).toEqual([]);
    const bad = [...db.objects.values()].filter((o) => o.error || (o.left && (o.left.data < 0 || o.left.data > 7 || o.left.handles < 0 || o.left.handles > 7)));
    expect(bad.map((o) => o.type)).toEqual([]);
    const types = new Set([...db.objects.values()].map((o) => o.type));
    for (const t of ['BLOCK_CONTROL', 'LAYER_CONTROL', 'LTYPE_CONTROL', 'VPORT_CONTROL', 'LAYOUT', 'MLINESTYLE', 'ACDBDICTIONARYWDFLT', 'ACDBPLACEHOLDER', 'VPORT']) expect(types.has(t)).toBe(true);
    // the viewport entity header table only exists up to R2000
    expect(types.has('VX_CONTROL')).toBe(version === 2000);
    const h = db.header;
    for (const k of ['BLOCK_MODEL_SPACE', 'BLOCK_PAPER_SPACE', 'DICT_NAMED', 'DICT_LAYOUT', 'DICT_MLINESTYLE', 'LTYPE_CONTINUOUS', 'CLAYER', 'CMLSTYLE']) expect(db.objects.has(h[k])).toBe(true);
    expect(h.HANDSEED).toBeGreaterThan(Math.max(...db.objects.keys()));
    const root = db.objects.get(h.DICT_NAMED);
    expect(root.names).toEqual(['ACAD_GROUP', 'ACAD_LAYOUT', 'ACAD_MLINESTYLE', 'ACAD_PLOTSETTINGS', 'ACAD_PLOTSTYLENAME']);
    const ms = db.objects.get(h.BLOCK_MODEL_SPACE);
    expect(db.objects.get(ms.layout).layoutName).toBe('Model');
  });

  it('draws hatches whose pattern has no definition as 45 degree lines', () => {
    const d = everything();
    const warnings = [];
    const db = readDatabase(writeDwg(d, { dimensionEntities, warnings }));
    const h = [...db.objects.values()].find((o) => o.type === 'HATCH' && o.name === 'ANSI31');
    expect(h.lines.length).toBe(1);
    expect(warnings.some((w) => /ANSI31.*45/.test(w))).toBe(true);
  });

  it('writes DWG 2000 on request, with colors as color numbers', () => {
    const d = everything();
    d.layers[1].color = '#ff8000';
    const opts = { dimensionEntities, hatchPatterns };
    const back = parseDwg(writeDwg(d, { ...opts, version: 2000 }));
    expect(back.version).toBe('AC1015');
    const ref = parseDxf(writeDxf(d, opts)).drawing;
    expect(diff(back.drawing, ref)).toEqual(['.layers[1].color: 30 vs "#ff8000"']);
    expect(() => writeDwg(d, { version: 2099 })).toThrow(/version/);
  });

  it('keeps true colors and layer transparency in DWG 2004', () => {
    const d = everything();
    d.layers[1].color = '#ff8000';
    d.entities[2].color = '#336699';
    const back = parseDwg(writeDwg(d, { dimensionEntities, hatchPatterns })).drawing;
    expect(back.layers[1].color).toBe('#ff8000');
    expect(back.entities[2].color).toBe('#336699');
    expect(back.layers.find((l) => l.name === 'Hidden').transparency).toBe(50);
  });

  it('writes valid DWG 2004 checksums', () => {
    const u8 = writeDwg(everything(), { dimensionEntities, hatchPatterns });
    const mask = headerMask(0x6c);
    const h = u8.slice(0x80, 0x80 + 0x6c).map((x, i) => x ^ mask[i]);
    expect(new TextDecoder().decode(h.subarray(0, 11))).toBe('AcFssFcAJMB');
    const crc = h[0x68] | (h[0x69] << 8) | (h[0x6a] << 16) | (h[0x6b] << 24);
    h.fill(0, 0x68, 0x6c);
    expect(crc >>> 0).toBe(crc32(h, 0, 0x6c, 0));
    // the copy at the end of the file
    expect([...u8.subarray(u8.length - 0x6c)]).toEqual([...u8.subarray(0x80, 0x80 + 0x6c)]);
    // every data page: header checksum seeded with the data checksum
    const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
    let pages = 0;
    for (let a = 0x100; a + 32 <= u8.length - 0x6c; ) {
      const m = (0x4164536b ^ a) >>> 0;
      const w = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (u32(u8, a + i * 4) ^ m) >>> 0);
      if (w[0] !== 0x4163043b) {
        // system pages: section map and page map
        const type = u32(u8, a);
        expect([0x4163003b, 0x41630e3b]).toContain(type);
        const hb = u8.slice(a, a + 20);
        hb.fill(0, 16, 20);
        expect(checksum2004(checksum2004(0, hb, 0, 20), u8, a + 20, a + 20 + u32(u8, a + 8))).toBe(u32(u8, a + 16));
        a += (20 + u32(u8, a + 8) + 31) & ~31;
        continue;
      }
      const dataSum = checksum2004(0, u8, a + 32, a + 32 + w[2]);
      expect(dataSum).toBe(w[7]);
      const hb = new Uint8Array(32);
      w.forEach((v, i) => {
        const x = i === 6 ? 0 : v;
        hb.set([x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24], i * 4);
      });
      expect(checksum2004(dataSum, hb, 0, 32)).toBe(w[6]);
      a += w[3];
      pages++;
    }
    expect(pages).toBeGreaterThan(5);
  });

  it('writes valid DWG 2000 checksums', () => {
    const u8 = writeDwg(everything(), { dimensionEntities, hatchPatterns, version: 2000 });
    const n = u8[0x15];
    const at = 0x19 + n * 9;
    expect(u8[at] | (u8[at + 1] << 8)).toBe(crc16(u8, 0, at, 0) ^ 0x8461);
    const c = readContainer(u8);
    for (const sec of [c.sections.header, c.sections.classes]) {
      const size = sec[16] | (sec[17] << 8) | (sec[18] << 16) | (sec[19] << 24);
      expect(sec[20 + size] | (sec[21 + size] << 8)).toBe(crc16(sec, 16, 20 + size, 0xc0c1));
    }
    const map = c.sections.handles;
    const size = (map[0] << 8) | map[1];
    expect((map[size] << 8) | map[size + 1]).toBe(crc16(map, 0, size, 0xc0c1));
    for (const loc of readObjectMap(map).values()) {
      const r = new BitReader(u8, R2000, loc * 8);
      const len = r.MS();
      const end = (r.pos >> 3) + len;
      expect(u8[end] | (u8[end + 1] << 8)).toBe(crc16(u8, loc, end, 0xc0c1));
    }
  });

  it('writes an empty drawing', () => {
    const d = { version: 1, header: defaultHeader(), layers: [defaultLayer('0')], linetypes: [], textStyles: [], dimStyles: [], blocks: [], entities: [] };
    const back = parseDwg(writeDwg(d));
    expect(back.drawing.entities).toEqual([]);
    expect(back.drawing.layers.map((l) => l.name)).toEqual(['0']);
  });

  it('keeps many objects addressable (object map split into pages)', () => {
    const d = everything();
    const lines = [];
    for (let i = 0; i < 3000; i++) lines.push(ent('line', { id: 100 + i, x1: i, y1: 0, x2: i, y2: 10 }));
    d.entities = lines;
    const back = parseDwg(writeDwg(d, { dimensionEntities, hatchPatterns }));
    expect(back.drawing.entities.length).toBe(3000);
    expect(back.drawing.entities[2999].x1).toBe(2999);
  });

  it('writes DWG files through the worker', () => {
    const p = exportPayload(sampleDrawing());
    const reply = handleMessage({ id: 9, op: 'writeDwg', drawing: p.drawing, opts: p.opts });
    expect(reply.ok).toBe(true);
    expect(reply.result.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(reply.result.bytes.subarray(0, 6))).toBe('AC1018');
    const again = handleMessage({ id: 10, op: 'parse', buffer: reply.result.bytes.buffer });
    expect(again.ok).toBe(true);
    expect(again.result.drawing.entities.length).toBe(p.drawing.entities.length);
  });

  it('matches a DWG saved by another program for the same drawing', () => {
    // sample-r2000.dwg was written by the ODA File Converter from sample.dxf
    const ref = parseDwg(new Uint8Array(readFileSync(new URL('./fixtures/dwg/sample-r2000.dwg', import.meta.url)))).drawing;
    const src = new Drawing(parseDxf(new Uint8Array(readFileSync(new URL('./fixtures/dwg/sample.dxf', import.meta.url)))).drawing);
    const p = exportPayload(src);
    const ours = parseDwg(writeDwg(p.drawing, p.opts)).drawing;
    expect(ours.entities.length).toBe(ref.entities.length);
    expect(ours.layers.map((l) => [l.name, l.color, l.linetype, l.lineweight])).toEqual(ref.layers.map((l) => [l.name, l.color, l.linetype, l.lineweight]));
  });
});
