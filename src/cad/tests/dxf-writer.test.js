import { describe, it, expect } from 'vitest';
import { writeDxf, fmt, encodeMtext, encodeString } from '../src/io/dxf/writer.js';
import { parseDxf } from '../src/io/dxf/reader.js';
import { handleMessage } from '../src/io/dxf/worker.js';
import { defaultHeader, defaultLayer } from '../src/core/schema.js';
import { defaultTextStyle, defaultDimStyle } from '../src/core/styles.js';
import { splineFromFitPoints } from '../src/core/geom/index.js';
import { Drawing } from '../src/core/drawing.js';
import { exportPayload } from '../src/io/dxf-client.js';
import { PATTERNS } from '../src/core/hatch/patterns.js';

const TAU = Math.PI * 2;

function ent(type, extra) {
  return { id: 0, type, layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, ...extra };
}

const dimBase = { x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0, lx: 0, ly: 0, rot: 0, text: '', style: 'Standard' };

/** A drawing that uses every entity type and table feature. */
function sampleDrawing() {
  const entities = [
    ent('line', { layer: 'Walls', color: 1, x1: 0, y1: 0, x2: 100, y2: 50 }),
    ent('xline', { x: 1, y: 2, dx: 0.6, dy: 0.8 }),
    ent('ray', { x: -1, y: -2, dx: 0, dy: 1, color: '#336699' }),
    ent('circle', { cx: 10, cy: 20, r: 5, linetype: 'Dashed', lineweight: 50, ltscale: 2 }),
    ent('arc', { cx: 0, cy: 0, r: 7, start: 0.25, end: 4 }),
    ent('ellipse', { cx: 3, cy: 4, mx: 10, my: 5, ratio: 0.4, start: 0.5, end: 5 }),
    ent('ellipse', { cx: 0, cy: 0, mx: 0, my: 6, ratio: 0.5, start: 0, end: TAU }),
    ent('polyline', { pts: [0, 0, 0.5, 10, 0, 0, 10, 10, -0.3, 0, 10, 0], closed: true, width: 0.7 }),
    ent('polyline', { pts: [0, 0, 0, 5, 5, 1, 10, 0, 0], closed: false, width: 0 }),
    ent('spline', { degree: 3, ctrl: [0, 0, 2, 5, 6, 5, 8, 0, 12, 3], knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1], fit: [], closed: false }),
    ent('point', { x: 4, y: 5, layer: 'Hidden' }),
    ent('text', { x: 1, y: 2, h: 3, rot: 0.3, value: 'Café 50% ^2', style: 'Notes', halign: 'right', valign: 'top', widthFactor: 0.8, oblique: 0.2 }),
    ent('text', { x: 1, y: 2, h: 3, rot: 0, value: 'plain', style: 'Standard', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 }),
    ent('mtext', {
      x: 5, y: 6, h: 2.5, rot: 1, style: 'Standard', width: 40, attach: 'mc', lineSpacing: 1.5,
      value: 'Line {1}\nback\\slash ° caret^x ' + 'long '.repeat(80),
    }),
    ent('dimension', { ...dimBase, dimType: 'linear', x2: 10, lx: 5, ly: 8, style: 'ISO' }),
    ent('dimension', { ...dimBase, dimType: 'linear', x1: 0, y1: 0, x2: 4, y2: 9, lx: 12, ly: 1, rot: Math.PI / 2 }),
    ent('dimension', { ...dimBase, dimType: 'aligned', x2: 10, y2: 10, lx: 2, ly: 9, text: 'L=<>' }),
    ent('dimension', { ...dimBase, dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, lx: 4, ly: 4 }),
    ent('dimension', { ...dimBase, dimType: 'radius', x1: 10, y1: 20, x2: 15, y2: 20, lx: 18, ly: 22 }),
    ent('dimension', { ...dimBase, dimType: 'diameter', x1: 10, y1: 20, x2: 10, y2: 25, lx: 12, ly: 30 }),
    ent('dimension', { ...dimBase, dimType: 'ordinate', x1: 3, y1: 4, x2: 3, y2: 9, lx: 3, ly: 9, ordAxis: 'x' }),
    ent('leader', { pts: [0, 0, 5, 5, 10, 5], text: 'Note', h: 2.5, style: 'Standard' }),
    ent('leader', { pts: [0, 0, -5, 5], text: '', h: 2.5, style: 'Standard' }),
    ent('hatch', { loops: [[0, 0, 0, 10, 0, 0.4, 10, 10, 0, 0, 10, 0], [2, 2, 0, 4, 2, 0, 3, 4, 0]], pattern: 'SOLID', scale: 1, angle: 0, color: 5 }),
    ent('hatch', { loops: [[0, 0, 0, 10, 0, 0, 10, 10, 0]], pattern: 'ANSI31', scale: 2, angle: 0.5 }),
    ent('insert', { name: 'Bolt', x: 50, y: 60, sx: 2, sy: -1, rot: 1.2 }),
  ];
  entities.forEach((e, i) => (e.id = i + 1));
  const blockEntities = [
    ent('circle', { id: 1, cx: 0, cy: 0, r: 1, color: 0 }),
    ent('line', { id: 2, x1: -1, y1: 0, x2: 1, y2: 0 }),
    ent('dimension', { ...dimBase, id: 3, dimType: 'aligned', x1: -1, y1: 0, x2: 1, y2: 0, lx: 0, ly: 2 }),
  ];
  return {
    version: 1,
    header: {
      ...defaultHeader(),
      units: 'in', linearFormat: 'architectural', linearPrecision: 3, angularFormat: 'dms', angularPrecision: 2,
      ltscale: 2, clayer: 'Walls', textStyle: 'Notes', dimStyle: 'ISO', textHeight: 3, pdmode: 3, pdsize: 1.5,
      nextId: entities.length + 1,
    },
    layers: [
      defaultLayer('0'),
      { ...defaultLayer('Walls'), color: '#ff8000', on: false },
      { ...defaultLayer('Hidden'), color: 3, frozen: true, locked: true, lineweight: 35, plot: false, transparency: 50, description: 'Hidden stuff', linetype: 'Dashed' },
    ],
    linetypes: [
      { name: 'Continuous', description: 'Solid line', pattern: [] },
      { name: 'Dashed', description: 'Dashed __ __', pattern: [12, -6] },
      { name: 'DashDot', description: 'Dash dot', pattern: [12, -4, 0, -4] },
    ],
    textStyles: [defaultTextStyle('Standard'), { ...defaultTextStyle('Notes'), font: 'mono', widthFactor: 0.8, oblique: 0.2 }],
    dimStyles: [
      defaultDimStyle('Standard'),
      {
        ...defaultDimStyle('ISO'),
        arrowType: 'open', textHeight: 3.5, precision: 3, trailingZeros: true, prefix: '~', suffix: ' mm',
        textStyle: 'Notes', textPlacement: 'centered', textAlign: 'horizontal', scale: 2, textGap: 1,
        arrowSize: 3, extOffset: 1, extExtend: 2, centerMark: 1.5,
      },
    ],
    blocks: [{ name: 'Bolt', bx: 1, by: 2, entities: blockEntities, description: '' }],
    entities,
  };
}

