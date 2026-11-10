import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { buildShape, shapeParams, shapeDrawingXml, SHAPE_PRESETS, LINE_PRESETS, EMU_PER_INCH } from '../src/engine/authored-shapes.js';
import { PRESET_GEOMETRIES } from '../src/engine/preset-geometries.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const defaults = name => key => PRESET_GEOMETRIES[name].defaults[key];
const close = (points, expected) => points.forEach((p, i) => p.slice(1).forEach((v, j) => expect(v).toBeCloseTo(expected[i][j + 1], 3)));

describe('ECMA-376 preset geometries', () => {
  it('builds the default outlines and text rectangles', () => {
    expect(PRESET_GEOMETRIES.diamond.build(100, 60, defaults('diamond')).points).toEqual([['M', 0, 30], ['L', 50, 0], ['L', 100, 30], ['L', 50, 60], ['Z']]);
    const right = PRESET_GEOMETRIES.rightArrow.build(200, 100, defaults('rightArrow'));
    close(right.points, [['M', 0, 25], ['L', 150, 25], ['L', 150, 0], ['L', 200, 50], ['L', 150, 100], ['L', 150, 75], ['L', 0, 75], ['Z']]);
    expect(right.text).toEqual([0, 25, 175, 75]);
    const left = PRESET_GEOMETRIES.leftArrow.build(200, 100, defaults('leftArrow'));
    close(left.points, [['M', 0, 50], ['L', 50, 0], ['L', 50, 25], ['L', 200, 25], ['L', 200, 75], ['L', 50, 75], ['L', 50, 100], ['Z']]);
    expect(left.text).toEqual([25, 25, 200, 75]);
    const plus = PRESET_GEOMETRIES.plus.build(200, 100, defaults('plus'));
    expect(plus.text).toEqual([0, 25, 200, 75]);
    const pentagon = PRESET_GEOMETRIES.pentagon.build(100, 100, defaults('pentagon'));
    expect(pentagon.points[1]).toEqual(['L', 50, 0]);
    expect(pentagon.points[0][1] + pentagon.points[2][1]).toBeCloseTo(100, 6);
    const star = PRESET_GEOMETRIES.star4.build(100, 100, defaults('star4'));
    expect(star.points.filter(p => p[0] !== 'Z')).toHaveLength(8);
  });
  it('clamps adjustments to the preset limits', () => {
    const wide = PRESET_GEOMETRIES.trapezoid.build(100, 100, key => key === 'adj' ? 900000 : 0);
    expect(wide.points[1][1]).toBe(50);
  });
});

