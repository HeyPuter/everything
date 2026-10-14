import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureFragment, fittedSize } from '../src/engine/picture-insert.js';
import { iconSvg, ICONS } from '../src/lib/icon-library.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const png = new Uint8Array(readFileSync('icon-128.png'));
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

it('inserts an SVG icon with a PNG fallback that saves both media parts and reopens editable', async () => {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.replace('Icon: ');
  const fragment = await pictureFragment(doc, pkg.parts, { png, svg: iconSvg(ICONS[0].id, { color: '#C00000' }), width: 914400, height: 914400, id: 1, name: 'Icon 1', descr: ICONS[0].name });
  Object.assign(doc.assets, fragment.assets);
  const { assetId, id, ...properties } = fragment.image;
  doc.insertImage(assetId, properties);
  const bytes = new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
  const parts = unzipSync(bytes);
  const media = Object.keys(parts).filter(p => p.startsWith('word/media/'));
  expect(media.map(p => p.split('.').pop()).sort()).toEqual(['png', 'svg']);
  const rels = strFromU8(parts['word/_rels/document.xml.rels']);
  for (const path of media) expect(rels).toContain(path.replace('word/', ''));
  expect(strFromU8(parts['[Content_Types].xml'])).toMatch(/image\/svg\+xml/);
  expect(strFromU8(parts['word/document.xml'])).toMatch(/asvg:svgBlip|svgBlip/);
  const reopened = await DocxPackage.open(bytes);
  expect(reopened.readOnly).toBeFalsy();
  const saved = images(reopened)[0];
  expect(saved.alt).toBe(ICONS[0].name);
  expect(reopened.assets[saved.assetId].mime).toBe('image/svg+xml');
  expect(reopened.assets[saved.fallbackAssetId].mime).toBe('image/png');
  // Deleting the picture (as undo of the insertion does) leaves no media behind.
  doc.select(0, doc.text.length); doc.replace('No picture');
  const plain = unzipSync(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  expect(Object.keys(plain).filter(p => p.startsWith('word/media/'))).toEqual([]);
});

it('fits pictures into the text column', () => {
  expect(fittedSize(96, 48)).toEqual([914400, 457200]);
  const [w, h] = fittedSize(4000, 2000);
  expect(w).toBe(Math.round(6.5 * 914400)); expect(h).toBe(Math.round(3.25 * 914400));
});