/** Stand-in for the app's dimension renderer. */
function dimensionEntities(d) {
  const b = { layer: '0', color: 0, linetype: 'ByBlock', lineweight: -2, ltscale: 1 };
  return [
    ent('line', { ...b, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }),
    ent('hatch', { ...b, loops: [[d.x1, d.y1, 0, d.x1 + 1, d.y1 + 0.2, 0, d.x1 + 1, d.y1 - 0.2, 0]], pattern: 'SOLID', scale: 1, angle: 0 }),
    ent('text', { ...b, x: d.lx, y: d.ly, h: 2.5, rot: 0, value: '10.00', style: 'Standard', halign: 'center', valign: 'bottom', widthFactor: 1, oblique: 0 }),
  ];
}

/** Split DXF text into records of { type, g: [[code, value], ...] }. */
function records(text) {
  const lines = text.split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 2) {
    const code = +lines[i];
    if (code === 0) {
      cur = { type: lines[i + 1], g: [] };
      out.push(cur);
    } else cur.g.push([code, lines[i + 1]]);
  }
  return out;
}

const val = (r, code) => r.g.find((x) => x[0] === code)?.[1];
const subclasses = (r) => r.g.filter((x) => x[0] === 100).map((x) => x[1]);

const SUB = {
  LINE: ['AcDbLine'],
  XLINE: ['AcDbXline'],
  RAY: ['AcDbRay'],
  CIRCLE: ['AcDbCircle'],
  ARC: ['AcDbCircle', 'AcDbArc'],
  ELLIPSE: ['AcDbEllipse'],
  LWPOLYLINE: ['AcDbPolyline'],
  SPLINE: ['AcDbSpline'],
  POINT: ['AcDbPoint'],
  TEXT: ['AcDbText', 'AcDbText'],
  MTEXT: ['AcDbMText'],
  LEADER: ['AcDbLeader'],
  HATCH: ['AcDbHatch'],
  INSERT: ['AcDbBlockReference'],
  BLOCK: ['AcDbBlockBegin'],
  ENDBLK: ['AcDbBlockEnd'],
};
const DIM_SUB = {
  0: ['AcDbAlignedDimension', 'AcDbRotatedDimension'],
  1: ['AcDbAlignedDimension'],
  3: ['AcDbDiametricDimension'],
  4: ['AcDbRadialDimension'],
  5: ['AcDb3PointAngularDimension'],
  6: ['AcDbOrdinateDimension'],
};

