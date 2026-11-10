import { describe, it, expect } from 'vitest';
import { parseDxf, stripMtext, decodeText } from '../src/io/dxf/reader.js';
import { evalSpline, tessellateSpline } from '../src/io/dxf/geom.js';
import { Drawing } from '../src/core/drawing.js';
import { makeContext, emitEntity } from '../src/core/tessellate.js';
import { exportPayload } from '../src/io/dxf-client.js';

/** Build DXF text from flat [code, value, ...] arrays per section. */
function dxf(entities = [], { header = [], tables = [], blocks = [], objects = [] } = {}) {
  const out = [];
  const push = (arr) => {
    for (let i = 0; i < arr.length; i += 2) out.push(String(arr[i]).padStart(3), String(arr[i + 1]));
  };
  const section = (name, body) => {
    push([0, 'SECTION', 2, name]);
    push(body);
    push([0, 'ENDSEC']);
  };
  if (header.length) section('HEADER', header);
  if (tables.length) section('TABLES', tables);
  if (blocks.length) section('BLOCKS', blocks);
  section('ENTITIES', entities);
  if (objects.length) section('OBJECTS', objects);
  push([0, 'EOF']);
  return out.join('\r\n') + '\r\n';
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('parseDxf: basic entities and common properties', () => {
  it('reads a LINE with layer, colors, linetype, lineweight and ltscale', () => {
    const { drawing, warnings } = parseDxf(
      dxf([0, 'LINE', 8, 'Walls', 62, 3, 6, 'DASHED', 370, 35, 48, 2, 10, 1, 20, 2, 30, 0, 11, 3, 21, 4, 31, 0]),
    );
    const e = drawing.entities[0];
    expect(e).toMatchObject({ id: 1, type: 'line', layer: 'Walls', color: 3, linetype: 'Dashed', lineweight: 35, ltscale: 2 });
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([1, 2, 3, 4]);
    expect(drawing.layers.map((l) => l.name)).toContain('Walls');
    expect(drawing.header.nextId).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('prefers true color 420 over the index color', () => {
    const { drawing } = parseDxf(dxf([0, 'POINT', 62, 1, 420, 0x12ab34, 10, 5, 20, 6]));
    expect(drawing.entities[0]).toMatchObject({ type: 'point', color: '#12ab34', x: 5, y: 6 });
  });

  it('reads XLINE and RAY with normalized direction', () => {
    const { drawing } = parseDxf(
      dxf([0, 'XLINE', 10, 1, 20, 1, 11, 3, 21, 4, 0, 'RAY', 10, 0, 20, 0, 11, 0, 21, 2]),
    );
    expect(drawing.entities[0]).toMatchObject({ type: 'xline', x: 1, y: 1, dx: 0.6, dy: 0.8 });
    expect(drawing.entities[1]).toMatchObject({ type: 'ray', dx: 0, dy: 1 });
  });

  it('skips invisible and paper space entities and counts unknown types', () => {
    const { drawing, stats } = parseDxf(
      dxf([
        0, 'LINE', 60, 1, 10, 0, 20, 0, 11, 1, 21, 1,
        0, 'LINE', 67, 1, 10, 0, 20, 0, 11, 1, 21, 1,
        0, '3DSOLID', 8, '0',
        0, 'WIPEOUT', 8, '0',
        0, '3DSOLID', 8, '0',
        0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1,
      ]),
    );
    expect(drawing.entities.length).toBe(1);
    expect(stats.entities).toBe(1);
    expect(stats.skipped).toEqual({ '3DSOLID': 2, WIPEOUT: 1 });
  });

  it('reads CIRCLE, ARC (degrees to radians) and ELLIPSE', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'CIRCLE', 10, 1, 20, 2, 40, 3,
        0, 'ARC', 10, 0, 20, 0, 40, 5, 50, 90, 51, 180,
        0, 'ELLIPSE', 10, 0, 20, 0, 11, 4, 21, 0, 40, 0.5, 41, 0, 42, 6.283185307179586,
      ]),
    );
    const [c, a, el] = drawing.entities;
    expect(c).toMatchObject({ type: 'circle', cx: 1, cy: 2, r: 3 });
    expect(a.type).toBe('arc');
    expect(close(a.start, Math.PI / 2)).toBe(true);
    expect(close(a.end, Math.PI)).toBe(true);
    expect(el).toMatchObject({ type: 'ellipse', cx: 0, cy: 0, mx: 4, my: 0, ratio: 0.5, start: 0 });
    expect(close(el.end, 2 * Math.PI)).toBe(true);
  });
});

