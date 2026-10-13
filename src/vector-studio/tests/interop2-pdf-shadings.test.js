import { describe, it, expect } from 'vitest';
import { buildPDF, leaves, tree } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { createMesh, meshPoint, patchColor } from '../src/features/mesh/mesh-model.js';
import { coonsPatchData } from '../src/features/mesh/mesh-export.js';

const open = (bytes) => pdfToDocument(bytes, { families: ['Inter'] });

/** A one-page PDF (media 0 0 200 100) whose page paints `content` with the given shading object as /Sh0 and pattern /P0. */
function withShading(content, shading, { patternMatrix = '' } = {}) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Shading << /Sh0 5 0 R >> /Pattern << /P0 << /PatternType 2 /Shading 5 0 R ${patternMatrix} >> >> >> /Contents 4 0 R >>`,
    { dict: '<< >>', stream: content },
    shading,
  ];
  return buildPDF(objs);
}

const meshes = (doc) => leaves(doc).filter((n) => n.type === 'mesh');
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** A 2 x 3 mesh in PDF user space with curved handles and distinct colors. */
function sampleMesh() {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#000000', '#808080', '#123456', '#abcdef', '#fedcba'];
  const pts = [];
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 3; j++) {
      const p = meshPoint(20 + j * 40, 10 + i * 40, colors[i * 4 + j]);
      Object.assign(p, { lx: p.x - 12, ly: p.y + 3, rx: p.x + 12, ry: p.y - 3, ux: p.x + 2, uy: p.y - 12, dx: p.x - 2, dy: p.y + 12 });
      pts.push(p);
    }
  }
  return createMesh(2, 3, pts);
}

describe('PDF mesh shadings as gradient meshes', () => {
  it('rebuilds a Coons patch mesh (type 6) as one mesh object with its edges and colors', async () => {
    const src = sampleMesh();
    const { bytes, decode } = coonsPatchData(src);
    const sh = { dict: `<< /ShadingType 6 /ColorSpace /DeviceRGB /BitsPerCoordinate 32 /BitsPerComponent 16 /BitsPerFlag 8 /Decode [${decode.join(' ')} 0 1 0 1 0 1] >>`, stream: bytes };
    const doc = await open(withShading('/Sh0 sh', sh));
    const [m] = meshes(doc);
    expect(m).toBeTruthy();
    expect([m.rows, m.cols]).toEqual([2, 3]);
    // The page flips y: document y = 100 - user y.
    src.points.forEach((p, k) => {
      const q = m.points[k];
      expect(q.c).toBe(p.c);
      for (const [a, b] of [['x', 'y'], ['lx', 'ly'], ['rx', 'ry'], ['dx', 'dy'], ['ux', 'uy']]) {
        // Handles that point out of the grid are not written: compare only the ones in use.
        const i = Math.floor(k / 4);
        const j = k % 4;
        if ((a === 'lx' && j === 0) || (a === 'rx' && j === 3) || (a === 'ux' && i === 0) || (a === 'dx' && i === 2)) continue;
        expect(q[a]).toBeCloseTo(p[a], 3);
        expect(q[b]).toBeCloseTo(100 - p[b], 3);
      }
    });
    expect(doc.importWarnings.join(' ')).not.toMatch(/simplified/);
  });

  it('keeps separate patches (and flag-continued strips) as patches, and drops tensor inner points', async () => {
    // Two unrelated patches, the second continuing on edge 1 with a third (flag 1); type 7 adds 4 inner points per patch.
    const pt = (x, y) => [x, y];
    const square = (x0, y0, s) => [pt(x0, y0), pt(x0 + s / 3, y0), pt(x0 + (2 * s) / 3, y0), pt(x0 + s, y0), pt(x0 + s, y0 + s / 3), pt(x0 + s, y0 + (2 * s) / 3), pt(x0 + s, y0 + s), pt(x0 + (2 * s) / 3, y0 + s), pt(x0 + s / 3, y0 + s), pt(x0, y0 + s), pt(x0, y0 + (2 * s) / 3), pt(x0, y0 + s / 3)];
    const bytes = [];
    const coord = (v) => bytes.push(Math.round(v));
    const patch = (flag, pts, cols, inner) => {
      bytes.push(flag);
      for (const [x, y] of pts) coord(x), coord(y);
      for (let k = 0; k < inner; k++) coord(0), coord(0);
      for (const c of cols) bytes.push(...c);
    };
    for (const inner of [0, 4]) {
      bytes.length = 0;
      patch(0, square(0, 0, 30), [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], inner);
      patch(0, square(100, 0, 30), [[0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]], inner);
      // Continue from the second patch's edge p3..p6 (its right side) with a patch further right.
      const next = square(130, 0, 30).slice(4);
      patch(1, next, [[10, 20, 30], [40, 50, 60]], inner);
      const sh = { dict: `<< /ShadingType ${inner ? 7 : 6} /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 255 0 255 0 1 0 1 0 1] >>`, stream: new Uint8Array(bytes) };
      const doc = await open(withShading('/Sh0 sh', sh));
      const ms = meshes(doc);
      expect(ms).toHaveLength(3);
      expect(ms.every((m) => m.rows === 1 && m.cols === 1)).toBe(true);
      expect(ms[0].points.map((p) => p.c)).toEqual(['#ff0000', '#00ff00', '#ffff00', '#0000ff']);
      // The continued patch starts at the previous patch's corner B with its colors.
      expect(ms[2].points[0]).toMatchObject({ x: 130, y: 100 });
      expect(ms[2].points[0].c).toBe('#ffffff');
      expect(ms[2].points[3].c).toBe('#0a141e');
      expect(tree(doc)).toMatch(/group\(mesh,mesh,mesh\)/);
    }
  });

  it('turns lattice and free triangle meshes (types 5 and 4) into meshes', async () => {
    // A 3 x 2 lattice: x, y (8 bits each) and gray.
    const lat = new Uint8Array([0, 0, 0, 100, 0, 255, 0, 50, 128, 100, 50, 64, 0, 100, 255, 100, 100, 0]);
    const doc5 = await open(withShading('/Sh0 sh', { dict: '<< /ShadingType 5 /ColorSpace /DeviceGray /BitsPerCoordinate 8 /BitsPerComponent 8 /VerticesPerRow 2 /Decode [0 255 0 255 0 1] >>', stream: lat }));
    const [m5] = meshes(doc5);
    expect([m5.rows, m5.cols]).toEqual([2, 1]);
    expect(m5.points.map((p) => p.c)).toEqual(['#000000', '#ffffff', '#808080', '#404040', '#ffffff', '#000000']);
    expect(m5.points[5]).toMatchObject({ x: 100, y: 0 });
    // Two triangles: the second shares an edge with the first (flag 1).
    const tri = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 100, 0, 0, 255, 0, 0, 0, 100, 0, 0, 255, 1, 100, 100, 255, 255, 255]);
    const doc4 = await open(withShading('/Sh0 sh', { dict: '<< /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 255 0 255 0 1 0 1 0 1] >>', stream: tri }));
    const ms = meshes(doc4);
    expect(ms).toHaveLength(2);
    expect(ms[1].points.map((p) => p.c)).toEqual(['#00ff00', '#0000ff', '#ffffff', '#ffffff']);
  });

  it('samples function-based shadings (type 1) finely enough to follow the function', async () => {
    // gray = y^2 over the unit square, scaled to 100 x 80 at (50, 10).
    const fn = { dict: '<< /FunctionType 4 /Domain [0 1 0 1] /Range [0 1] >>', stream: '{ exch pop dup mul }' };
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Shading << /Sh0 << /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 1 0 1] /Matrix [100 0 0 80 50 10] /Function 5 0 R >> >> >> /Contents 4 0 R >>',
      { dict: '<< >>', stream: '/Sh0 sh' },
      fn,
    ];
    const doc = await open(buildPDF(objs));
    const [m] = meshes(doc);
    expect(m.cols).toBeGreaterThanOrEqual(1);
    expect(m.rows).toBeGreaterThan(2);
    // Compare the bilinear mesh color with the function at a few places.
    for (const t of [0.3, 0.55, 0.8]) {
      const row = t * m.rows;
      const i = Math.min(m.rows - 1, Math.floor(row));
      const c = patchColor(m, i, 0, 0.5, row - i);
      // Row t is the domain's y = t (rows run up the page here).
      const want = t ** 2 * 255;
      expect(Math.abs(c[0] - want)).toBeLessThan(4);
    }
    const p0 = m.points[0];
    expect(p0.x).toBeCloseTo(50);
    expect(p0.y).toBeCloseTo(90);
  });

  it('subdivides meshes whose colors go through a non-linear function', async () => {
    // One patch with parameter 0..1 across; the function is t^3 in gray.
    const sq = [[0, 0], [33, 0], [67, 0], [100, 0], [100, 33], [100, 67], [100, 100], [67, 100], [33, 100], [0, 100], [0, 67], [0, 33]];
    const bytes = [0, ...sq.flat(), 0, 255, 255, 0];
    const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 3 >>';
    const doc = await open(withShading('/Sh0 sh', { dict: `<< /ShadingType 6 /ColorSpace /DeviceGray /Function ${fn} /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 255 0 255 0 1] >>`, stream: new Uint8Array(bytes) }));
    const [m] = meshes(doc);
    expect(m.cols).toBeGreaterThan(1);
    const mid = m.points[Math.floor(m.cols / 2)];
    expect(mid.c).toBe('#202020');
  });

  it('fills a path painted with a mesh shading pattern: the mesh clipped by the path, and keeps its stroke', async () => {
    const src = sampleMesh();
    const { bytes, decode } = coonsPatchData(src);
    const sh = { dict: `<< /ShadingType 6 /ColorSpace /DeviceRGB /BitsPerCoordinate 32 /BitsPerComponent 16 /BitsPerFlag 8 /Decode [${decode.join(' ')} 0 1 0 1 0 1] >>`, stream: bytes };
    const doc = await open(withShading('/Pattern cs /P0 scn 1 0 0 RG 2 w 30 20 60 40 re B', sh));
    expect(tree(doc)).toMatch(/group!clip\(mesh,path\),path/);
    const stroke = leaves(doc).find((n) => n.type === 'path' && n.stroke);
    expect(stroke.stroke.color).toBe('#ff0000');
    expect(stroke.fill).toBeNull();
  });

  it('keeps constant alpha as mesh opacity', async () => {
    const src = sampleMesh();
    const { bytes, decode } = coonsPatchData(src);
    const sh = { dict: `<< /ShadingType 6 /ColorSpace /DeviceRGB /BitsPerCoordinate 32 /BitsPerComponent 16 /BitsPerFlag 8 /Decode [${decode.join(' ')} 0 1 0 1 0 1] >>`, stream: bytes };
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Shading << /Sh0 5 0 R >> /ExtGState << /G0 << /ca 0.5 /BM /Multiply >> >> >> /Contents 4 0 R >>',
      { dict: '<< >>', stream: '/G0 gs /Sh0 sh' },
      sh,
    ];
    const [m] = meshes(await open(buildPDF(objs)));
    expect(m.opacity).toBe(0.5);
    expect(m.blendMode).toBe('multiply');
    expect(hexRgb(m.points[0].c)).toEqual([255, 0, 0]);
  });
});

describe('PostScript mesh shadings', () => {
  it('draws shfill with a lattice mesh as a gradient mesh', async () => {
    const { interpretEPS } = await import('../src/features/interop/ps/eps.js');
    // x, y, gray per vertex: (0,0) black, (100,0) white, (0,100) black, (100,100) gray.
    const hexData = '0000' + '00' + '6400' + 'ff' + '0064' + '00' + '6464' + '80';
    const body = `<< /ShadingType 5 /ColorSpace /DeviceGray /BitsPerCoordinate 8 /BitsPerComponent 8 /VerticesPerRow 2 /Decode [0 255 0 255 0 1] /DataSource <${hexData}> >> shfill`;
    const eps = new TextEncoder().encode(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100\n%%EndComments\n${body}\n%%EOF\n`);
    const r = interpretEPS(eps, { families: ['Inter'] });
    const m = [...r.nodes.values()].find((n) => n.type === 'mesh');
    expect([m.rows, m.cols]).toEqual([1, 1]);
    expect(m.points.map((p) => p.c)).toEqual(['#000000', '#ffffff', '#000000', '#808080']);
  });
});