describe('writeDxf: structure', () => {
  const text = writeDxf(sampleDrawing(), { dimensionEntities, extents: [0, 0, 100, 60] });
  const recs = records(text);

  it('uses CRLF line endings and right-aligned group codes', () => {
    expect(text.endsWith('  0\r\nEOF\r\n')).toBe(true);
    const lines = text.split('\r\n');
    lines.pop();
    expect(lines.every((l) => !l.includes('\n') && !l.includes('\r'))).toBe(true);
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toMatch(/^( {2}\d| \d\d|\d{3,4})$/);
    }
    // non-ASCII text is escaped
    expect(/[^\x20-\x7e\r\n]/.test(text)).toBe(false);
    expect(text).toContain('Caf\\U+00E9');
  });

  it('writes the expected sections in order with R2000 header variables', () => {
    const sections = recs.filter((r) => r.type === 'SECTION').map((r) => val(r, 2));
    expect(sections).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);
    const header = recs.find((r) => r.type === 'SECTION');
    const vars = header.g.filter((x) => x[0] === 9).map((x) => x[1]);
    for (const v of ['$ACADVER', '$HANDSEED', '$INSUNITS', '$LTSCALE', '$CLAYER', '$TEXTSIZE', '$LUNITS', '$LUPREC', '$AUNITS', '$AUPREC', '$EXTMIN', '$EXTMAX', '$DWGCODEPAGE']) {
      expect(vars).toContain(v);
    }
    expect(val(header, 1)).toBe('AC1015');
  });

  it('gives every object a unique handle and $HANDSEED exceeds them all', () => {
    const header = recs[0];
    const seedIdx = header.g.findIndex((x) => x[0] === 9 && x[1] === '$HANDSEED');
    const seed = parseInt(header.g[seedIdx + 1][1], 16);
    const handles = [];
    for (const r of recs.slice(1)) for (const [c, v] of r.g) if (c === 5 || c === 105) handles.push(v);
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) {
      expect(h).toMatch(/^[0-9A-F]+$/);
      expect(parseInt(h, 16)).toBeLessThan(seed);
    }
    // owners point at existing objects
    const known = new Set(handles);
    for (const r of recs.slice(1)) {
      for (const [c, v] of r.g) if (c === 330 || c === 340 || c === 342 || c === 350 || c === 390) expect(v === '0' || known.has(v)).toBe(true);
    }
  });

  it('writes handle, owner and subclass markers on every entity', () => {
    let section = '';
    let count = 0;
    const modelBr = recs.find((r) => r.type === 'BLOCK_RECORD' && val(r, 2) === '*Model_Space');
    for (const r of recs) {
      if (r.type === 'SECTION') section = val(r, 2);
      if (section !== 'ENTITIES' && section !== 'BLOCKS') continue;
      if (r.type === 'SECTION' || r.type === 'ENDSEC') continue;
      count++;
      expect(r.g[0][0]).toBe(5);
      expect(r.g[1][0]).toBe(330);
      const sub = subclasses(r);
      expect(sub[0]).toBe('AcDbEntity');
      const expected = r.type === 'DIMENSION' ? ['AcDbDimension', ...DIM_SUB[(+val(r, 70)) & 7]] : SUB[r.type];
      expect(expected, r.type).toBeDefined();
      expect(sub.slice(1)).toEqual(expected);
      if (section === 'ENTITIES') expect(val(r, 330)).toBe(val(modelBr, 5));
    }
    expect(count).toBeGreaterThan(40);
  });

  it('keeps table counts consistent with the entries', () => {
    let table = null;
    let entries = 0;
    const seen = [];
    for (const r of recs) {
      if (r.type === 'TABLE') {
        table = r;
        entries = 0;
      } else if (r.type === 'ENDTAB') {
        expect(+val(table, 70), val(table, 2)).toBe(entries);
        seen.push(val(table, 2));
        table = null;
      } else if (table) {
        entries++;
        expect(r.type).toBe(val(table, 2));
        expect(val(r, 330)).toBe(val(table, 5));
        expect(subclasses(r)[0]).toBe('AcDbSymbolTableRecord');
        expect(val(r, r.type === 'DIMSTYLE' ? 105 : 5)).toBeDefined();
      }
    }
    expect(seen).toEqual(['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']);
  });

  it('pairs every BLOCK with a BLOCK_RECORD and every DIMENSION with an anonymous block', () => {
    const brNames = recs.filter((r) => r.type === 'BLOCK_RECORD').map((r) => val(r, 2));
    const blockNames = recs.filter((r) => r.type === 'BLOCK').map((r) => val(r, 2));
    expect(blockNames.sort()).toEqual([...brNames].sort());
    expect(brNames).toContain('*Model_Space');
    expect(brNames).toContain('*Paper_Space');
    expect(brNames).toContain('Bolt');
    expect(brNames).toContain('_Open');
    const dims = recs.filter((r) => r.type === 'DIMENSION');
    expect(dims.length).toBe(8);
    for (const d of dims) {
      expect(val(d, 2)).toMatch(/^\*D\d+$/);
      expect(blockNames).toContain(val(d, 2));
    }
    for (const b of recs.filter((r) => r.type === 'BLOCK')) {
      const br = recs.find((r) => r.type === 'BLOCK_RECORD' && val(r, 2) === val(b, 2));
      expect(val(b, 330)).toBe(val(br, 5));
    }
  });

  it('writes the root dictionary with ACAD_GROUP', () => {
    const objStart = recs.findIndex((r) => r.type === 'SECTION' && val(r, 2) === 'OBJECTS');
    const root = recs[objStart + 1];
    expect(root.type).toBe('DICTIONARY');
    expect(val(root, 330)).toBe('0');
    const groups = root.g.findIndex((x) => x[0] === 3 && x[1] === 'ACAD_GROUP');
    expect(groups).toBeGreaterThan(-1);
    const target = root.g[groups + 1][1];
    expect(recs.some((r) => r.type === 'DICTIONARY' && val(r, 5) === target)).toBe(true);
  });

  it('writes true colors as 420 with the nearest index color in 62', () => {
    const ray = recs.find((r) => r.type === 'RAY');
    expect(+val(ray, 420)).toBe(0x336699);
    const idx = +val(ray, 62);
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(256);
  });
});