describe('parseDxf: object coordinate systems', () => {
  it('converts an ARC with extrusion (0,0,-1) to WCS', () => {
    const { drawing } = parseDxf(dxf([0, 'ARC', 10, 10, 20, 5, 30, 0, 40, 2, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1]));
    const a = drawing.entities[0];
    expect(a.type).toBe('arc');
    expect(close(a.cx, -10)).toBe(true);
    expect(close(a.cy, 5)).toBe(true);
    expect(close(a.r, 2)).toBe(true);
    // start' = PI - end, end' = PI - start
    expect(close(a.start, Math.PI / 2)).toBe(true);
    expect(close(a.end, Math.PI)).toBe(true);
  });

  it('converts a CIRCLE and LWPOLYLINE with extrusion (0,0,-1)', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'CIRCLE', 10, 3, 20, 4, 40, 1, 210, 0, 220, 0, 230, -1,
        0, 'LWPOLYLINE', 90, 2, 70, 0, 10, 1, 20, 0, 42, 0.5, 10, 2, 20, 0, 210, 0, 220, 0, 230, -1,
      ]),
    );
    const [c, p] = drawing.entities;
    expect(c).toMatchObject({ type: 'circle', cx: -3, cy: 4, r: 1 });
    expect(p.pts).toEqual([-1, 0, -0.5, -2, 0, 0]);
  });

  it('projects a circle on a tilted plane to an ellipse', () => {
    const s = Math.SQRT1_2;
    const { drawing, warnings } = parseDxf(dxf([0, 'CIRCLE', 10, 0, 20, 0, 40, 2, 210, s, 220, 0, 230, s]));
    const e = drawing.entities[0];
    expect(e.type).toBe('ellipse');
    expect(close(Math.hypot(e.mx, e.my), 2)).toBe(true);
    expect(close(e.ratio, s, 1e-9)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('mirrors INSERT and TEXT placed with extrusion (0,0,-1)', () => {
    const { drawing } = parseDxf(
      dxf(
        [
          0, 'INSERT', 2, 'B', 10, 5, 20, 1, 50, 30, 210, 0, 220, 0, 230, -1,
          0, 'TEXT', 10, 4, 20, 2, 40, 1, 1, 'M', 210, 0, 220, 0, 230, -1,
        ],
        { blocks: [0, 'BLOCK', 2, 'B', 70, 0, 10, 0, 20, 0, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0, 0, 'ENDBLK'] },
      ),
    );
    const [ins, txt] = drawing.entities;
    expect(close(ins.x, -5)).toBe(true);
    // block X axis maps to direction 180 - 30 degrees, Y axis stays up: mirrored
    expect(close(ins.rot, (150 * Math.PI) / 180)).toBe(true);
    expect(ins.sy).toBe(-1);
    expect(txt).toMatchObject({ x: -4, y: 2, halign: 'right' });
  });
});

describe('parseDxf: polylines and splines', () => {
  it('reads LWPOLYLINE bulges, closed flag and constant width', () => {
    const { drawing } = parseDxf(
      dxf([0, 'LWPOLYLINE', 90, 3, 70, 1, 43, 0.5, 10, 0, 20, 0, 42, 1, 10, 10, 20, 0, 10, 10, 20, 10, 42, -0.25]),
    );
    const p = drawing.entities[0];
    expect(p).toMatchObject({ type: 'polyline', closed: true, width: 0.5 });
    expect(p.pts).toEqual([0, 0, 1, 10, 0, 0, 10, 10, -0.25]);
  });

  it('reads POLYLINE with VERTEX and SEQEND, flattens 3D, skips polyface meshes', () => {
    const { drawing, warnings, stats } = parseDxf(
      dxf([
        0, 'POLYLINE', 8, 'P', 66, 1, 70, 1, 10, 0, 20, 0, 30, 0,
        0, 'VERTEX', 8, 'P', 10, 0, 20, 0, 42, 0.5,
        0, 'VERTEX', 8, 'P', 10, 5, 20, 0,
        0, 'VERTEX', 8, 'P', 10, 5, 20, 5,
        0, 'SEQEND', 8, 'P',
        0, 'POLYLINE', 66, 1, 70, 8,
        0, 'VERTEX', 10, 1, 20, 1, 30, 7, 70, 32,
        0, 'VERTEX', 10, 2, 20, 3, 30, 9, 70, 32,
        0, 'SEQEND',
        0, 'POLYLINE', 66, 1, 70, 64,
        0, 'VERTEX', 10, 1, 20, 1, 70, 192,
        0, 'SEQEND',
        0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1,
      ]),
    );
    const [a, b, c] = drawing.entities;
    expect(a).toMatchObject({ type: 'polyline', layer: 'P', closed: true });
    expect(a.pts).toEqual([0, 0, 0.5, 5, 0, 0, 5, 5, 0]);
    expect(b.pts).toEqual([1, 1, 0, 2, 3, 0]);
    expect(b.closed).toBe(false);
    expect(c.type).toBe('line');
    expect(stats.skipped.POLYLINE).toBe(1);
    expect(warnings.some((w) => w.includes('Polyface'))).toBe(true);
  });

  it('reads a clamped SPLINE with knots and control points', () => {
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const g = [0, 'SPLINE', 70, 8, 71, 3, 72, 8, 73, 4, 74, 0];
    for (const k of knots) g.push(40, k);
    for (const [x, y] of [[0, 0], [1, 2], [3, 2], [4, 0]]) g.push(10, x, 20, y, 30, 0);
    const { drawing } = parseDxf(dxf(g));
    const s = drawing.entities[0];
    expect(s).toMatchObject({ type: 'spline', degree: 3, closed: false });
    expect(s.knots).toEqual(knots);
    expect(s.ctrl).toEqual([0, 0, 1, 2, 3, 2, 4, 0]);
    expect(s.fit).toEqual([]);
  });

  it('clamps a periodic spline without changing its shape', () => {
    const ctrl = [0, 0, 4, 0, 4, 4, 0, 4, 0, 0, 4, 0, 4, 4];
    const knots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const g = [0, 'SPLINE', 70, 11, 71, 3, 72, knots.length, 73, 7];
    for (const k of knots) g.push(40, k);
    for (let i = 0; i < ctrl.length; i += 2) g.push(10, ctrl[i], 20, ctrl[i + 1]);
    const { drawing } = parseDxf(dxf(g));
    const s = drawing.entities[0];
    expect(s.closed).toBe(true);
    expect(s.knots.length).toBe(s.ctrl.length / 2 + 4);
    expect(s.knots.slice(0, 4)).toEqual([3, 3, 3, 3]);
    const p = [0, 0];
    const q = [0, 0];
    for (const u of [3, 4.3, 5.5, 6.9, 6.999]) {
      evalSpline(3, knots, ctrl, null, u, p);
      evalSpline(3, s.knots, s.ctrl, null, u, q);
      expect(close(p[0], q[0], 1e-9) && close(p[1], q[1], 1e-9)).toBe(true);
    }
  });

  it('builds control points for a fit-point-only spline', () => {
    const g = [0, 'SPLINE', 70, 8, 71, 3, 72, 0, 73, 0, 74, 3, 11, 0, 21, 0, 11, 5, 21, 5, 11, 10, 21, 0];
    const { drawing } = parseDxf(dxf(g));
    const s = drawing.entities[0];
    expect(s.fit).toEqual([0, 0, 5, 5, 10, 0]);
    expect(s.knots.length).toBe(s.ctrl.length / 2 + 4);
    const p = [0, 0];
    evalSpline(3, s.knots, s.ctrl, null, s.knots[4], p);
    expect(close(p[0], 5) && close(p[1], 5)).toBe(true);
  });

  it('keeps the shape of rational splines, with sharp corners at repeated knots', () => {
    // a full circle of radius 10 around (3, 4) as a rational quadratic NURBS
    const w = Math.SQRT1_2;
    const circle = [0, 'SPLINE', 70, 13, 71, 2, 72, 12, 73, 9];
    for (const k of [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]) circle.push(40, k);
    for (const k of [1, w, 1, w, 1, w, 1, w, 1]) circle.push(41, k);
    for (const [x, y] of [[13, 4], [13, 14], [3, 14], [-7, 14], [-7, 4], [-7, -6], [3, -6], [13, -6], [13, 4]]) circle.push(10, x, 20, y);
    // two weighted arcs meeting at a corner (10, 0)
    const corner = [0, 'SPLINE', 70, 12, 71, 2, 72, 8, 73, 5, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 2, 40, 2, 40, 2];
    for (const k of [1, 2, 1, 2, 1]) corner.push(41, k);
    for (const [x, y] of [[0, 0], [5, 5], [10, 0], [15, 5], [20, 0]]) corner.push(10, x, 20, y);
    const { drawing, warnings } = parseDxf(dxf([...circle, ...corner]));
    expect(warnings).toEqual([]);
    const [c, k] = drawing.entities;
    expect(c).toMatchObject({ degree: 3, closed: true, fit: [] });
    const pts = tessellateSpline(3, c.knots, c.ctrl, null, 2000);
    for (let i = 0; i < pts.length; i += 2) expect(Math.abs(Math.hypot(pts[i] - 3, pts[i + 1] - 4) - 10)).toBeLessThan(1e-3);
    const p = [0, 0];
    evalSpline(3, k.knots, k.ctrl, null, 0.25, p);
    expect(close(p[0], 5, 1e-4) && close(p[1], 10 / 3, 1e-4)).toBe(true);
    evalSpline(3, k.knots, k.ctrl, null, 0.5, p);
    expect(close(p[0], 10) && close(p[1], 0)).toBe(true);
  });

  it('interpolates fit points like AutoCAD, with and without end tangents', () => {
    const fit = [11, 80, 21, 0, 11, 83, 21, 5, 11, 87, 21, 2, 11, 90, 21, 8, 11, 95, 21, 3];
    const { drawing } = parseDxf(
      dxf([
        0, 'SPLINE', 70, 8, 71, 3, 72, 0, 73, 0, 74, 5, ...fit,
        0, 'SPLINE', 70, 8, 71, 3, 72, 0, 73, 0, 74, 5, 12, 0, 22, 1, 13, 1, 23, 1, ...fit,
      ]),
    );
    // control points of the same splines saved by the ODA File Converter
    const oda = [
      [80, 0, 80.789512, 2.710814, 82.256025, 7.746132, 88.158965, -1.601571, 89.342591, 12.058199, 93.081378, 6.071947, 95, 3],
      [80, 0, 80, 1.943651, 82.575279, 8.179854, 88.014684, -2.161254, 89.573882, 14.506293, 92.642977, 0.642977, 95, 3],
    ];
    drawing.entities.forEach((s, i) => {
      expect(s.ctrl.length).toBe(oda[i].length);
      s.ctrl.forEach((v, j) => expect(Math.abs(v - oda[i][j])).toBeLessThan(1e-5));
    });
  });
});

describe('parseDxf: text', () => {
  it('strips MTEXT formatting codes', () => {
    expect(stripMtext('{\\fArial|b1|i0;Hello}\\PWorld')).toBe('Hello\nWorld');
    expect(stripMtext('\\H2.5x;Big \\C1;red\\~x')).toBe('Big red\u00a0x');
    expect(stripMtext('\\S1^2; and \\S3#4;')).toBe('1/2 and 3/4');
    // %% right before a formatting code or a closing brace does not swallow it
    expect(stripMtext('50%%\\Pnext {\\fArial;100%%} %%c5 %%%')).toBe('50%%\nnext 100%% %%c5 %%%');
    expect(stripMtext('a\\\\b \\{c\\} \\U+00E9 \\Lunder\\l %%d')).toBe('a\\b {c} \u00e9 under %%d');
    // %% codes are drawn by the text and stay in the value, as AutoCAD keeps them
    expect(decodeText('25%%d %%c10 %%p0.1 %%% %%176')).toBe('25%%d %%c10 %%p0.1 %%% %%176');
    expect(decodeText('%%uUNDER%%u %%Oover %%kx')).toBe('%%uUNDER%%u %%Oover %%kx');
    expect(decodeText('%%65 a^ b')).toBe('A a^b');
  });

  it('reads MTEXT chunks, attachment, width, direction and line spacing', () => {
    const { drawing } = parseDxf(
      dxf([0, 'MTEXT', 10, 1, 20, 2, 40, 3.5, 41, 50, 71, 5, 3, '{\\fArial;First ', 1, 'part}\\Psecond', 7, 'Standard', 11, 0, 21, 1, 44, 1.5]),
    );
    const t = drawing.entities[0];
    expect(t).toMatchObject({ type: 'mtext', x: 1, y: 2, h: 3.5, width: 50, attach: 'mc', value: 'First part\nsecond', lineSpacing: 1.5 });
    expect(close(t.rot, Math.PI / 2)).toBe(true);
  });

  it('ignores the embedded column object of R2018+ MTEXT', () => {
    const mt = [0, 'MTEXT', 10, 100, 20, 200, 40, 2.5, 41, 60, 71, 1, 1, 'Hello', 7, 'Standard', 11, 1, 21, 0, 44, 1];
    const embedded = [101, 'Embedded Object', 70, 1, 10, 1, 20, 0, 11, 100, 21, 200, 40, 60, 41, 0, 42, 20, 43, 3, 71, 2, 72, 1, 44, 60, 45, 12.5, 73, 0, 74, 0];
    const plain = parseDxf(dxf(mt)).drawing.entities[0];
    const cols = parseDxf(dxf([...mt, ...embedded])).drawing.entities[0];
    expect(cols).toMatchObject({ x: 100, y: 200, h: 2.5, rot: 0, width: 60, attach: 'tl', lineSpacing: 1, value: 'Hello' });
    expect(cols).toEqual(plain);
  });

  it('maps TEXT alignment groups 72/73 and the second alignment point', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'TEXT', 10, 0, 20, 0, 40, 2, 1, 'plain', 50, 90,
        0, 'TEXT', 10, 0, 20, 0, 11, 7, 21, 8, 40, 2, 1, 'cm', 72, 1, 73, 2,
        0, 'TEXT', 10, 0, 20, 0, 11, 7, 21, 8, 40, 2, 1, 'mid', 72, 4,
        0, 'TEXT', 10, 0, 20, 0, 11, 10, 21, 0, 40, 2, 1, 'fit', 72, 5,
        0, 'TEXT', 10, 0, 20, 0, 11, 3, 21, 4, 40, 2, 1, 'rt', 72, 2, 73, 3,
      ]),
    );
    const [a, b, c, d, e] = drawing.entities;
    expect(a).toMatchObject({ x: 0, y: 0, halign: 'left', valign: 'baseline', value: 'plain' });
    expect(close(a.rot, Math.PI / 2)).toBe(true);
    expect(b).toMatchObject({ x: 7, y: 8, halign: 'center', valign: 'middle' });
    expect(c).toMatchObject({ x: 7, y: 8, halign: 'center', valign: 'middle' });
    expect(d).toMatchObject({ x: 5, y: 0, halign: 'center', valign: 'baseline' });
    expect(e).toMatchObject({ x: 3, y: 4, halign: 'right', valign: 'top' });
  });

  it('turns visible ATTRIBs into text and skips invisible ones', () => {
    const { drawing } = parseDxf(
      dxf(
        [
          0, 'INSERT', 66, 1, 2, 'TAG', 10, 0, 20, 0,
          0, 'ATTRIB', 10, 1, 20, 1, 40, 2, 1, 'V1', 2, 'T1', 70, 0,
          0, 'ATTRIB', 10, 1, 20, 1, 40, 2, 1, 'hidden', 2, 'T2', 70, 1,
          0, 'ATTRIB', 10, 1, 20, 1, 11, 4, 21, 5, 40, 2, 1, 'V3', 2, 'T3', 70, 0, 72, 1, 73, 0, 74, 3,
          0, 'SEQEND',
        ],
        { blocks: [0, 'BLOCK', 2, 'TAG', 10, 0, 20, 0, 0, 'ENDBLK'] },
      ),
    );
    expect(drawing.entities.map((e) => e.type)).toEqual(['insert', 'text', 'text']);
    expect(drawing.entities[1].value).toBe('V1');
    expect(drawing.entities[2]).toMatchObject({ value: 'V3', x: 4, y: 5, halign: 'center', valign: 'top' });
  });
});

