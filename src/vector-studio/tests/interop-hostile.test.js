// Hostile and malformed input for the importers: each case must finish quickly with a
// clear result or message, without exhausting memory or hanging.
import { describe, it, expect } from 'vitest';
import { onePage, leaves, enc } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { decodeCCITT } from '../src/features/interop/codec/ccitt.js';

const open = (bytes) => pdfToDocument(bytes, { families: ['Inter'] });

describe('PDF images too large to decode', () => {
  it('become a gray placeholder with a warning instead of a multi-gigabyte decode', async () => {
    const doc = await open(
      onePage('q 100 0 0 50 10 20 cm /I Do Q', {
        resources: '<< /XObject << /I 5 0 R >> >>',
        extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 40000 /Height 40000 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>', stream: 'abc' }],
      }),
    );
    const [box] = leaves(doc);
    expect(box.type).toBe('path');
    expect(box.name).toBe('Image too large to import');
    const xs = box.anchors.map((a) => a.x);
    const ys = box.anchors.map((a) => a.y);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([10, 110]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([30, 80]);
    expect(doc.assets.size).toBe(0);
    expect(doc.importWarnings).toContain('Images too large to import were replaced by gray boxes.');
  });

  it('stencil masks and fax images are limited too', async () => {
    const doc = await open(
      onePage('q 10 0 0 10 0 0 cm /I Do Q', {
        resources: '<< /XObject << /I 5 0 R >> >>',
        extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 100000 /Rows 100000 >> >>', stream: enc('\0\0\0\0') }],
      }),
    );
    expect(leaves(doc).map((n) => n.name)).toEqual(['Image too large to import']);
    expect(() => decodeCCITT(new Uint8Array(4), { K: -1, columns: 100000, rows: 100000 })).toThrow(/too large/);
  });
});

describe('PostScript programs that allocate without bound', () => {
  const eps = (body) => enc(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100\n%%EndComments\n${body}\n%%EOF\n`);

  it('huge strings and arrays are VMerrors a program can catch', async () => {
    const { interpretEPS } = await import('../src/features/interop/ps/eps.js');
    const r = interpretEPS(eps('{ 2000000000 array } stopped { 0 1 0 setrgbcolor } if { 2000000000 string } stopped { 10 10 50 50 rectfill } if'), { families: ['Inter'] });
    const [rect] = [...r.nodes.values()];
    expect(rect.fill.color).toBe('#00ff00');
  });

  it('keeping many large arrays stops at the memory budget', async () => {
    const { interpretEPS } = await import('../src/features/interop/ps/eps.js');
    const r = interpretEPS(eps('10 10 50 50 rectfill { 1000000 array } loop'), { families: ['Inter'] });
    expect(r.nodes.size).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/VMerror in array/);
  });

  it('an endless begin loop stops at the dictionary stack limit', async () => {
    const { interpretEPS } = await import('../src/features/interop/ps/eps.js');
    const r = interpretEPS(eps('{ 10 dict begin } stopped pop countdictstack 260 lt { 10 10 50 50 rectfill } if'), { families: ['Inter'] });
    expect(r.nodes.size).toBe(1);
  });
});

describe('DXF files with extreme values', () => {
  const dxf = (sections) => `${sections.map(([name, body]) => `0\nSECTION\n2\n${name}\n${body.trim()}\n0\nENDSEC`).join('\n')}\n0\nEOF\n`;
  const ent = (type, pairs) => `0\n${type}\n${pairs.map(([c, v]) => `${c}\n${v}`).join('\n')}`;
  const convert = async (text) => {
    const { readDXF, convertDXF } = await import('../src/features/interop/dxf/dxf-import.js');
    return convertDXF(readDXF(text), { unitPt: 1 });
  };
  const paths = (r) => [...r.nodes.values()].filter((n) => n.type === 'path');

  it('arcs and ellipses whose angles are many turns apart draw at most one turn', async () => {
    const r = await convert(
      dxf([
        [
          'ENTITIES',
          [
            ent('ARC', [[8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 1e300]]),
            ent('ARC', [[8, '0'], [10, 0], [20, 0], [40, 10], [50, 1e300], [51, 0]]),
            ent('ELLIPSE', [[8, '0'], [10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5], [41, 0], [42, 1e20]]),
            ent('ARC', [[8, '0'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]]),
          ].join('\n'),
        ],
      ]),
    );
    const list = paths(r);
    expect(list).toHaveLength(4);
    for (const p of list) expect(p.anchors.length).toBeLessThanOrEqual(6);
    // An ordinary quarter arc is unchanged: from (10, 0) to (0, 10) (y flipped).
    const q = list[3].anchors;
    expect(q).toHaveLength(2);
    expect([q[0].x, q[0].y, q[1].x, q[1].y].map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([10, 0, 0, -10]);
  });

  it('arrayed and nested block inserts stop at the work limit with a warning', async () => {
    const block = (name, body) => [ent('BLOCK', [[2, name], [10, 0], [20, 0]]), body, ent('ENDBLK', [])].filter(Boolean).join('\n');
    const line = ent('LINE', [[8, '0'], [10, 0], [20, 0], [11, 1], [21, 1]]);
    // A 30000 x 30000 array of an empty block, and blocks that each insert the next eight times, 16 levels deep.
    const nested = Array.from({ length: 16 }, (_, i) => block(`N${i}`, Array.from({ length: 8 }, () => ent('INSERT', [[8, '0'], [2, `N${i + 1}`], [10, 0], [20, 0]])).join('\n'))).join('\n');
    const r = await convert(
      dxf([
        ['BLOCKS', [block('E', ''), nested, block('N16', ent('XLINE', [[8, '0']]))].join('\n')],
        ['ENTITIES', [line, ent('INSERT', [[8, '0'], [2, 'E'], [10, 0], [20, 0], [70, 30000], [71, 30000]]), ent('INSERT', [[8, '0'], [2, 'N0'], [10, 0], [20, 0]])].join('\n')],
      ]),
    );
    expect(paths(r)).toHaveLength(1);
    expect(r.warnings).toContain('The drawing has too much content: only part of it was imported.');
  });

  it('splines with many control points convert in linear time', async () => {
    const n = 20000;
    const knots = [0, 0, 0, 0, ...Array.from({ length: n - 4 }, (_, i) => i + 1), n - 3, n - 3, n - 3, n - 3];
    const pairs = [[8, '0'], [71, 3], ...knots.map((k) => [40, k]), ...Array.from({ length: n }, (_, i) => [[10, i], [20, i % 7]]).flat()];
    const [path] = paths(await convert(dxf([['ENTITIES', ent('SPLINE', pairs)]])));
    // One cubic Bezier per knot span, starting and ending at the clamped end points.
    expect(path.anchors).toHaveLength(n - 2);
    expect(path.anchors[0]).toMatchObject({ x: 0, y: 0 });
    expect(path.anchors[n - 3]).toMatchObject({ x: n - 1, y: -((n - 1) % 7) || 0 });
  });

  it('polygon meshes whose header counts more vertices than the file has draw what is there', async () => {
    const v = (x, y) => ent('VERTEX', [[8, '0'], [10, x], [20, y], [70, 64]]);
    const text = dxf([['ENTITIES', [ent('POLYLINE', [[8, '0'], [66, 1], [70, 16], [71, 1e9], [72, 1e9]]), v(0, 0), v(10, 0), v(0, 10), '0\nSEQEND'].join('\n')]]);
    // Read as one row of three vertices: two edges.
    expect(paths(await convert(text))).toHaveLength(2);
    const huge = dxf([['ENTITIES', [ent('POLYLINE', [[8, '0'], [66, 1], [70, 16], [71, 1e9], [72, 2]]), v(0, 0), v(10, 0), v(0, 10), v(10, 10), v(0, 20), v(10, 20), '0\nSEQEND'].join('\n')]]);
    // Three rows of two, as the vertices allow: 3 + 4 edges.
    expect(paths(await convert(huge))).toHaveLength(7);
  });
});


describe('Raster files with extreme sizes', () => {
  /** A little-endian TIFF with the given IFD entries ([tag, type, value]) and pixel data. */
  function tiff(tags, data = new Uint8Array(16)) {
    const n = tags.length;
    const dataOff = 8 + 2 + n * 12 + 4;
    const b = new Uint8Array(dataOff + data.length);
    const dv = new DataView(b.buffer);
    b.set([0x49, 0x49, 42, 0]);
    dv.setUint32(4, 8, true);
    dv.setUint16(8, n, true);
    [...tags].sort((x, y) => x[0] - y[0]).forEach(([tag, type, val], i) => {
      const o = 10 + i * 12;
      dv.setUint16(o, tag, true);
      dv.setUint16(o + 2, type, true);
      dv.setUint32(o + 4, 1, true);
      const v = val === 'DATA' ? dataOff : val;
      if (type === 3) dv.setUint16(o + 8, v, true);
      else dv.setUint32(o + 8, v, true);
    });
    b.set(data, dataOff);
    return b;
  }
  const rgb = (w, h, spp = 3) => [[256, 4, w], [257, 4, h], [258, 3, 8], [259, 3, 1], [262, 3, 2], [273, 4, 'DATA'], [277, 3, spp], [278, 4, h], [279, 4, 16]];

  it('refuse sizes that would exhaust memory, with a message that says so', async () => {
    const { decodeRaster } = await import('../src/features/interop/codec/raster.js');
    expect(() => decodeRaster(tiff(rgb(65535, 65535)))).toThrow('The TIFF image is too large to import (65535 x 65535 pixels).');
    expect(() => decodeRaster(tiff(rgb(100, 100, 65535)))).toThrow('The TIFF image has an invalid number of channels.');
    const bmp = new Uint8Array(70);
    const dv = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, 30000, true);
    dv.setInt32(22, 30000, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    expect(() => decodeRaster(bmp)).toThrow('The bitmap is too large to import (30000 x 30000 pixels).');
    // A 2 x 2 image still decodes.
    expect(decodeRaster(tiff(rgb(2, 2), new Uint8Array(12).fill(200)))).toMatchObject({ width: 2, height: 2 });
  });

  it('a truncated file is reported as damaged', async () => {
    const { decodeRaster } = await import('../src/features/interop/codec/raster.js');
    expect(() => decodeRaster(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 32, 0]))).toThrow('The TIFF file is damaged or incomplete.');
  });
});