describe('writeDxf: options and edge cases', () => {
  it('formats numbers without exponents and escapes text', () => {
    expect(fmt(1)).toBe('1.0');
    expect(fmt(-0)).toBe('0.0');
    expect(fmt(1e-10)).toBe('0.0000000001');
    expect(fmt(0.1)).toBe('0.1');
    expect(fmt(NaN)).toBe('0.0');
    expect(encodeString('é中')).toBe('\\U+00E9\\U+4E2D');
    expect(encodeMtext('a\nb{c}\\d')).toBe('a\\Pb\\{c\\}\\\\d');
  });

  it('skips dimensions with a warning when no geometry is supplied', () => {
    const warnings = [];
    const d = sampleDrawing();
    const text = writeDxf(d, { warnings });
    expect(text).not.toContain('\r\nDIMENSION\r\n');
    expect(warnings.some((w) => w.includes('Dimensions'))).toBe(true);
    const back = parseDxf(text).drawing;
    expect(back.entities.some((e) => e.type === 'dimension')).toBe(false);
    expect(back.entities.length).toBe(d.entities.length - 7);
  });

  it('explodes dimensions into plain entities on request', () => {
    const text = writeDxf(sampleDrawing(), { dimensionEntities, explodeDimensions: true });
    expect(text).not.toContain('\r\nDIMENSION\r\n');
    const back = parseDxf(text).drawing;
    expect(back.entities.filter((e) => e.type === 'text' && e.value === '10.00').length).toBe(7);
  });

  it('accepts precomputed dimension blocks through the worker message handler', () => {
    const d = sampleDrawing();
    const dimBlocks = {};
    for (const e of d.entities) if (e.type === 'dimension') dimBlocks[e.id] = dimensionEntities(e);
    for (const e of d.blocks[0].entities) if (e.type === 'dimension') dimBlocks[`Bolt/${e.id}`] = dimensionEntities(e);
    const reply = handleMessage({ id: 7, op: 'write', drawing: d, opts: { dimBlocks } });
    expect(reply.ok).toBe(true);
    expect(reply.id).toBe(7);
    expect(reply.result.warnings.filter((w) => w.includes('Dimension'))).toEqual([]);
    expect(reply.result.text.split('\r\nDIMENSION\r\n').length - 1).toBe(8);
    const parsed = handleMessage({ id: 8, op: 'parse', buffer: new TextEncoder().encode(reply.result.text).buffer });
    expect(parsed.ok).toBe(true);
    expect(parsed.result.drawing.entities.filter((e) => e.type === 'dimension').length).toBe(7);
    expect(handleMessage({ id: 9, op: 'parse', buffer: 'garbage' })).toMatchObject({ id: 9, ok: false });
    expect(handleMessage({ id: 10, op: 'nope' }).ok).toBe(false);
  });

  it('writes hatch pattern definition lines when a pattern is supplied', () => {
    const d = sampleDrawing();
    const text = writeDxf(d, {
      dimensionEntities,
      hatchPatterns: { ANSI31: [{ angle: 45, x: 0, y: 0, dx: 0, dy: 3.175, dashes: [] }] },
    });
    const h = records(text).find((r) => r.type === 'HATCH' && val(r, 2) === 'ANSI31');
    expect(+val(h, 78)).toBe(1);
    const ang = +val(h, 53);
    expect(ang).toBeCloseTo(45 + (0.5 * 180) / Math.PI, 6);
    const a = (ang * Math.PI) / 180;
    expect(+val(h, 45)).toBeCloseTo(-Math.sin(a) * 3.175 * 2, 6);
    expect(+val(h, 46)).toBeCloseTo(Math.cos(a) * 3.175 * 2, 6);
  });

  it('writes mirrored hatches in a mirrored OCS that reads back mirrored', () => {
    const fam = { angle: 45, x: 0, y: 0.3, dx: 1, dy: 3.175, dashes: [3, -1] };
    const loop = [1, 1, 0.3, 21, 1, 0, 21, 21, 0, 1, 21, 0];
    const hatches = [
      ent('hatch', { loops: [loop], pattern: 'STEEL', scale: 1.5, angle: 0.4, mirror: true }),
      ent('hatch', { loops: [loop], pattern: 'ANSI31', scale: 2, angle: 0.2, mirror: true, families: [fam] }),
    ];
    const text = writeDxf({ entities: hatches, layers: [], blocks: [] }, { hatchPatterns: { ANSI31: [fam] } });
    expect(records(text).filter((r) => r.type === 'HATCH').map((r) => +val(r, 230))).toEqual([-1, -1]);
    const back = parseDxf(text).drawing.entities;
    for (let i = 0; i < 2; i++) {
      expect(back[i]).toMatchObject({ mirror: true, scale: hatches[i].scale, loops: [loop] });
      expect(back[i].angle).toBeCloseTo(hatches[i].angle, 9);
    }
    expect(back[1].families).toEqual([fam]);
  });

  it('writes an empty drawing that reads back with the standard tables', () => {
    const text = writeDxf({ entities: [], layers: [], blocks: [] });
    const { drawing, warnings } = parseDxf(text);
    expect(warnings).toEqual([]);
    expect(drawing.layers.map((l) => l.name)).toEqual(['0']);
    expect(drawing.textStyles.map((s) => s.name)).toEqual(['Standard']);
    expect(drawing.dimStyles.map((s) => s.name)).toEqual(['Standard']);
  });

  it('writes fit-point splines so that readers rebuild the same curve', () => {
    // Readers (AutoCAD, the ODA File Converter) recompute fit-point splines from the fit
    // points and end derivatives; this reader does it the same way, so ignore our control points.
    const open = [0, 0, 5, 5, 10, 0, 15, 8];
    const closed = [0, 0, 10, 0, 10, 10, 0, 10, 3, 4];
    const entities = [
      ent('spline', { id: 1, ...splineFromFitPoints(open), fit: open, closed: false }),
      ent('spline', { id: 2, ...splineFromFitPoints(closed, true), fit: closed, closed: true }),
    ];
    const text = writeDxf({ layers: [defaultLayer('0')], entities });
    // the closed spline lists its first fit point again at the end
    expect(text.split('\r\n').filter((l, i, a) => a[i - 1] === ' 74').slice(-2)).toEqual(['4', '6']);
    const rebuilt = text.replace(/\r\n 73\r\n\d+/g, '\r\n 73\r\n0').replace(/\r\n 10\r\n[^\r]*\r\n 20\r\n[^\r]*\r\n 30\r\n[^\r]*/g, '');
    const { drawing } = parseDxf(rebuilt);
    drawing.entities.forEach((e, i) => {
      expect(e.closed).toBe(entities[i].closed);
      expect(e.fit).toEqual(entities[i].fit);
      expect(e.ctrl.length).toBe(entities[i].ctrl.length);
      e.ctrl.forEach((v, j) => expect(Math.abs(v - entities[i].ctrl[j])).toBeLessThan(1e-9));
    });
  });

  it('skips invalid entities without corrupting the output', () => {
    const warnings = [];
    const text = writeDxf(
      {
        layers: [defaultLayer('0')],
        entities: [
          ent('circle', { id: 1, cx: 0, cy: 0, r: 0 }),
          ent('insert', { id: 2, name: 'Missing', x: 0, y: 0, sx: 1, sy: 1, rot: 0 }),
          ent('polyline', { id: 3, pts: [0, 0, 0], closed: false, width: 0 }),
          ent('bogus', { id: 4 }),
          ent('line', { id: 5, x1: 0, y1: 0, x2: 1, y2: 1, layer: 'New' }),
        ],
      },
      { warnings },
    );
    expect(warnings.length).toBe(4);
    const { drawing } = parseDxf(text);
    expect(drawing.entities.map((e) => e.type)).toEqual(['line']);
    expect(drawing.layers.map((l) => l.name)).toContain('New');
  });
});

