import { describe, it, expect } from 'vitest';
import { interpretEPS, dscInfo, epsParts, isPostScript, epsiPreview } from '../src/features/interop/ps/eps.js';
import { PSInterpreter } from '../src/features/interop/ps/interpreter.js';
import { writeEPS, dosEPS, pdfToPostScript } from '../src/features/interop/ps/eps-export.js';
import { onePage } from './interop-helpers.js';
import { encodeTIFF } from '../src/features/interop/codec/tiff.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createImage } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { encodePNGSync } from '../src/features/interop/codec/png.js';
import { bytesToDataUrl } from '../src/features/io/image-info.js';

const FAMILIES = ['Inter', 'Roboto', 'Source Serif 4', 'Roboto Mono'];
const enc = (s) => new TextEncoder().encode(s);
const eps = (body, box = '0 0 200 100') => enc(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: ${box}\n%%EndComments\n${body}\n%%EOF\n`);
const leaves = (r) => [...r.nodes.values()].filter((n) => n.type !== 'group' && !(n.type === 'path' && [...r.nodes.values()].some((c) => c.type === 'compound' && c.children.includes(n.id))));

describe('PostScript interpreter', () => {
  it('draws paths with colors, line styles and transforms', () => {
    const r = interpretEPS(eps('1 0 0 setrgbcolor 10 10 moveto 60 10 lineto 60 40 lineto closepath fill\n1 0 0 0 setcmykcolor 3 setlinewidth 1 setlinecap [5 2] 0 setdash\ngsave 100 50 translate 2 2 scale newpath 0 0 10 0 90 arc stroke grestore'), { families: FAMILIES });
    expect(r.kind).toBe('vector');
    const [tri, arc] = leaves(r);
    expect(tri.fill.color).toBe('#ff0000');
    expect(tri.anchors.map((a) => [a.x, a.y])).toEqual([[10, 90], [60, 90], [60, 60]]);
    expect(arc.stroke.color).toBe('#00ffff');
    expect(arc).toMatchObject({ strokeWidth: 6, strokeCap: 'round', dash: [10, 4] });
    // A quarter circle of radius 20 around (100, 50) in PostScript space.
    expect(arc.anchors[0]).toMatchObject({ x: 120, y: 50 });
    expect(arc.anchors[1].x).toBeCloseTo(100);
    expect(arc.anchors[1].y).toBeCloseTo(30);
  });

  it('runs procedures, loops, dictionaries and conditionals', () => {
    const body = `/box { % x y size
      /s exch def /y exch def /x exch def
      x y moveto s 0 rlineto 0 s rlineto s neg 0 rlineto closepath fill } bind def
    0 1 4 { 20 mul 10 exch 10 box } for
    /n 0 def { n 1 add /n exch def n 3 ge { exit } if } loop
    n 3 eq { 0.5 setgray 150 50 5 box } if
    mark 1 2 3 counttomark 3 eq { cleartomark } { cleartomark } ifelse
    3 dict begin /a 7 def a 7 eq { 0 0 0 setrgbcolor 180 80 5 box } if end`;
    const r = interpretEPS(eps(body), { families: FAMILIES });
    const boxes = leaves(r);
    expect(boxes).toHaveLength(7);
    expect(boxes[5].fill.color).toBe('#808080');
  });

  it('turns clip into clip groups and shfill into gradients', () => {
    const body = `gsave 0 0 100 100 rectclip
      << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0]
         /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >> shfill grestore
      gsave 120 0 50 50 rectclip 1 0 0 setrgbcolor 100 0 100 100 rectfill grestore`;
    const r = interpretEPS(eps(body), { families: FAMILIES });
    const shaded = [...r.nodes.values()].find((n) => n.fill?.type === 'linear');
    expect(shaded.fill.stops.map((s) => s.color)).toEqual(['#ff0000', '#0000ff']);
    expect([...r.nodes.values()].some((n) => n.type === 'group' && n.clip)).toBe(true);
  });

  it('reads images from currentfile (hex and ASCII85 filters) and image masks', () => {
    const body = `gsave 20 10 translate 40 20 scale 2 1 8 [2 0 0 -1 0 1] {currentfile 2 string readhexstring pop} image
