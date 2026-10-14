import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { readDrawingFragment } from '../src/engine/inserted-drawings.js';
import { recognizedShapeXml, triangleGeometry } from '../src/engine/ink-shapes.js';
import { inkDrawingXml, inkStrokeXml, readInkDrawing, isInkImage, INK_EXTENSION_URI, readInkExtension } from '../src/engine/docx-ink.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));
const stroke = (tool, color, width, points) => ({ tool, color, width, points: points.map(([x, y, p = 0.5]) => ({ x, y, p })) });
const pen = stroke('pen', '1F4E79', 2, [[10, 10, 0.3], [40, 25, 0.6], [80, 12, 0.9], [120, 30, 0.5]]);
const marker = stroke('highlighter', 'FFFF00', 12, [[8, 60], [150, 62]]);
const pencil = stroke('pencil', '404040', 1.5, [[20, 80], [60, 95], [90, 82]]);

/** Put a drawing in a fresh document through the reader opened files use, save it and reopen it. */
async function roundTrip(xml, text = 'Ink over this paragraph.') {
  const pkg = createDocx([paragraph(text)], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const { image, assets } = await readDrawingFragment(xml, { sourceParts: pkg.parts, assetId: 'drawing:ink-1' });
  Object.assign(doc.assets, assets);
  const { assetId, id, ...properties } = image;
  doc.select(0); doc.insertImage(assetId, properties);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { image, bytes, reopened: await DocxPackage.open(bytes), xml: strFromU8(unzipSync(bytes)['word/document.xml']) };
}

describe('ink serialization', () => {
  it('writes each stroke as a filled custom-geometry outline with its ink data', () => {
    const xml = inkStrokeXml(pen, 7, 0);
    expect(xml).toMatch(/<a:custGeom>.*<a:pathLst><a:path w="\d+" h="\d+"><a:moveTo>/);
    expect(xml).toMatch(/<a:solidFill><a:srgbClr val="1F4E79"\/><\/a:solidFill><a:ln><a:noFill\/><\/a:ln>/);
    expect(xml).toContain(`<a:ext uri="${INK_EXTENSION_URI}">`);
    expect(xml).toMatch(/tool="pen" color="1F4E79" width="2" points="95250 95250 30 /);
    expect(inkStrokeXml(marker, 8)).toMatch(/<a:alpha val="50000"\/>/);
    expect(inkStrokeXml(pencil, 9)).toMatch(/<a:pattFill prst="pct75">/);
  });
  it('reads strokes back from a drawing in their group frame', () => {
    const xml = inkDrawingXml({ id: 3, strokes: [pen, pencil], width: 200, height: 120, anchor: { horizontal: 'page', vertical: 'page', x: 9525 * 50, y: 9525 * 80, wrap: 'none', behind: false, order: 2 } });
    const shell = `<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup">${xml.replace(/^<w:drawing>|<\/w:drawing>$/g, '')}</w:drawing>`;
    const ink = readInkDrawing(shell);
    expect(ink).toMatchObject({ canvas: false, width: 200, height: 120 });
    expect(ink.strokes).toHaveLength(2);
    expect(ink.strokes[0]).toMatchObject({ tool: 'pen', color: '1F4E79', width: 2 });
    ink.strokes[0].points.forEach((p, i) => { expect(p.x).toBeCloseTo(pen.points[i].x, 3); expect(p.y).toBeCloseTo(pen.points[i].y, 3); expect(p.p).toBeCloseTo(pen.points[i].p, 2); });
    expect(ink.strokes[1].tool).toBe('pencil');
  });
  it('rejects malformed ink data', () => {
    const ext = data => new DOMParser().parseFromString(`<a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" uri="${INK_EXTENSION_URI}">${data}</a:ext>`, 'application/xml').documentElement;
    const ns = 'xmlns:pdi="http://schemas.puter.com/documents/2026/ink"';
    expect(readInkExtension(ext(`<pdi:stroke ${ns} tool="pen" color="000000" width="1" points="1 2 50"/>`)).stroke.points).toHaveLength(1);
    expect(() => readInkExtension(ext(`<pdi:stroke ${ns} tool="brush" color="000000" width="1" points="1 2 50"/>`))).toThrow(/ink extensions/);
    expect(() => readInkExtension(ext(`<pdi:stroke ${ns} tool="pen" color="000000" width="1" points="1 2"/>`))).toThrow(/ink extensions/);
    expect(() => readInkExtension(ext(`<pdi:stroke ${ns} tool="pen" color="000000" width="1" points="1 2 3" extra="1"/>`))).toThrow(/ink extensions/);
  });
});

describe('ink DOCX round trip', () => {
  it('saves a floating ink group that reopens editable with every stroke', async () => {
    const anchor = { horizontal: 'page', vertical: 'paragraph', x: 9525 * 120, y: -9525 * 4, wrap: 'none', behind: false, order: 1 };
    const { bytes, reopened, xml } = await roundTrip(inkDrawingXml({ id: 1, strokes: [pen, pencil], width: 200, height: 120, anchor }));
    expect(reopened.readOnly).toBeFalsy();
    expect(xml).toMatch(/<wp:anchor [^>]*behindDoc="0"/);
    expect(xml).toMatch(/<wp:positionH relativeFrom="page"><wp:posOffset>1143000<\/wp:posOffset>/);
    expect(xml).toMatch(/<wp:positionV relativeFrom="paragraph"><wp:posOffset>-38100<\/wp:posOffset>/);
    expect(xml).toMatch(/<wp:docPr id="\d+" name="Ink 1" descr="Handwritten ink"\/>/);
    expect(xml).toMatch(/<a:graphicData uri="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordprocessingGroup"><wpg:wgp>/);
    const image = images(reopened)[0];
    expect(isInkImage(image)).toBe(true);
    expect(image.anchor).toMatchObject({ horizontal: 'page', vertical: 'paragraph', behind: false });
    const ink = readInkDrawing(image.shell);
    expect(ink.strokes.map(s => s.tool)).toEqual(['pen', 'pencil']);
    // The reopened scene paints both outlines with their fills.
    const scene = reopened.assets[image.assetId].scene;
    expect(scene.type).toBe('group');
    expect(scene.children).toHaveLength(2);
    expect(scene.children[0].fill).toBe('#1F4E79');
    expect(scene.children[1].fill).toMatchObject({ type: 'pattern', preset: 'pct75' });
    expect(bytes.length).toBeGreaterThan(0);
  });
  it('places highlighter ink behind the text with a translucent fill', async () => {
    const anchor = { horizontal: 'page', vertical: 'page', x: 9525 * 90, y: 9525 * 100, wrap: 'none', behind: true, order: 1 };
    const { reopened, xml } = await roundTrip(inkDrawingXml({ id: 1, strokes: [marker], width: 170, height: 80, anchor }));
    expect(xml).toMatch(/behindDoc="1"/);
    expect(xml).toMatch(/descr="Highlighter ink"/);
    const image = images(reopened)[0];
    expect(image.anchor.behind).toBe(true);
    expect(reopened.assets[image.assetId].scene.children[0].fill).toBe('rgba(255,255,0,0.5)');
  });
  it('saves an inline drawing canvas with its frame and strokes', async () => {
    const { reopened, xml } = await roundTrip(inkDrawingXml({ id: 1, strokes: [pen], width: 400, height: 200, canvas: true }));
    expect(xml).toMatch(/<wp:inline [^>]*><wp:extent cx="3810000" cy="1905000"\/>/);
    expect(xml).toMatch(/name="Drawing Canvas 1"/);
    const image = images(reopened)[0];
    const ink = readInkDrawing(image.shell);
    expect(ink).toMatchObject({ canvas: true, width: 400, height: 200 });
    expect(ink.strokes).toHaveLength(1);
    expect(reopened.assets[image.assetId].scene.children).toHaveLength(2);
  });
  it('treats groups with unmarked children as ordinary drawings', () => {
    expect(readInkDrawing('<w:drawing/>')).toBeNull();
    expect(isInkImage({ retainedDrawing: true, shell: '<w:drawing/>' })).toBe(false);
  });
});

describe('ink to shape output', () => {
  const anchor = { horizontal: 'page', vertical: 'page', x: 9525 * 100, y: 9525 * 200, wrap: 'none', behind: false, order: 1 };
  it('writes recognised shapes as outlined presets that reopen as shapes', async () => {
    const cases = [
      [{ kind: 'rect', cx: 150, cy: 100, width: 120, height: 60, angle: 0 }, /<a:prstGeom prst="rect">.*<a:noFill\/>/],
      [{ kind: 'ellipse', cx: 150, cy: 100, width: 80, height: 40, angle: Math.PI / 6 }, /<a:xfrm rot="1800000">.*prst="ellipse"/],
      [{ kind: 'arrow', from: { x: 200, y: 50 }, to: { x: 100, y: 120 } }, /<a:xfrm flipH="1">.*prst="line".*<a:tailEnd type="triangle"\/>/],
      [{ kind: 'triangle', vertices: [{ x: 50, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] }, /prst="triangle"/],
      [{ kind: 'triangle', vertices: [{ x: 0, y: 0 }, { x: 100, y: 30 }, { x: 40, y: 90 }] }, /<a:custGeom>/],
    ];
    for (const [shape, pattern] of cases) {
      const { xml, bounds } = recognizedShapeXml(shape, { id: 4, anchor, color: '0070C0', widthPx: 2 });
      expect(xml).toMatch(pattern);
      expect(xml).toMatch(/<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="0070C0"\/><\/a:solidFill><a:round\/>/);
      expect(bounds.width).toBeGreaterThan(0);
      const { reopened } = await roundTrip(xml);
      expect(reopened.readOnly).toBeFalsy();
      const image = images(reopened)[0];
      expect(reopened.assets[image.assetId].scene.type).toBe('shape');
    }
  });
  it('picks triangle presets and flips from the drawn corners', () => {
    expect(triangleGeometry([{ x: 50, y: 80 }, { x: 0, y: 0 }, { x: 100, y: 0 }])).toEqual({ preset: 'triangle', flipV: true });
    expect(triangleGeometry([{ x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }])).toEqual({ preset: 'rtTriangle', flipH: true, flipV: false });
  });
});