describe('round trip', () => {
  const src = sampleDrawing();
  const text = writeDxf(src, { dimensionEntities });
  const { drawing: back, warnings } = parseDxf(text);

  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
  const angNear = (a, b) => near(Math.cos(a), Math.cos(b)) && near(Math.sin(a), Math.sin(b));
  const ANGLES = new Set(['rot', 'start', 'end', 'angle', 'oblique']);

  function compare(a, b, path) {
    for (const k of Object.keys(a)) {
      if (k === 'id') continue;
      const va = a[k];
      const vb = b[k];
      const p = `${path}.${k}`;
      if (typeof va === 'number') {
        expect(typeof vb, p).toBe('number');
        const ok = ANGLES.has(k) && a.type !== 'ellipse' ? angNear(va, vb) : near(va, vb);
        expect(ok, `${p}: ${va} vs ${vb}`).toBe(true);
      } else if (Array.isArray(va)) {
        expect(vb.length, p).toBe(va.length);
        va.forEach((x, i) => {
          if (Array.isArray(x)) x.forEach((y, j) => expect(near(y, vb[i][j]), `${p}[${i}][${j}]`).toBe(true));
          else expect(near(x, vb[i]), `${p}[${i}]: ${x} vs ${vb[i]}`).toBe(true);
        });
      } else if (va && typeof va === 'object') compare(va, vb, p);
      else expect(vb, p).toBe(va);
    }
  }

  it('reads back without warnings', () => {
    expect(warnings).toEqual([]);
  });

  it('preserves the header', () => {
    const { nextId, ...rest } = src.header;
    expect(back.header).toMatchObject(rest);
    expect(back.header.nextId).toBeGreaterThan(src.entities.length);
    void nextId;
  });

  it('preserves layers, linetypes and styles', () => {
    for (const L of src.layers) compare(L, back.layers.find((x) => x.name === L.name), `layer ${L.name}`);
    for (const lt of src.linetypes) compare(lt, back.linetypes.find((x) => x.name === lt.name), `linetype ${lt.name}`);
    for (const st of src.textStyles) compare(st, back.textStyles.find((x) => x.name === st.name), `style ${st.name}`);
    for (const ds of src.dimStyles) compare(ds, back.dimStyles.find((x) => x.name === ds.name), `dimstyle ${ds.name}`);
  });

  it('preserves blocks and drops the generated dimension and arrow blocks', () => {
    expect(back.blocks.map((b) => b.name)).toEqual(['Bolt']);
    const [b] = back.blocks;
    expect([b.bx, b.by]).toEqual([1, 2]);
    expect(b.entities.map((e) => e.type)).toEqual(['circle', 'line', 'dimension']);
    compare(src.blocks[0].entities[0], b.entities[0], 'block circle');
  });

  it('preserves every entity within tolerance', () => {
    expect(back.entities.map((e) => e.type)).toEqual(src.entities.map((e) => e.type));
    src.entities.forEach((a, i) => {
      const b = back.entities[i];
      if (a.type === 'dimension' && (a.dimType === 'linear' || a.dimType === 'aligned')) {
        // the location point is moved along the dimension line; check it stays on it
        const { lx, ly, ...rest } = a;
        compare(rest, b, `entity ${i} ${a.type}`);
        const ux = a.dimType === 'linear' ? Math.cos(a.rot) : a.x2 - a.x1;
        const uy = a.dimType === 'linear' ? Math.sin(a.rot) : a.y2 - a.y1;
        expect(Math.abs((b.lx - lx) * uy - (b.ly - ly) * ux)).toBeLessThan(1e-9);
      } else compare(a, b, `entity ${i} ${a.type}`);
    });
  });
});