describe('authored shapes', () => {
  it('every gallery preset builds and reads back its parameters', () => {
    for (const [preset, name, , w, h] of SHAPE_PRESETS) {
      const { image, asset } = buildShape({ id: 3, name, preset, width: Math.round(w * EMU_PER_INCH), height: Math.round(h * EMU_PER_INCH), fill: LINE_PRESETS.has(preset) ? null : 'ABCDEF', line: '123456', lineWidth: 19050, assetId: 'drawing:t' });
      expect(asset.scene.paths.length, preset).toBeGreaterThan(0);
      expect(shapeParams(image), preset).toEqual({ preset, fill: LINE_PRESETS.has(preset) ? null : 'ABCDEF', line: '123456', lineWidth: 19050 });
    }
  });
  it('keeps text boxes and declines drawings it cannot rewrite', () => {
    const textBox = DocxPackage.open(readFileSync('public/fixtures/arrow-homePlate.docx'));
    return textBox.then(pkg => {
      const image = pkg.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image))[0];
      // A shape with a text box is rewritable; its paragraphs and body properties travel unchanged.
      const params = shapeParams(image);
      expect(params).toMatchObject({ preset: 'homePlate', fill: '228844', line: null });
      expect(params.text).toContain('<w:t>Text</w:t>');
      expect(params.bodyXml).toContain('lIns="10000"');
      expect(shapeParams({ ...image, shell: image.shell.replace('<a:avLst/>', '<a:avLst><a:gd name="adj" fmla="val 30000"/></a:avLst>') })).toBe(null);
      const rotated = { ...image, shell: shapeDrawingXml({ id: 1, name: 'x', preset: 'rect', width: 10, height: 10, fill: null, line: null, lineWidth: 0 }).replace('<a:xfrm>', '<a:xfrm rot="60000">') };
      expect(shapeParams(rotated)).toBe(null);
    });
  });
  it('saves a floating shape as DrawingML that reopens editable', async () => {
    const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    doc.replace('Text around a shape'); doc.select(5);
    const anchor = { horizontal: 'column', vertical: 'paragraph', x: 914400, y: 0, wrap: 'none', behind: true, order: 4 };
    const { image, asset } = buildShape({ id: 1, name: 'Hexagon 1', preset: 'hexagon', width: EMU_PER_INCH, height: EMU_PER_INCH / 2, fill: 'FF0000', line: null, lineWidth: 12700, anchor, assetId: 'drawing:canvas-shape-1' });
    doc.assets[image.assetId] = asset;
    const { assetId, id, ...properties } = image;
    doc.insertImage(assetId, properties);
    const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
    const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    const saved = reopened.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image))[0];
    expect(reopened.readOnly).toBeFalsy();
    expect(saved.anchor).toMatchObject({ horizontal: 'column', vertical: 'paragraph', x: 914400, y: 0, behind: true, order: 4 });
    expect(shapeParams(saved)).toEqual({ preset: 'hexagon', fill: 'FF0000', line: null, lineWidth: 12700 });
    expect(reopened.assets[saved.assetId].scene.fill).toBe('#FF0000');
  });
});

it('opens the independent preset geometry control for editing and keeps it byte-identical when unchanged', async () => {
  const bytes = readFileSync('public/fixtures/preset-geometries.docx');
  const pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  const images = pkg.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
  expect(images).toHaveLength(10);
  for (const image of images) expect(pkg.assets[image.assetId].scene.paths[0].points.length, image.name).toBeGreaterThan(4);
  const adjusted = pkg.assets[images.find(i => i.name === 'rightArrow 6').assetId].scene.paths[0].points;
  // adj1 = 60% shaft over a 1 in height, adj2 = 40% of the shorter side for the head.
  expect(adjusted[0]).toEqual(['M', 0, 914400 * 0.2]);
  expect(adjusted[1][1]).toBeCloseTo(1371600 - 914400 * 0.4, 3);
  expect(images.map(shapeParams).filter(Boolean).map(p => p.preset).sort()).toEqual(['diamond', 'leftArrow', 'leftRightArrow', 'pentagon']);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const { unzipSync } = await import('fflate');
  expect(unzipSync(new Uint8Array(await blob.arrayBuffer()))).toEqual(unzipSync(bytes));
});

it('keeps an outline\'s compound lines, cap and unset width when a shape is rewritten (resized)', () => {
  const base = { id: 3, name: 'Rectangle 3', preset: 'rect', width: 1371600, height: 914400, fill: 'FF0000', line: '000000', lineWidth: 38100, assetId: 'drawing:a' };
  const { image } = buildShape(base);
  const styled = { ...image, shell: image.shell.replace('<a:ln w="38100">', '<a:ln w="38100" cmpd="dbl" cap="rnd">') };
  const params = shapeParams(styled);
  expect(params.lineStyle).toEqual({ cmpd: 'dbl', cap: 'rnd' });
  // A resize rebuilds the shape from its parameters at the new size.
  const resized = buildShape({ ...base, ...params, width: base.width * 2, assetId: 'drawing:b' });
  expect(resized.image.shell).toMatch(/<a:ln w="38100" cmpd="dbl" cap="rnd">/);
  expect(resized.asset.scene.outline).toMatchObject({ compound: 'dbl', cap: 'rnd' });
  // A line without a width is drawn 0.75 pt wide, and stays so.
  expect(shapeParams({ ...image, shell: image.shell.replace('<a:ln w="38100">', '<a:ln>') }).lineWidth).toBe(9525);
});