describe('parseDxf: hatches, solids, blocks', () => {
  it('reads HATCH polyline boundaries with bulges and pattern properties', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'HATCH', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, 'ANSI31', 70, 0, 71, 0, 91, 1,
        92, 3, 72, 1, 73, 1, 93, 3, 10, 0, 20, 0, 42, 0, 10, 10, 20, 0, 42, 1, 10, 10, 20, 10, 42, 0, 97, 0,
        75, 0, 76, 1, 52, 45, 41, 2, 77, 0, 78, 1, 53, 45, 43, 0, 44, 0, 45, -2, 46, 2, 79, 0, 98, 0,
      ]),
    );
    const h = drawing.entities[0];
    expect(h).toMatchObject({ type: 'hatch', pattern: 'ANSI31', scale: 2 });
    expect(close(h.angle, Math.PI / 4)).toBe(true);
    expect(h.loops).toEqual([[0, 0, 0, 10, 0, 1, 10, 10, 0]]);
  });

  it('draws patterns the library lacks from the definition in the file', () => {
    // ANSI31 (lines at 45 degrees, 3.175 apart) at hatch angle 15 and scale 2
    const a = (15 * Math.PI) / 180;
    const off = [-Math.sin(a + Math.PI / 4) * 6.35, Math.cos(a + Math.PI / 4) * 6.35];
    const { drawing } = parseDxf(
      dxf([
        0, 'HATCH', 10, 0, 20, 0, 30, 0, 2, 'ANSI31', 70, 0, 71, 0, 91, 1,
        92, 3, 72, 0, 73, 1, 93, 3, 10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 100, 97, 0,
        75, 0, 76, 1, 52, 15, 41, 2, 77, 0, 78, 1, 53, 60, 43, 0, 44, 0, 45, off[0], 46, off[1], 79, 0, 98, 0,
      ]),
    );
    const h = drawing.entities[0];
    expect(h).toMatchObject({ pattern: 'ANSI31', scale: 2, families: [{ angle: 45, x: 0, y: 0, dx: 0, dy: 3.175, dashes: [] }] });
    expect(close(h.angle, a)).toBe(true);
    // the renderer draws its lines, not a solid fill
    const sink = { lines: [], fills: 0, line(p) { this.lines.push(p); }, fill() { this.fills++; } };
    const d = new Drawing(drawing);
    emitEntity(d.entities.get(h.id), sink, makeContext(d, {}));
    expect(sink.fills).toBe(0);
    expect(sink.lines.length).toBeGreaterThan(2);
    const [x1, y1, x2, y2] = sink.lines[0];
    expect(close(Math.abs(Math.atan2(y2 - y1, x2 - x1)) % Math.PI, Math.PI / 3, 1e-9)).toBe(true);
    // and DXF / DWG export write the same definition
    const { opts } = exportPayload(d, null);
    expect(opts.hatchPatterns.ANSI31).toEqual(h.families);
  });

  it('mirrors the patterns of hatches in a mirrored OCS', () => {
    // extrusion (0, 0, -1) flips x: ANSI31 lines run at 135 degrees in plan
    const hatch = (name) => [
      0, 'HATCH', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, -1, 2, name, 70, 0, 71, 0, 91, 1,
      92, 3, 72, 0, 73, 1, 93, 3, 10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10, 97, 0,
      75, 0, 76, 1, 52, 0, 41, 1, 77, 0, 78, 1, 53, 45, 43, 0, 44, 0, 45, -2.245, 46, 2.245, 79, 0, 98, 0,
    ];
    const { drawing } = parseDxf(dxf([...hatch('ANSI31'), ...hatch('LINES')]));
    const d = new Drawing(drawing);
    for (const e of d.entities.values()) {
      expect(e.loops).toEqual([[0, 0, 0, -10, 0, 0, -10, 10, 0]]);
      const sink = { lines: [], line(p) { this.lines.push(p); }, fill() {} };
      emitEntity(e, sink, makeContext(d, {}));
      const [x1, y1, x2, y2] = sink.lines[0];
      const deg = (((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 180 + 180) % 180;
      expect(close(deg, 135, 1e-6)).toBe(true);
    }
  });

  it('reads HATCH edge boundaries: lines, arcs (both directions), ellipses and solid fill', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'HATCH', 10, 0, 20, 0, 30, 0, 2, 'SOLID', 70, 1, 71, 0, 91, 2,
        // square with a semicircular top edge, counter-clockwise
        92, 1, 93, 4,
        72, 1, 10, 0, 20, 0, 11, 10, 21, 0,
        72, 1, 10, 10, 20, 0, 11, 10, 21, 10,
        72, 2, 10, 5, 20, 10, 40, 5, 50, 0, 51, 180, 73, 1,
        72, 1, 10, 0, 20, 10, 11, 0, 21, 0,
        97, 0,
        // a full ellipse hole drawn clockwise
        92, 16, 93, 1,
        72, 3, 10, 5, 20, 5, 11, 2, 21, 0, 40, 0.5, 50, 0, 51, 360, 73, 0,
        97, 0,
        75, 0, 76, 1, 98, 0,
      ]),
    );
    const h = drawing.entities[0];
    expect(h.pattern).toBe('SOLID');
    expect(h.loops.length).toBe(2);
    const [outer, hole] = h.loops;
    expect(outer.slice(0, 6)).toEqual([0, 0, 0, 10, 0, 0]);
    expect(close(outer[6], 10) && close(outer[7], 10)).toBe(true);
    expect(close(outer[8], 1)).toBe(true); // half circle, counter-clockwise
    expect(outer.length).toBe(12);
    expect(hole.length / 3).toBeGreaterThanOrEqual(16);
    expect(close(hole[0], 7) && close(hole[1], 5)).toBe(true);
    // clockwise: the second point is below the major axis
    expect(hole[4]).toBeLessThan(5);
  });

  it('reads clockwise hatch arc edges as negative bulges', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'HATCH', 2, 'SOLID', 70, 1, 91, 1, 92, 1, 93, 2,
        72, 2, 10, 0, 20, 0, 40, 1, 50, 0, 51, 180, 73, 0,
        72, 1, 10, -1, 20, 0, 11, 1, 21, 0,
        97, 0, 75, 0, 76, 1, 98, 0,
      ]),
    );
    const l = drawing.entities[0].loops[0];
    expect(close(l[0], 1) && close(l[1], 0)).toBe(true);
    expect(close(l[2], -1)).toBe(true);
  });

  it('converts SOLID with vertex order 1, 2, 4, 3', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'SOLID', 10, 0, 20, 0, 11, 10, 21, 0, 12, 0, 22, 10, 13, 10, 23, 10,
        0, 'TRACE', 10, 0, 20, 0, 11, 4, 21, 0, 12, 2, 22, 3, 13, 2, 23, 3,
      ]),
    );
    const [s, t] = drawing.entities;
    expect(s).toMatchObject({ type: 'hatch', pattern: 'SOLID' });
    expect(s.loops).toEqual([[0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]]);
    expect(t.loops).toEqual([[0, 0, 0, 4, 0, 0, 2, 3, 0]]);
  });

  it('reads blocks and INSERT, expands MINSERT arrays, drops model and paper space blocks', () => {
    const { drawing } = parseDxf(
      dxf(
        [
          0, 'INSERT', 2, 'chair', 10, 5, 20, 6, 41, 2, 42, 3, 50, 90,
          0, 'INSERT', 100, 'AcDbMInsertBlock', 2, 'CHAIR', 10, 0, 20, 0, 70, 3, 71, 2, 44, 10, 45, 20,
        ],
        {
          blocks: [
            0, 'BLOCK', 2, '*Model_Space', 10, 0, 20, 0, 0, 'ENDBLK',
            0, 'BLOCK', 2, '*Paper_Space', 10, 0, 20, 0, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDBLK',
            0, 'BLOCK', 2, 'Chair', 70, 0, 10, 1, 20, 2, 3, 'Chair',
            0, 'CIRCLE', 8, '0', 10, 1, 20, 2, 40, 1,
            0, 'LINE', 67, 1, 10, 0, 20, 0, 11, 1, 21, 1,
            0, 'ENDBLK',
          ],
        },
      ),
    );
    expect(drawing.blocks.length).toBe(1);
    const b = drawing.blocks[0];
    expect(b).toMatchObject({ name: 'Chair', bx: 1, by: 2 });
    expect(b.entities.map((e) => [e.type, e.id])).toEqual([['circle', 1], ['line', 2]]);
    const [ins, ...grid] = drawing.entities;
    expect(ins).toMatchObject({ type: 'insert', name: 'Chair', x: 5, y: 6, sx: 2, sy: 3 });
    expect(close(ins.rot, Math.PI / 2)).toBe(true);
    expect(grid.length).toBe(6);
    expect(grid.map((e) => [e.x, e.y])).toEqual([[0, 0], [10, 0], [20, 0], [0, 20], [10, 20], [20, 20]]);
    expect(drawing.entities.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('parseDxf: tables and header', () => {
  const tables = [
    0, 'TABLE', 2, 'LTYPE', 70, 1,
    0, 'LTYPE', 2, 'DASHDOT2', 70, 0, 3, 'Dash dot', 72, 65, 73, 4, 40, 10, 49, 5, 74, 0, 49, -2.5, 74, 0, 49, 0, 74, 0, 49, -2.5, 74, 0,
    0, 'ENDTAB',
    0, 'TABLE', 2, 'LAYER', 70, 3,
    0, 'LAYER', 2, 'Off', 70, 0, 62, -5, 6, 'dashdot2', 370, 50,
    0, 'LAYER', 2, 'Frozen', 70, 5, 62, 1, 420, 0xff8000, 6, 'Continuous', 290, 0,
    0, 'LAYER', 2, 'Clear', 70, 0, 62, 2, 6, 'Continuous', 1001, 'AcCmTransparency', 1071, 0x02000000 | 128,
    0, 'ENDTAB',
    0, 'TABLE', 2, 'STYLE', 70, 1,
    0, 'STYLE', 5, '11', 2, 'Notes', 70, 0, 40, 0, 41, 0.8, 50, 15, 3, 'monos.ttf',
    0, 'ENDTAB',
    0, 'TABLE', 2, 'BLOCK_RECORD', 70, 1,
    0, 'BLOCK_RECORD', 5, '1F', 2, '_ArchTick',
    0, 'ENDTAB',
    0, 'TABLE', 2, 'DIMSTYLE', 70, 1,
    0, 'DIMSTYLE', 105, '2A', 2, 'ISO', 70, 0, 3, '<> mm', 40, 2, 41, 3, 42, 1, 44, 2, 77, 0, 73, 1, 78, 8,
    140, 3.5, 141, -2, 147, 1, 271, 3, 340, '11', 342, '1F',
    0, 'ENDTAB',
  ];
  const header = [
    9, '$ACADVER', 1, 'AC1015',
    9, '$INSUNITS', 70, 1,
    9, '$LTSCALE', 40, 2.5,
    9, '$CLAYER', 8, 'off',
    9, '$TEXTSIZE', 40, 3,
    9, '$DIMSTYLE', 2, 'iso',
    9, '$TEXTSTYLE', 7, 'NOTES',
    9, '$LUNITS', 70, 4,
    9, '$LUPREC', 70, 3,
    9, '$AUNITS', 70, 1,
    9, '$AUPREC', 70, 2,
    9, '$PDMODE', 70, 35,
    9, '$PDSIZE', 40, -5,
  ];

  it('reads layers with off, frozen, locked, true colors, linetype and lineweight', () => {
    const { drawing } = parseDxf(dxf([], { tables, header }));
    const by = Object.fromEntries(drawing.layers.map((l) => [l.name, l]));
    expect(by['0']).toBeDefined();
    expect(by.Off).toMatchObject({ on: false, color: 5, frozen: false, locked: false, linetype: 'DASHDOT2', lineweight: 50 });
    expect(by.Frozen).toMatchObject({ on: true, color: '#ff8000', frozen: true, locked: true, plot: false, lineweight: -3 });
    expect(by.Clear.transparency).toBe(50);
    const lt = drawing.linetypes.find((l) => l.name === 'DASHDOT2');
    expect(lt.pattern).toEqual([5, -2.5, 0, -2.5]);
    expect(drawing.linetypes.some((l) => l.name === 'Continuous')).toBe(true);
  });

  it('reads text and dimension styles and always provides the standard entries', () => {
    const { drawing } = parseDxf(dxf([], { tables, header }));
    const st = drawing.textStyles.find((s) => s.name === 'Notes');
    expect(st).toMatchObject({ font: 'mono', height: 0, widthFactor: 0.8 });
    expect(close(st.oblique, (15 * Math.PI) / 180)).toBe(true);
    expect(drawing.textStyles.some((s) => s.name === 'Standard')).toBe(true);
    const ds = drawing.dimStyles.find((s) => s.name === 'ISO');
    expect(ds).toMatchObject({
      scale: 2, arrowSize: 3, extOffset: 1, extExtend: 2, textPlacement: 'centered', textAlign: 'horizontal',
      trailingZeros: false, textHeight: 3.5, centerMark: 2, textGap: 1, precision: 3, textStyle: 'Notes',
      arrowType: 'tick', prefix: '', suffix: ' mm',
    });
    expect(drawing.dimStyles.some((s) => s.name === 'Standard')).toBe(true);
  });

  it('draws table entities through their anonymous block after a TABLES section', () => {
    const { drawing } = parseDxf(
      dxf([0, 'ACAD_TABLE', 2, '*T1', 10, 3, 20, 4], {
        tables,
        blocks: [0, 'BLOCK', 2, '*T1', 70, 1, 10, 0, 20, 0, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0, 0, 'ENDBLK'],
      }),
    );
    expect(drawing.entities[0]).toMatchObject({ type: 'insert', name: '*T1', x: 3, y: 4 });
    expect(drawing.blocks.map((b) => b.name)).toEqual(['*T1']);
  });

  it('gives text without a style the file\'s STANDARD style, whatever its case', () => {
    const { drawing } = parseDxf(
      dxf([0, 'TEXT', 10, 0, 20, 0, 40, 2, 1, 'A', 0, 'TEXT', 10, 0, 20, 0, 40, 2, 1, 'B', 7, 'gone', 0, 'DIMENSION', 70, 0, 13, 0, 14, 5], {
        tables: [
          0, 'TABLE', 2, 'STYLE', 70, 1, 0, 'STYLE', 2, 'STANDARD', 70, 0, 40, 0, 41, 0.8, 3, 'txt', 0, 'ENDTAB',
          0, 'TABLE', 2, 'DIMSTYLE', 70, 1, 0, 'DIMSTYLE', 2, 'STANDARD', 70, 0, 0, 'ENDTAB',
        ],
      }),
    );
    expect(drawing.entities.map((e) => e.style)).toEqual(['STANDARD', 'STANDARD', 'STANDARD']);
    expect(drawing.textStyles.map((s) => s.name)).toEqual(['STANDARD']);
    expect(drawing.header).toMatchObject({ textStyle: 'STANDARD', dimStyle: 'STANDARD' });
  });

  it('reads header variables', () => {
    const { drawing } = parseDxf(dxf([], { tables, header }));
    expect(drawing.header).toMatchObject({
      units: 'in', ltscale: 2.5, clayer: 'Off', textHeight: 3, dimStyle: 'ISO', textStyle: 'Notes',
      linearFormat: 'architectural', linearPrecision: 3, angularFormat: 'dms', angularPrecision: 2,
      pdmode: 35, pdsize: -5,
    });
  });
});

describe('parseDxf: annotations', () => {
  it('maps DIMENSION definition points and drops anonymous dimension blocks', () => {
    const { drawing } = parseDxf(
      dxf(
        [
          0, 'DIMENSION', 2, '*D1', 3, 'Standard', 10, 10, 20, 5, 11, 5, 21, 5, 70, 32, 1, '<>', 13, 0, 23, 0, 14, 10, 24, 0, 50, 0,
          0, 'DIMENSION', 2, '*D2', 10, 0, 20, 10, 11, 2, 21, 7, 70, 33, 1, 'L=<>', 13, 0, 23, 0, 14, 10, 24, 10,
          0, 'DIMENSION', 2, '*D3', 10, 1, 20, 1, 11, 5, 21, 5, 70, 36, 15, 4, 25, 5,
          0, 'DIMENSION', 2, '*D4', 10, -3, 20, 0, 11, 5, 21, 0, 70, 35, 15, 3, 25, 0,
          0, 'DIMENSION', 2, '*D5', 10, 5, 20, 5, 11, 5, 21, 5, 70, 37, 13, 10, 23, 0, 14, 0, 24, 10, 15, 0, 25, 0,
          0, 'DIMENSION', 2, '*D6', 10, 0, 20, 0, 11, 5, 21, 5, 70, 102, 13, 3, 23, 4, 14, 3, 24, 9,
          0, 'DIMENSION', 2, '*D7', 10, 0, 20, 10, 11, 5, 21, 5, 70, 34, 13, 0, 23, 0, 14, 5, 24, 0, 15, 0, 25, 0, 16, 3, 26, 3,
        ],
        { blocks: [0, 'BLOCK', 2, '*D1', 70, 1, 10, 0, 20, 0, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDBLK'] },
      ),
    );
    expect(drawing.blocks.length).toBe(0);
    const [lin, al, rad, dia, ang, ord, ang2] = drawing.entities;
    expect(lin).toMatchObject({ dimType: 'linear', x1: 0, y1: 0, x2: 10, y2: 0, lx: 10, ly: 5, rot: 0, text: '', style: 'Standard' });
    expect(al).toMatchObject({ dimType: 'aligned', x1: 0, y1: 0, x2: 10, y2: 10, text: 'L=<>' });
    expect(rad).toMatchObject({ dimType: 'radius', x1: 1, y1: 1, x2: 4, y2: 5, lx: 5, ly: 5 });
    expect(dia).toMatchObject({ dimType: 'diameter', x1: 0, y1: 0, x2: 3, y2: 0 });
    expect(ang).toMatchObject({ dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, x3: 0, y3: 0, lx: 5, ly: 5 });
    expect(ord).toMatchObject({ dimType: 'ordinate', x1: 3, y1: 4, x2: 3, y2: 9, ordAxis: 'x' });
    expect(ang2.dimType).toBe('angular');
    expect([ang2.x3, ang2.y3]).toEqual([0, 0]);
    expect([ang2.lx, ang2.ly]).toEqual([3, 3]);
    // rays ordered counter-clockwise: along +X then along +Y
    expect(ang2.y1).toBeCloseTo(0);
    expect(ang2.x1).toBeGreaterThan(0);
    expect(ang2.x2).toBeCloseTo(0);
    expect(ang2.y2).toBeGreaterThan(0);
  });

  it('reads LEADER vertices and merges the linked MTEXT annotation', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'LEADER', 5, 'A0', 3, 'Standard', 71, 1, 73, 0, 76, 3, 10, 0, 20, 0, 10, 5, 20, 5, 10, 8, 20, 5, 340, 'A1',
        0, 'MTEXT', 5, 'A1', 10, 9, 20, 5, 40, 1.8, 1, 'Note \\Ptwo', 71, 4,
        0, 'LEADER', 3, 'Standard', 73, 3, 76, 2, 10, 0, 20, 0, 10, 1, 20, 1,
      ]),
    );
    expect(drawing.entities.length).toBe(2);
    const [a, b] = drawing.entities;
    expect(a).toMatchObject({ type: 'leader', pts: [0, 0, 5, 5, 8, 5], text: 'Note \ntwo', h: 1.8, style: 'Standard' });
    expect(b).toMatchObject({ type: 'leader', pts: [0, 0, 1, 1], text: '' });
  });

  it('reads MULTILEADER lines and text', () => {
    const { drawing } = parseDxf(
      dxf([
        0, 'MULTILEADER', 8, 'Notes', 100, 'AcDbMLeader', 270, 2,
        300, 'CONTEXT_DATA{', 40, 1, 10, 10, 20, 5, 30, 0, 41, 2.5, 140, 1, 145, 0.5, 290, 1, 304, 'Hello', 11, 0, 21, 0, 31, 1,
        12, 11, 22, 6, 32, 0, 13, 1, 23, 0, 33, 0,
        302, 'LEADER{', 290, 1, 291, 1, 10, 9, 20, 5, 30, 0, 11, 1, 21, 0, 31, 0, 40, 1,
        304, 'LEADER_LINE{', 10, 0, 20, 0, 30, 0, 10, 4, 20, 5, 30, 0, 91, 0, 305, '}',
        303, '}', 301, '}',
      ]),
    );
    const [l, t] = drawing.entities;
    expect(l).toMatchObject({ type: 'leader', layer: 'Notes', pts: [0, 0, 4, 5, 9, 5, 10, 5], h: 2.5 });
    expect(t).toMatchObject({ type: 'mtext', x: 11, y: 6, value: 'Hello', h: 2.5 });
  });
});

describe('parseDxf: encodings and robustness', () => {
  const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

  it('decodes code page 1252 bytes in older files', () => {
    const text = dxf([0, 'TEXT', 10, 0, 20, 0, 40, 1, 1, 'caf\u00e9 \u00b0'], {
      header: [9, '$ACADVER', 1, 'AC1015', 9, '$DWGCODEPAGE', 3, 'ANSI_1252'],
    });
    const { drawing } = parseDxf(enc(text).buffer);
    expect(drawing.entities[0].value).toBe('caf\u00e9 \u00b0');
  });

  it('decodes UTF-8 in newer files and \\U+ escapes everywhere', () => {
    const text = dxf([0, 'TEXT', 8, 'L\\U+00E4yer', 10, 0, 20, 0, 40, 1, 1, '\u6e2c\u8a66 \\U+00B1'], {
      header: [9, '$ACADVER', 1, 'AC1027', 9, '$DWGCODEPAGE', 3, 'ANSI_1252'],
    });
    const bytes = new TextEncoder().encode(text);
    const { drawing } = parseDxf(bytes);
    expect(drawing.entities[0].value).toBe('\u6e2c\u8a66 \u00b1');
    expect(drawing.entities[0].layer).toBe('L\u00e4yer');
  });

  it('rejects binary DXF with a clear error', () => {
    const head = 'AutoXXX Binary DXF\r\n\x1a\x00';
    const bytes = new Uint8Array(40);
    for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
    expect(() => parseDxf(bytes)).toThrow(/Binary DXF/);
  });

  it('reads CR-only line endings, tab-indented group codes and UTF-16 text', () => {
    const text = dxf([0, 'TEXT', 10, 0, 20, 0, 40, 1, 1, 'caf\u00e9'], {
      header: [9, '$ACADVER', 1, 'AC1015'],
    });
    const value = (input) => parseDxf(input).drawing.entities[0].value;
    expect(value(text.replace(/\r\n/g, '\r'))).toBe('caf\u00e9');
    expect(value(text.replace(/^ +(\d+)\r$/gm, '\t$1\r'))).toBe('caf\u00e9');
    const s = '\ufeff' + text;
    const le = new Uint8Array(s.length * 2);
    const be = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      le[2 * i] = be[2 * i + 1] = c & 255;
      le[2 * i + 1] = be[2 * i] = c >> 8;
    }
    expect(value(le)).toBe('caf\u00e9');
    expect(value(be)).toBe('caf\u00e9');
  });

  it('throws on garbage input', () => {
    expect(() => parseDxf('hello world\nthis is not a drawing\n')).toThrow(/Not a DXF/);
    expect(() => parseDxf('')).toThrow(/Not a DXF/);
    expect(() => parseDxf('  0\nFOO\n  0\nBAR\n')).toThrow(/Not a DXF/);
  });

  it('keeps what was read from a truncated file and warns', () => {
    const full = dxf([
      0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1,
      0, 'CIRCLE', 10, 0, 20, 0, 40, 5,
      0, 'LINE', 10, 2, 20, 2, 11, 3, 21, 3,
    ]);
    const cut = full.slice(0, full.indexOf('LINE', full.indexOf('CIRCLE')) + 20);
    const { drawing, warnings } = parseDxf(cut);
    expect(drawing.entities.map((e) => e.type)).toEqual(['line', 'circle']);
    expect(warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('records warnings for bad entities instead of throwing', () => {
    const { drawing, warnings } = parseDxf(
      dxf([
        0, 'CIRCLE', 10, 0, 20, 0, 40, 'abc',
        0, 'LWPOLYLINE', 90, 1, 10, 0, 20, 0,
        0, 'HATCH', 2, 'SOLID', 70, 1, 91, 1, 92, 2,
        0, 'SPLINE', 71, 3,
        0, 'LINE', 10, 'x', 20, 0, 11, 1, 21, 1,
      ]),
    );
    expect(drawing.entities.length).toBe(1);
    expect(drawing.entities[0]).toMatchObject({ type: 'line', x1: 0 });
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });

  it('stops at a malformed group code with a warning', () => {
    const text = dxf([0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1]).replace('  0\r\nENDSEC', 'zz\r\nENDSEC');
    const { drawing, warnings } = parseDxf(text);
    expect(drawing.entities.length).toBe(0);
    expect(warnings.some((w) => w.includes('Malformed'))).toBe(true);
  });

  it('accepts LF line endings, comments and padded group codes', () => {
    const text = ['999', 'comment', '0', 'SECTION', '2', 'ENTITIES', '  0', 'POINT', ' 10', '  1.5', '20', '2.5', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const { drawing } = parseDxf(text);
    expect(drawing.entities[0]).toMatchObject({ type: 'point', x: 1.5, y: 2.5 });
  });

  it('reads dimension style colors outside the color index range as ByBlock', () => {
    // LibreDWG writes raw color words such as -1056964608 here
    const { drawing } = parseDxf(
      dxf([], {
        tables: [
          0, 'TABLE', 2, 'DIMSTYLE',
          0, 'DIMSTYLE', 2, 'RAW', 176, -1056964608, 178, 300,
          0, 'DIMSTYLE', 2, 'OK', 176, 256, 178, 3,
          0, 'ENDTAB',
        ],
      }),
    );
    const by = Object.fromEntries(drawing.dimStyles.map((d) => [d.name, [d.lineColor, d.textColor]]));
    expect(by.RAW).toEqual([0, 0]);
    expect(by.OK).toEqual([256, 3]);
  });

  it('shows dimensions of kinds the app does not have through their drawn block', () => {
    const blk = (n) => [0, 'BLOCK', 2, n, 70, 1, 10, 0, 20, 0, 0, 'LINE', 8, '0', 62, 0, 10, 0, 20, 0, 11, 5, 21, 5, 0, 'ENDBLK'];
    const { drawing, warnings, stats } = parseDxf(
      dxf(
        [
          // arc length and jogged radius dimensions, and a linear one for comparison
          0, 'ARC_DIMENSION', 8, 'Dims', 62, 3, 2, '*D1', 10, 5, 20, 5, 11, 5, 21, 6, 70, 37, 13, 0, 23, 0, 14, 5, 24, 5, 15, 0, 25, 5,
          0, 'LARGE_RADIAL_DIMENSION', 8, 'Dims', 2, '*d2', 10, 5, 20, 5, 11, 5, 21, 6, 70, 36, 13, 0, 23, 0, 14, 5, 24, 5, 15, 0, 25, 5,
          0, 'ARC_DIMENSION', 8, 'Dims', 2, '*D9', 10, 5, 20, 5, 70, 37,
          0, 'DIMENSION', 2, '*D3', 10, 5, 20, 5, 11, 5, 21, 6, 70, 32, 13, 0, 23, 0, 14, 10, 24, 0,
        ],
        { blocks: [...blk('*D1'), ...blk('*D2'), ...blk('*D3')] },
      ),
    );
    expect(drawing.entities.map((e) => e.type)).toEqual(['insert', 'insert', 'dimension']);
    expect(drawing.entities[0]).toMatchObject({ name: '*D1', layer: 'Dims', color: 3, x: 0, y: 0, sx: 1, sy: 1, rot: 0 });
    expect(drawing.entities[1].name).toBe('*D2');
    // their blocks stay, the one of the dimension the app draws itself goes
    expect(drawing.blocks.map((b) => b.name)).toEqual(['*D1', '*D2']);
    expect(stats.skipped).toEqual({ ARC_DIMENSION: 1 });
    expect(warnings).toEqual(['Dimensions of kinds that are not supported were imported as blocks. (2 times)']);
  });

  it('keeps a width that is given only on the vertices of a polyline', () => {
    const { drawing, warnings } = parseDxf(
      dxf([
        // constant width 0 in the header, the real width on every vertex
        0, 'LWPOLYLINE', 90, 2, 70, 0, 43, 0, 10, 0, 20, 0, 40, 2, 41, 2, 10, 5, 20, 0, 40, 2, 41, 2,
        0, 'POLYLINE', 66, 1, 70, 0, 0, 'VERTEX', 10, 0, 20, 0, 40, 3, 41, 3, 0, 'VERTEX', 10, 5, 20, 0, 40, 3, 41, 3, 0, 'SEQEND',
        0, 'POLYLINE', 66, 1, 70, 0, 40, 1, 41, 1, 0, 'VERTEX', 10, 0, 20, 0, 0, 'VERTEX', 10, 5, 20, 0, 0, 'SEQEND',
        0, 'POLYLINE', 66, 1, 70, 0, 0, 'VERTEX', 10, 0, 20, 0, 40, 0, 41, 4, 0, 'VERTEX', 10, 5, 20, 0, 40, 4, 41, 0, 0, 'VERTEX', 10, 9, 20, 0, 0, 'SEQEND',
      ]),
    );
    expect(drawing.entities.map((e) => e.width)).toEqual([2, 3, 1, 0]);
    expect(warnings).toEqual(['Variable-width polylines imported with a constant width.']);
  });

  it('does not report text after EOF, such as a DOS end-of-file character, as damage', () => {
    for (const tail of ['\x1a', '\x1a\r\n', '  \r\n\r\n', 'trailing junk\r\n']) {
      const { drawing, warnings } = parseDxf(dxf([0, 'POINT', 10, 1, 20, 2]) + tail);
      expect(drawing.entities).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
  });

  it('reads overflowing and infinite numbers as 0, never as Infinity', () => {
    const { drawing } = parseDxf(
      dxf([0, 'LINE', 10, '1e400', 20, '-1e999', 11, 'Infinity', 21, 4, 0, 'CIRCLE', 10, 1, 20, 2, 40, '-Infinity', 0, 'POINT', 10, '1e308', 20, 5]),
    );
    const [line, point] = drawing.entities;
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([0, 0, 0, 4]);
    // the circle has no usable radius
    expect(point).toMatchObject({ type: 'point', x: 1e308, y: 5 });
    expect(JSON.stringify(drawing.entities)).not.toContain('null');
  });

  it('parses a large file quickly', () => {
    const parts = ['  0\r\nSECTION\r\n  2\r\nENTITIES\r\n'];
    for (let i = 0; i < 100000; i++) {
      parts.push(`  0\r\nLINE\r\n  8\r\nL${i % 10}\r\n 10\r\n${i}\r\n 20\r\n0.5\r\n 30\r\n0.0\r\n 11\r\n${i + 1}\r\n 21\r\n1.5\r\n 31\r\n0.0\r\n`);
    }
    parts.push('  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
    const text = parts.join('');
    const t0 = performance.now();
    const { drawing, stats } = parseDxf(text);
    const ms = performance.now() - t0;
    expect(stats.entities).toBe(100000);
    expect(drawing.layers.length).toBe(11);
    expect(ms).toBeLessThan(3000);
  });
});

describe('parseDxf: draw order', () => {
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(0, 'LINE', 5, (0x20 + i).toString(16), 8, 0, 10, 0, 20, i, 11, 10, 21, i);
  const sortents = (...pairs) => [0, 'SORTENTSTABLE', 5, 'A0', 330, 'A1', 100, 'AcDbSortentsTable', 330, '1F', ...pairs];
  const order = (d) => d.entities.map((e) => `${e.y1}${e.orderGroup == null ? '' : '*'}`).join(' ');

  it('keeps file order and no bands without a SORTENTS table', () => {
    expect(order(parseDxf(dxf(lines)).drawing)).toBe('1 2 3 4 5');
  });

  it('sorts by the SORTENTS table, objects it lists drawing strictly in order', () => {
    // as AutoCAD saves it: a swap of handles, and objects moved past the handle seed
    const swap = parseDxf(dxf(lines, { objects: sortents(331, 22, 5, 23, 331, 23, 5, 22) })).drawing;
    expect(order(swap)).toBe('1 3* 2* 4 5');
    const front = parseDxf(dxf(lines, { objects: sortents(331, 21, 5, '2F', 331, 22, 5, 30) })).drawing;
    expect(order(front)).toBe('3 4 5 1* 2*');
    expect(front.entities[3].orderGroup).not.toBe(front.entities[4].orderGroup);
  });
});

describe('parseDxf: stray blank lines', () => {
  const line = (x) => [0, 'LINE', 8, '0', 10, x, 20, 0, 11, x + 1, 21, 1];
  const text = dxf([...line(1), ...line(5)]);
  // put the stray line where the group code of the second LINE belongs
  const cut = text.indexOf('  0\r\nLINE', 40);

  for (const [what, stray] of [
    ['an empty line', '\r\n'],
    ['a line of spaces', '   \r\n'],
    ['a line with a tab', '\t\r\n'],
  ]) {
    it(`reads on past ${what} between two groups`, () => {
      const { drawing, warnings } = parseDxf(text.slice(0, cut) + stray + text.slice(cut));
      expect(drawing.entities.map((e) => e.x1)).toEqual([1, 5]);
      expect(warnings).toEqual([]);
    });
  }

  it('still stops at a group code that is not a number', () => {
    const { drawing, warnings } = parseDxf(text.slice(0, cut) + ' - \r\n' + text.slice(cut));
    // the record that was being read may be incomplete, so it is not kept either
    expect(drawing.entities).toEqual([]);
    expect(warnings.join(' ')).toMatch(/Malformed group code/);
  });
});

describe('parseDxf: multiline attributes', () => {
  it('does not take the embedded MTEXT object of an R2018 ATTRIB for its own groups', () => {
    // After group 101 the attribute carries an MTEXT object whose groups 10, 11,
    // 40, 41, 72 and 1 mean other things: the direction vector, the width of the
    // text box, the drawing direction and the formatted text.
    const { drawing } = parseDxf(
      dxf(
        [
          0, 'INSERT', 66, 1, 2, 'TAG', 10, 0, 20, 0,
          0, 'ATTRIB', 100, 'AcDbEntity', 8, '0', 100, 'AcDbText', 10, 12, 20, 34, 30, 0, 40, 2.5, 1, 'Line one Line two',
          41, 0.8, 7, 'Standard', 100, 'AcDbAttribute', 280, 0, 2, 'NOTE', 70, 0, 71, 2, 72, 0, 73, 0,
          101, 'Embedded Object', 10, 12, 20, 36.5, 30, 0, 40, 3.5, 41, 60, 46, 0, 71, 1, 72, 5,
          1, '{\\fArial|b0|i0;Line one\\PLine two}', 7, 'Standard', 11, 1, 21, 0, 31, 0, 73, 1, 44, 1,
          0, 'SEQEND',
        ],
        { blocks: [0, 'BLOCK', 2, 'TAG', 10, 0, 20, 0, 0, 'ENDBLK'] },
      ),
    );
    const t = drawing.entities[1];
    expect(t).toMatchObject({ type: 'text', value: 'Line one Line two', x: 12, y: 34, h: 2.5, widthFactor: 0.8, halign: 'left', valign: 'baseline' });
    expect(t.rot).toBe(0);
  });
});