describe('round trip of non-ASCII table names', () => {
  it('keeps references to styles, linetypes and layers named with \\U+ escapes', () => {
    const src = sampleDrawing();
    src.layers.push({ ...defaultLayer('Wände'), linetype: 'Strichlinie_ä' });
    src.linetypes.push({ name: 'Strichlinie_ä', description: '', pattern: [1, -0.5] });
    src.textStyles.push({ ...defaultTextStyle('Schrift_ö'), height: 4 });
    src.dimStyles.push({ ...defaultDimStyle('Maß'), textStyle: 'Schrift_ö' });
    const n = src.entities.length;
    src.entities.push(
      ent('line', { id: n + 1, layer: 'Wände', x1: 0, y1: 0, x2: 1, y2: 0, linetype: 'Strichlinie_ä' }),
      ent('text', { id: n + 2, x: 0, y: 0, h: 2, rot: 0, value: 'x', style: 'Schrift_ö', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 }),
      ent('dimension', { ...dimBase, id: n + 3, dimType: 'aligned', x2: 10, lx: 5, ly: 5, style: 'Maß' }),
    );
    Object.assign(src.header, { clayer: 'Wände', textStyle: 'Schrift_ö', dimStyle: 'Maß', cltype: 'Strichlinie_ä', nextId: n + 4 });
    const text = writeDxf(src, { dimensionEntities });
    expect(text).toContain('Schrift_\\U+00F6');
    const { drawing: back, warnings } = parseDxf(text);
    expect(warnings.filter((w) => /Strichlinie/.test(w))).toEqual([]);
    const [line, txt, dim] = back.entities.slice(-3);
    expect(line).toMatchObject({ layer: 'Wände', linetype: 'Strichlinie_ä' });
    expect(txt.style).toBe('Schrift_ö');
    expect(dim.style).toBe('Maß');
    expect(back.layers.find((l) => l.name === 'Wände').linetype).toBe('Strichlinie_ä');
    expect(back.header).toMatchObject({ clayer: 'Wände', textStyle: 'Schrift_ö', dimStyle: 'Maß', cltype: 'Strichlinie_ä' });
  });
});