00ff
grestore
gsave 0 0 1 setrgbcolor 80 10 translate 8 8 scale 8 1 true [8 0 0 -1 0 1] {<0f>} imagemask grestore
gsave 100 10 translate 10 10 scale /DeviceRGB setcolorspace << /ImageType 1 /Width 1 /Height 1 /BitsPerComponent 8 /Decode [0 1 0 1 0 1] /ImageMatrix [1 0 0 -1 0 1] /DataSource currentfile /ASCIIHexDecode filter >> image
00ff00>
grestore`;
    const interp = new PSInterpreter(eps(body), { base: [1, 0, 0, -1, 0, 100], families: FAMILIES }).run();
    expect(interp.error).toBeFalsy();
    expect(interp.images).toHaveLength(3);
    const [gray, mask, rgb] = interp.images.map((i) => i.img);
    expect(Array.from(gray.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(mask.data[3]).toBe(0);
    expect(mask.data[4 * 4 + 2]).toBe(255);
    expect(mask.data[4 * 4 + 3]).toBe(255);
    expect(Array.from(rgb.data)).toEqual([0, 255, 0, 255]);
  });

  it('keeps text as editable type with matched fonts', () => {
    const r = interpretEPS(eps('/Times-Bold findfont 18 scalefont setfont 10 20 moveto (Caption) show'), { families: FAMILIES });
    const t = leaves(r)[0];
    expect(t).toMatchObject({ type: 'text', text: 'Caption' });
    expect(t.char).toMatchObject({ fontFamily: 'Source Serif 4', fontWeight: 700, fontSize: 18 });
    expect(t.transform[4]).toBeCloseTo(10);
    expect(t.transform[5]).toBeCloseTo(80);
  });

  it('survives errors inside stopped and reports unsupported programs', () => {
    const r = interpretEPS(eps('{ undefinedthing } stopped pop 0 0 10 10 rectfill'), { families: FAMILIES });
    expect(leaves(r)).toHaveLength(1);
    expect(() => interpretEPS(eps('totallyunknownop'), { families: FAMILIES })).toThrow(/no preview/);
  });

  it('stops runaway programs', () => {
    const interp = new PSInterpreter(enc('{ } loop'), { maxOps: 10000 }).run();
    expect(interp.error?.psName).toBe('limitcheck');
  });
});

describe('EPS files', () => {
  it('reads DSC bounding boxes (preferring high resolution) and EPSI previews', () => {
    const ps = enc('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 11 21\n%%HiResBoundingBox: 0.5 0.5 10.5 20.5\n%%Title: (Logo)\n%%BeginPreview: 8 2 1 2\n% FF\n% 00\n%%EndPreview\n');
    const info = dscInfo(ps);
    expect(info.bbox).toEqual({ x: 0.5, y: 0.5, w: 10, h: 20 });
    expect(info.title).toBe('Logo');
    const prev = epsiPreview(ps);
    expect(prev).toMatchObject({ width: 8, height: 2 });
    expect(prev.data[0]).toBe(0);
    expect(prev.data[8 * 4]).toBe(255);
  });

  it('falls back to the TIFF preview of a binary EPS and says so', async () => {
    const tiff = await encodeTIFF({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) }, { compression: 'none' });
    const bin = dosEPS('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 40 20\nsomeprivateoperator\n', tiff);
    expect(isPostScript(bin)).toBe(true);
    expect(epsParts(bin).tiff.length).toBe(tiff.length);
    const r = interpretEPS(bin, { families: FAMILIES });
    expect(r.kind).toBe('preview');
    expect(r.image.width).toBe(2);
    expect(r.warnings[0]).toMatch(/Only the preview image/);
  });
});

describe('EPS export', () => {
  const sampleDoc = () => {
    const doc = VDocument.create({ width: 200, height: 100 });
    const layer = doc.layers()[0];
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
    doc.assets.set('img1', { mime: 'image/png', data: bytesToDataUrl(encodePNGSync({ width: 2, height: 1, data: px }), 'image/png') });
    doc.transact('x', () => {
      doc.insert(createPath(rectangle(10, 10, 50, 30), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 2 }), layer.id);
      doc.insert(createPath(ellipse(100, 10, 60, 40), true, { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#008000', opacity: 1 }] }, stroke: null }), layer.id);
      doc.insert(createImage('img1', 2, 1, [20, 0, 0, 20, 10, 60]), layer.id);
    });
    return doc;
  };

  it('writes Level 3 EPS that imports back as the same artwork', async () => {
    const doc = sampleDoc();
    const { text, warnings } = await writeEPS(doc, { rect: doc.artboards[0], level: 3 });
    expect(text.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100')).toBe(true);
    expect(text).toContain('shfill');
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(text)).toBe(false);
    expect(warnings.join(' ')).not.toMatch(/transparency/);
    const r = interpretEPS(enc(text), { families: FAMILIES });
    expect(r.kind).toBe('vector');
    const nodes = [...r.nodes.values()];
    const rect = nodes.find((n) => n.fill?.color === '#ff0000');
    expect(rect.stroke).toMatchObject({ type: 'solid', color: '#0000ff' });
    expect(rect.strokeWidth).toBeCloseTo(2);
    const xs = rect.anchors.map((a) => a.x);
    const ys = rect.anchors.map((a) => a.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round)).toEqual([10, 60, 10, 40]);
    expect(nodes.some((n) => n.fill?.type === 'linear')).toBe(true);
  });

  it('writes images (pixels and JPEG data) that import back', () => {
    const px = Uint8Array.from([255, 0, 0, 0, 0, 255]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = onePage('q 20 0 0 10 10 10 cm /A Do Q q 10 0 0 10 50 10 cm /J Do Q', {
      resources: '<< /XObject << /A 5 0 R /J 6 0 R >> >>',
      extra: [
        { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>', stream: px },
        { dict: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', stream: jpeg },
      ],
    });
    const { text } = pdfToPostScript(pdf, { level: 2 });
    const r = interpretEPS(enc(text), { families: FAMILIES });
    expect(r.images).toHaveLength(2);
    expect(Array.from(r.images[0].img.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    expect(r.images[1].img).toMatchObject({ kind: 'jpeg', width: 1 });
    expect(Array.from(r.images[1].img.bytes)).toEqual(Array.from(jpeg));
    const img = [...r.nodes.values()].find((n) => n.type === 'image');
    expect(img.transform.map((v) => Math.round(v))).toEqual([10, 0, 0, 10, 10, 80]);
  });

  it('draws gradients as bands for Level 2 and converts colors to CMYK', async () => {
    const doc = sampleDoc();
    const { text } = await writeEPS(doc, { rect: doc.artboards[0], level: 2, colorMode: 'cmyk' });
    expect(text).not.toContain('shfill');
    expect(text).toContain('cmyk');
    expect(text).not.toMatch(/ rgb\b/);
    const r = interpretEPS(enc(text), { families: FAMILIES });
    const red = [...r.nodes.values()].find((n) => n.fill?.color === '#ff0000');
    expect(red).toBeTruthy();
  });

  it('reports transparency it cannot keep', async () => {
    const doc = sampleDoc();
    const id = doc.layers()[0].children[0];
    doc.transact('o', () => doc.update(id, { opacity: 0.5 }));
    const { warnings } = await writeEPS(doc, { rect: doc.artboards[0] });
    expect(warnings.join(' ')).toMatch(/no transparency/);
  });

  it('wraps a TIFF preview in a binary EPS header', () => {
    const tiff = Uint8Array.from([0x49, 0x49, 42, 0, 1, 2, 3]);
    const bin = dosEPS('%!PS\n', tiff);
    const parts = epsParts(bin);
    expect(new TextDecoder().decode(parts.ps)).toBe('%!PS\n');
    expect(Array.from(parts.tiff)).toEqual(Array.from(tiff));
  });
});
