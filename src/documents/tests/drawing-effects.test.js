import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { biLevelPixels, pictureEffectPixels } from '../src/engine/picture-luminance.js';
import { squareExclusions } from '../src/engine/square-wrap.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const png = new Uint8Array(readFileSync('icon-128.png'));
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));
const EXTENT = 'cx="914400" cy="914400"';

/** A picture's spPr children (after the transform) and blip children, in an inline or floating frame. */
function picture({ properties = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', blip = '', transform = '', docPr = '', nvPr = '', anchor = false } = {}) {
  const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="P"${nvPr}/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rPic">${blip}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm${transform}><a:off x="0" y="0"/><a:ext ${EXTENT}/></a:xfrm>${properties}</pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  return frame(graphic, { docPr, anchor });
}
function shape(properties) {
  const graphic = `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${EXTENT}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>${properties}</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>`;
  return frame(graphic, {});
}
function frame(graphic, { docPr = '', anchor = false }) {
  const props = `<wp:docPr id="1" name="Drawing 1"${docPr}/><wp:cNvGraphicFramePr/>`;
  return anchor
    ? `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent ${EXTENT}/><wp:effectExtent l="0" t="0" r="0" b="0"/>${anchor === 'square' ? '<wp:wrapSquare wrapText="bothSides"/>' : '<wp:wrapNone/>'}${props}${graphic}</wp:anchor></w:drawing>`
    : `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent ${EXTENT}/><wp:effectExtent l="0" t="0" r="0" b="0"/>${props}${graphic}</wp:inline></w:drawing>`;
}
function docx(drawing) {
  const parts = { ...createDocx().parts };
  parts['word/media/image1.png'] = png;
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
  parts['word/document.xml'] = strToU8(`<w:document ${NS}><w:body><w:p><w:r><w:t>Before </w:t></w:r><w:r>${drawing}</w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zipSync(parts);
}
const open = drawing => DocxPackage.open(docx(drawing));
async function roundTrip(pkg) {
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.select(0); d.replace('Edited ');
  const bytes = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  return { xml: strFromU8(unzipSync(bytes)['word/document.xml']), reopened: await DocxPackage.open(bytes) };
}
const effects = list => `<a:effectLst>${list}</a:effectLst>`;
const GLOW = '<a:glow rad="63500"><a:srgbClr val="FFC000"><a:alpha val="40000"/></a:srgbClr></a:glow>';
const SHADOW = '<a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:prstClr val="black"><a:alpha val="40000"/></a:prstClr></a:outerShdw>';
const REFLECTION = '<a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dist="12700" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>';
const SOFT = '<a:softEdge rad="31750"/>';

describe('glow, soft edges and reflections', () => {
  it('reads every supported effect on a picture into a retained scene and keeps the XML', async () => {
    const pkg = await open(picture({ properties: `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${effects(GLOW + SHADOW + REFLECTION + SOFT)}` }));
    expect(pkg.readOnly).toBeFalsy();
    const [image] = images(pkg), asset = pkg.assets[image.assetId];
    expect(image.retainedDrawing).toBe(true);
    expect(asset.effects.glow).toEqual({ radius: 63500 / 9525, color: { rgb: 'FFC000', alpha: 0.4 } });
    expect(asset.effects.softEdge).toEqual({ radius: 31750 / 9525 });
    expect(asset.effects.reflection).toMatchObject({ distance: 12700 / 9525, startAlpha: 0.5, endAlpha: 0.003, startPosition: 0, endPosition: 0.55 });
    expect(asset.shadow.blur).toBeCloseTo(50800 / 9525, 6);
    const { xml, reopened } = await roundTrip(pkg);
    for (const effect of [GLOW, REFLECTION, SOFT]) expect(xml).toContain(effect);
    expect(reopened.readOnly).toBeFalsy();
  });

  it('reads glow and soft edges on a standalone shape scene', async () => {
    const pkg = await open(shape(effects(GLOW + SOFT)));
    const [image] = images(pkg), scene = pkg.assets[image.assetId].scene;
    expect(scene.effects.glow.radius).toBeCloseTo(63500 / 9525, 6);
    expect(scene.effects.softEdge.radius).toBeCloseTo(31750 / 9525, 6);
    expect(scene.shadow).toBeUndefined();
    const { xml } = await roundTrip(pkg);
    expect(xml).toContain(GLOW);
  });

  it('keeps a shadow-only effect list exactly as before', async () => {
    const pkg = await open(picture({ properties: `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${effects(SHADOW)}` }));
    const asset = pkg.assets[images(pkg)[0].assetId];
    expect(asset.effects).toBeUndefined();
    expect(asset.shadow).toMatchObject({ obscured: false });
  });

  it.each([
    ['an inner shadow', '<a:innerShdw blurRad="63500"><a:srgbClr val="000000"/></a:innerShdw>'],
    ['misordered effects', SOFT + GLOW],
    ['duplicate effects', GLOW + GLOW],
    ['a sideways reflection', '<a:reflection sx="-100000" algn="r"/>'],
    ['an upright reflection', '<a:reflection sy="100000"/>'],
    ['a glow without a color', '<a:glow rad="1000"/>'],
    ['a soft edge with an invalid radius', '<a:softEdge rad="-4"/>'],
  ])('fails closed for %s', async (_, list) => {
    await expect(open(picture({ properties: `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${effects(list)}` }))).rejects.toThrow();
  });

  it('keeps grouped and nested shapes unsupported with the new effects', async () => {
    const group = `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext ${EXTENT}/><a:chOff x="0" y="0"/><a:chExt ${EXTENT}/></a:xfrm></wpg:grpSpPr>`
      + `<wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${EXTENT}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>${effects(GLOW)}</wps:spPr><wps:bodyPr/></wps:wsp></wpg:wgp></a:graphicData></a:graphic>`;
    await expect(open(frame(group, {}))).rejects.toThrow();
  });
});

describe('preset picture geometry', () => {
  it('clips a picture to any preset with adjustments and follows it with the outline', async () => {
    const geometry = '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>';
    const pkg = await open(picture({ properties: `${geometry}<a:ln w="25400"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill></a:ln>` }));
    expect(pkg.readOnly).toBeFalsy();
    const scene = pkg.assets[images(pkg)[0].assetId].scene;
    const texture = scene.children.find(c => c.type === 'picture');
    expect(texture.clipPaths[0].points.some(p => p[0] === 'C')).toBe(true);
    expect(scene.children.find(c => c.outline)?.paths[0].points.some(p => p[0] === 'C')).toBe(true);
    expect((await roundTrip(pkg)).xml).toContain(geometry);
  });
  it('clips without an outline for presets such as a hexagon', async () => {
    const pkg = await open(picture({ properties: '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom>' }));
    const [image] = images(pkg);
    expect(image.retainedDrawing).toBe(true);
    expect(pkg.assets[image.assetId].scene.clipPaths[0].points.length).toBeGreaterThan(5);
  });
  it('still rejects unknown presets', async () => {
    await expect(open(picture({ properties: '<a:prstGeom prst="notAShape"><a:avLst/></a:prstGeom>' }))).rejects.toThrow();
  });
});

describe('rotated and flipped styled pictures', () => {
  it('opens a bordered, shadowed picture with rotation and flips; the page rotates the scene', async () => {
    const pkg = await open(picture({ transform: ' rot="1800000" flipH="1"', anchor: true,
      properties: `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>${effects(SHADOW)}` }));
    expect(pkg.readOnly).toBeFalsy();
    const [image] = images(pkg);
    expect(image.retainedDrawing).toBe(true);
    expect(image.rotation).toBe(1800000);
    const texture = pkg.assets[image.assetId].scene.children.find(c => c.type === 'picture');
    expect(texture.image.flipH).toBe(true);
    expect((await roundTrip(pkg)).xml).toContain('rot="1800000"');
  });
  it('keeps rotated 3D pictures unsupported', async () => {
    await expect(open(picture({ transform: ' rot="600000"', properties: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT w="38100" h="38100"/></a:sp3d>' }))).rejects.toThrow();
  });
});

describe('black and white pictures', () => {
  it('reads a:biLevel into the ordered color pipeline and maps luminance to black or white', async () => {
    const pkg = await open(picture({ blip: '<a:biLevel thresh="50000"/>' }));
    const [image] = images(pkg);
    expect(pkg.assets[image.assetId].pictureEffects).toEqual([{ type: 'biLevel', threshold: 0.5 }]);
    expect((await roundTrip(pkg)).xml).toContain('<a:biLevel thresh="50000"/>');
    const data = new Uint8ClampedArray([200, 200, 200, 128, 20, 30, 40, 255]);
    biLevelPixels(data, 0.5);
    expect([...data]).toEqual([255, 255, 255, 128, 0, 0, 0, 255]);
    expect([...pictureEffectPixels(new Uint8ClampedArray([255, 0, 0, 255]), [{ type: 'biLevel', threshold: 0.2 }])]).toEqual([255, 255, 255, 255]);
  });
  it('rejects a missing or invalid threshold', async () => {
    await expect(open(picture({ blip: '<a:biLevel/>' }))).rejects.toThrow();
    await expect(open(picture({ blip: '<a:biLevel thresh="150000"/>' }))).rejects.toThrow();
  });
});

describe('hidden drawings', () => {
  it('opens hidden pictures and shapes, keeps the flag in the XML and leaves them out of text wrapping', async () => {
    const pkg = await open(picture({ docPr: ' hidden="1"', anchor: 'square' }));
    expect(pkg.readOnly).toBeFalsy();
    const [image] = images(pkg);
    expect(image.hidden).toBe(true);
    expect((await roundTrip(pkg)).xml).toMatch(/<wp:docPr id="1" name="Drawing 1" hidden="1"\/>/);
    const layout = { floatingObjects: [{ page: 0, x: 0, y: 0, width: 10, height: 10, image }, { page: 0, x: 0, y: 0, width: 10, height: 10, image: { ...image, hidden: undefined } }] };
    expect(squareExclusions(layout)).toHaveLength(1);
    const inner = await open(picture({ nvPr: ' hidden="true"' }));
    expect(images(inner)[0].hidden).toBe(true);
    const shown = await open(picture({ docPr: ' hidden="0"' }));
    expect(images(shown)[0].hidden).toBeUndefined();
  });
  it('rejects invalid hidden flags', async () => {
    await expect(open(picture({ docPr: ' hidden="maybe"' }))).rejects.toThrow();
  });
});