describe('round trip of radius and diameter dimensions', () => {
  it('keeps the dimension location when written with the app\'s own dimension geometry', () => {
    const dims = [
      ent('dimension', { ...dimBase, id: 1, dimType: 'radius', x2: 3, y2: 4, lx: 6, ly: 8 }),
      ent('dimension', { ...dimBase, id: 2, dimType: 'diameter', x2: 3, y2: 4, lx: 6, ly: 8 }),
      // text inside the circle: it is lifted off the dimension line
      ent('dimension', { ...dimBase, id: 3, dimType: 'radius', x2: 3, y2: 4, lx: 1, ly: 1.5 }),
    ];
    let data = { ...sampleDrawing(), blocks: [], entities: dims };
    // saving and opening again, twice, must not move anything
    for (let pass = 0; pass < 2; pass++) {
      const { drawing, opts } = exportPayload(new Drawing(data));
      data = parseDxf(writeDxf(drawing, opts)).drawing;
      data.entities.forEach((e, i) => {
        expect(e).toMatchObject({ dimType: dims[i].dimType, x1: 0, y1: 0, x2: 3, y2: 4 });
        expect(e.lx).toBeCloseTo(dims[i].lx, 9);
        expect(e.ly).toBeCloseTo(dims[i].ly, 9);
      });
    }
  });
});

