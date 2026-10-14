import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureFragment } from '../src/engine/picture-insert.js';
import { readDrawingFragment } from '../src/engine/inserted-drawings.js';
import { shapeDrawingXml } from '../src/engine/authored-shapes.js';
import { materializeDrawing, readFormattedDrawing, drawingParts } from '../src/engine/drawing-format.js';
import { setFill, setOutline, setEffects, setGeometry, setTransform, setBlipEffects, setCrop, setBodyProperties, setDocProperties, writeFrame, readFrame, describeDrawing, setPictureLayer } from '../src/engine/drawing-xml.js';
import { setTextRunEffects } from '../src/engine/drawing-text-effects.js';
import { moveDrawings, reorderDrawings } from '../src/engine/drawing-arrange.js';
import { pruneReleasedMedia } from '../src/engine/docx-media-release.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const png = new Uint8Array(readFileSync('icon-128.png'));
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));
const modelOf = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const exportBytes = async (pkg, doc) => new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
function place(doc, image, fragment) {
  Object.assign(doc.assets, fragment.assets);
  doc.checkpoint();
  for (const p of doc.paragraphs) for (const run of p.runs) if (run.image === image) run.image = fragment.image;
  doc.didChange();
}
const anchor = { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order: 1 };
/** A saved and reopened document with a floating picture and a floating text box. */
async function saved() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = modelOf(pkg);
  doc.replace('Text with drawings. ');
  const picture = await pictureFragment(doc, pkg.parts, { png, width: 914400, height: 685800, id: 1, name: 'Picture 1', anchor });
  Object.assign(doc.assets, picture.assets);
  { const { assetId, id, ...properties } = picture.image; doc.insertImage(assetId, properties); }
  const shape = await readDrawingFragment(shapeDrawingXml({ id: 2, name: 'Text Box 2', preset: 'rect', width: 1828800, height: 914400, fill: 'FFFFFF', line: '000000', lineWidth: 12700,
    anchor: { ...anchor, x: 2000000, order: 2 }, text: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>' }).replace(/^<w:drawing [^>]*>/, '<w:drawing>'));
  Object.assign(doc.assets, shape.assets);
  doc.select(doc.text.length);
  { const { assetId, id, ...properties } = shape.image; doc.insertImage(assetId, properties); }
  const reopened = await DocxPackage.open(await exportBytes(pkg, doc));
  expect(reopened.readOnly).toBeFalsy();
  return { pkg: reopened, doc: modelOf(reopened) };
}
async function edit(pkg, doc, image, mutate) {
  const { drawing, parts } = materializeDrawing(pkg, doc, image);
  const added = [];
  await mutate(drawing, { addPart: (bytes, contentType) => { const relId = `rTest${added.length + 1}`; added.push({ path: `word/media/test-${added.length + 1}.png`, relId, bytes, contentType, relType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' }); return relId; } });
  const fragment = await readFormattedDrawing(pkg, doc, image, drawing, parts, added);
  place(doc, image, fragment);
  return fragment.image;
}
async function roundTrip(pkg, doc) {
  const bytes = await exportBytes(pkg, doc);
  const reopened = await DocxPackage.open(bytes);
  expect(reopened.readOnly).toBeFalsy();
  return { reopened, xml: strFromU8(unzipSync(bytes)['word/document.xml']), parts: unzipSync(bytes) };
}

describe('picture formatting writes DrawingML that reopens editable', () => {
  it('outline, shadow, crop, rotation and picture color effects', async () => {
    const { pkg, doc } = await saved();
    let [picture] = images(doc);
    picture = await edit(pkg, doc, picture, drawing => {
      const { properties, blip, blipFill } = drawingParts(drawing);
      setOutline(properties, { color: 'FFFFFF', width: 101600 });
      setEffects(properties, { shadow: { blur: 63500, distance: 38100, direction: 45, color: '000000', alpha: 0.4 } });
      setBlipEffects(blip, { luminance: { brightness: 0.2, contrast: -0.2 }, grayscale: true, alpha: 0.7 });
      setCrop(blipFill, { left: 5000, right: 5000 });
    });
    expect(picture.retainedDrawing).toBe(true);
    const info = describeDrawing(picture.shell);
    expect(info.outline).toMatchObject({ color: { rgb: 'FFFFFF' }, width: 101600 });
    expect(info.effects.shadow).toMatchObject({ blur: 63500, distance: 38100, direction: 45 });
    expect(info.blip).toMatchObject({ grayscale: true, alpha: 0.7, luminance: { brightness: 0.2, contrast: -0.2 } });
    expect(info.crop).toMatchObject({ left: 5000, right: 5000 });
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toMatch(/<a:ln w="101600"><a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill><\/a:ln>/);
    expect(xml).toMatch(/<a:outerShdw [^>]*blurRad="63500"[^>]*dist="38100"[^>]*dir="2700000"/);
    expect(xml).toMatch(/<a:grayscl\/>/);
    expect(xml).toMatch(/<a:alphaModFix amt="70000"\/>/);
    expect(xml).toMatch(/<a:srcRect l="5000" r="5000"\/>/);
    expect(images(reopened)[0].retainedDrawing).toBe(true);
  });
  it('alt text, decorative flag and names on non-visual properties', async () => {
    const { pkg, doc } = await saved();
    const [picture] = images(doc);
    const next = await edit(pkg, doc, picture, drawing => setDocProperties(drawingParts(drawing).docPr, { description: 'A logo', title: 'Logo', decorative: true, name: 'Company logo' }));
    expect(next).toMatchObject({ alt: 'A logo', decorative: true, name: 'Company logo' });
    const { xml } = await roundTrip(pkg, doc);
    expect(xml).toMatch(/<wp:docPr id="1" name="Company logo" descr="A logo" title="Logo">/);
    expect(xml).toMatch(/adec:decorative[^>]*val="1"/);
  });
  it('keeps the original picture in its layer and adds the processed copy', async () => {
    const { pkg, doc } = await saved();
    const [picture] = images(doc);
    const next = await edit(pkg, doc, picture, (drawing, context) => {
      const { blip } = drawingParts(drawing);
      const original = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      blip.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r:embed', context.addPart(png, 'image/png'));
      setPictureLayer(blip, original, [{ name: 'saturation', attrs: { sat: 0 } }]);
    });
    expect(describeDrawing(next.shell).blip.layer).toMatchObject({ effects: [{ name: 'saturation', attrs: { sat: '0' } }] });
    const { parts, xml } = await roundTrip(pkg, doc);
    expect(Object.keys(parts).filter(p => p.startsWith('word/media/'))).toHaveLength(2);
    expect(xml).toMatch(/a14:imgLayer[^>]*r:embed=/);
  });
  it('preset geometry and frame changes', async () => {
    const { pkg, doc } = await saved();
    const [picture] = images(doc);
    const next = await edit(pkg, doc, picture, drawing => {
      setGeometry(drawingParts(drawing).properties, 'ellipse');
      writeFrame(drawing, { wrap: { type: 'square', side: 'bothSides', distances: { T: 0, B: 0, L: 114300, R: 114300 } }, horizontal: { relativeFrom: 'column', offset: 100000 }, vertical: { relativeFrom: 'paragraph', offset: 50000 } });
    });
    expect(next.anchor).toMatchObject({ wrap: 'square', x: 100000, y: 50000, horizontal: 'column', vertical: 'paragraph' });
    expect(next.aspectLocked).toBe(true);
    expect(readFrame(new DOMParser().parseFromString(next.shell, 'application/xml').documentElement).wrap.type).toBe('square');
    const tight = await edit(pkg, doc, next, drawing => writeFrame(drawing, { wrap: { type: 'tight', side: 'largest' } }));
    expect(tight.anchor).toMatchObject({ wrap: 'square', contour: 'tight', wrapText: 'largest', x: 100000 });
    expect((await roundTrip(pkg, doc)).xml).toMatch(/<wp:wrapTight wrapText="largest"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"\/>/);
    const inline = await edit(pkg, doc, tight, drawing => writeFrame(drawing, { inline: true }));
    expect(inline.anchor).toBeUndefined();
    await roundTrip(pkg, doc);
  });
});

describe('shape formatting', () => {
  it('fill, outline with arrows and dashes, effects, rotation, text box body and WordArt runs', async () => {
    const { pkg, doc } = await saved();
    const shape = images(doc)[1];
    const next = await edit(pkg, doc, shape, drawing => {
      const { properties, body, shape: wsp } = drawingParts(drawing);
      setFill(properties, { type: 'gradient', angle: 90, stops: [{ position: 0, color: 'DDEEFF' }, { position: 100000, color: '3F6FB5' }] });
      setOutline(properties, { color: 'C00000', width: 25400, dash: 'dash', compound: 'dbl' });
      setEffects(properties, { shadow: { blur: 50800, distance: 25400, direction: 90, color: '000000', alpha: 0.3 } });
      setTransform(properties, { rotation: 15 });
      setBodyProperties(body, { anchor: 'ctr', insets: { left: 45720 }, autofit: 'shape' });
      setTextRunEffects(wsp.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'txbxContent')[0], { fill: 'C00000', outline: { color: '000000', width: 9525 }, shadow: { distance: 25400, direction: 45, alpha: 0.4 } });
    });
    const info = describeDrawing(next.shell);
    expect(info.fill).toMatchObject({ type: 'gradient', angle: 90 });
    expect(info.outline).toMatchObject({ dash: 'dash', compound: 'dbl', width: 25400 });
    expect(info.transform.rotation).toBe(15);
    expect(info.body).toMatchObject({ anchor: 'ctr', autofit: 'shape' });
    const { xml } = await roundTrip(pkg, doc);
    expect(xml).toMatch(/<w14:textFill><w14:solidFill><w14:srgbClr w14:val="C00000"\/>/);
    expect(xml).toMatch(/<a:xfrm rot="900000">/);
    expect(xml).toMatch(/anchor="ctr"/);
  });
  it('changes the preset and pattern fill', async () => {
    const { pkg, doc } = await saved();
    const next = await edit(pkg, doc, images(doc)[1], drawing => {
      const { properties } = drawingParts(drawing);
      setGeometry(properties, 'roundRect', { adj: 25000 });
      setFill(properties, { type: 'pattern', preset: 'pct50', foreground: '3F6FB5', background: 'FFFFFF' });
    });
    expect(describeDrawing(next.shell)).toMatchObject({ geometry: { preset: 'roundRect', adjustments: { adj: 25000 } }, fill: { type: 'pattern', preset: 'pct50' } });
    await roundTrip(pkg, doc);
  });
});

describe('arrange in the model', () => {
  it('moves floating drawings and restacks them in one undo step each', async () => {
    const { doc } = await saved();
    const [a, b] = images(doc);
    expect(moveDrawings(doc, [{ image: a, x: 12700, y: 25400 }, { image: b, x: 3000000 }])).toBe(true);
    const [a2, b2] = images(doc);
    expect(a2.anchor).toMatchObject({ x: 12700, y: 25400 }); expect(b2.anchor.x).toBe(3000000);
    expect(a2.anchorChanged && b2.anchorChanged).toBe(true);
    doc.undo();
    expect(images(doc)[0].anchor.x).toBe(0);
    const [front, back] = images(doc);
    expect(reorderDrawings(doc, [front, back])).toBe(true);
    const orders = images(doc).map(i => i.anchor.order);
    expect(orders[0]).toBeGreaterThan(orders[1]);
  });
});

it('drops media that Compress released only when nothing uses it', () => {
  const enc = s => new TextEncoder().encode(s);
  const parts = {
    '[Content_Types].xml': enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/media/a.png" ContentType="image/png"/><Override PartName="/word/media/b.png" ContentType="image/png"/></Types>'),
    'word/_rels/document.xml.rels': enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rA" Type="x/image" Target="media/a.png"/><Relationship Id="rB" Type="x/image" Target="media/b.png"/></Relationships>'),
    'word/document.xml': enc('<w:document><a:blip r:embed="rB"/></w:document>'),
    'word/media/a.png': png, 'word/media/b.png': png,
  };
  pruneReleasedMedia(parts, new Set(['word/media/a.png', 'word/media/b.png']));
  expect(parts['word/media/a.png']).toBeUndefined();
  expect(parts['word/media/b.png']).toBeDefined();
  expect(new TextDecoder().decode(parts['word/_rels/document.xml.rels'])).not.toMatch(/rA/);
  expect(new TextDecoder().decode(parts['[Content_Types].xml'])).not.toMatch(/a\.png/);
});