describe('round trip of hatch patterns', () => {
  const loop = [0, 0, 0, 50, 0, 0, 50, 50, 0, 0, 50, 0];

  it('reads every pattern of the app back as that pattern', () => {
    const names = PATTERNS.map((p) => p.name).filter((n) => n !== 'SOLID');
    const hatches = names.map((pattern, i) =>
      ent('hatch', { id: i + 1, loops: [loop], pattern, scale: 2.5, angle: 0.7, ...(i % 2 ? { mirror: true } : {}) }),
    );
    const { drawing, opts } = exportPayload(new Drawing({ entities: hatches }));
    const back = parseDxf(writeDxf(drawing, opts)).drawing.entities;
    expect(back.map((e) => e.pattern)).toEqual(names);
    expect(back.filter((e) => e.families)).toEqual([]);
  });

  it('keeps the lines of a file\'s pattern that only shares its name with one of the app\'s', () => {
    // AutoCAD's STEEL at scale 10: two families of 45 degree lines, 1.25 apart
    const o = 1.25 * Math.SQRT1_2;
    const text = [
      0, 'SECTION', 2, 'ENTITIES', 0, 'HATCH', 10, 0, 20, 0, 30, 0, 2, 'STEEL', 70, 0, 71, 0, 91, 1,
      92, 3, 72, 0, 73, 1, 93, 4, 10, 0, 20, 0, 10, 50, 20, 0, 10, 50, 20, 50, 10, 0, 20, 50, 97, 0,
      75, 0, 76, 1, 52, 0, 41, 10, 77, 0, 78, 2,
      53, 45, 43, 0, 44, 0, 45, -o, 46, o, 79, 0,
      53, 45, 43, 0, 44, 0.625, 45, -o, 46, o, 79, 0,
      98, 0, 0, 'ENDSEC', 0, 'EOF',
    ].join('\r\n');
    const fams = [
      { angle: 45, x: 0, y: 0, dx: 0, dy: 0.125, dashes: [] },
      { angle: 45, x: 0, y: 0.0625, dx: 0, dy: 0.125, dashes: [] },
    ];
    let data = parseDxf(text).drawing;
    for (let pass = 0; pass < 2; pass++) {
      expect(data.entities[0]).toMatchObject({ pattern: 'STEEL_IMPORTED', scale: 10, families: fams });
      // written under the name it came with, and with its own lines
      const { drawing, opts } = exportPayload(new Drawing(data));
      const out = writeDxf(drawing, opts);
      expect(val(records(out).find((r) => r.type === 'HATCH'), 2)).toBe('STEEL');
      data = parseDxf(out).drawing;
    }
  });
});
