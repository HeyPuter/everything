import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { describeDrawing } from '../src/engine/drawing-xml.js';
import { drawingKind, materializeDrawing, readFormattedDrawing, drawingParts } from '../src/engine/drawing-format.js';
import { setEffects } from '../src/engine/drawing-xml.js';

// An independently written package (tests/fixtures/pictures/make_fixture.py) opens editable, reads
// every Picture Format, Shape Format and Arrange feature it carries and saves them unchanged.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const bytes = readFileSync('tests/fixtures/pictures/pictures.docx');
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

it('reads pictures, wrapping, groups, text boxes, effects and hidden drawings', async () => {
  const pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  const [styled, layered, tight, group, notice, hidden] = images(pkg);
  expect([styled, layered, tight, group, notice, hidden].map(drawingKind)).toEqual(['picture', 'picture', 'picture', 'group', 'textBox', 'shape']);
  const a = describeDrawing(styled.shell);
  expect(a).toMatchObject({ description: 'A striped test picture', title: 'Stripes', outline: { width: 50800, color: { rgb: 'FFFFFF' } } });
  expect(a.blip).toMatchObject({ grayscale: true, alpha: 0.8, luminance: { brightness: 0.1, contrast: 0.2 } });
  expect(describeDrawing(layered.shell)).toMatchObject({ decorative: true, blip: { layer: { relId: 'rPhoto', effects: [{ name: 'saturation', attrs: { sat: '0' } }] } } });
  expect(tight.anchor).toMatchObject({ wrap: 'square', contour: 'tight', x: 3657600 });
  expect(describeDrawing(tight.shell).crop).toEqual({ left: 10000, top: 5000, right: 10000, bottom: 5000 });
  expect(group.anchor).toMatchObject({ horizontal: 'margin', xAlign: 'center' });
  const box = describeDrawing(notice.shell);
  expect(box.body).toMatchObject({ anchor: 'ctr' });
  expect(box.effects.glow).toMatchObject({ radius: 63500 });
  expect(box.effects.reflection).toMatchObject({ endPosition: 35000 });
  expect(box.effects.softEdge).toMatchObject({ radius: 12700 });
  expect(notice.anchor).toMatchObject({ wrap: 'square', wrapText: 'largest', distances: { R: 228600 } });
  expect(hidden.hidden).toBe(true);
  // Saving keeps every drawing's XML.
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const saved = unzipSync(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  const xml = strFromU8(saved['word/document.xml']);
  for (const pattern of [/<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon/, /a14:imgLayer r:embed="rPhoto"/, /<wpg:wgp>/, /<a:glow rad="63500">/, /hidden="1"/, /adec:decorative val="1"/]) expect(xml).toMatch(pattern);
  // A formatting edit on a fixture drawing reads back editable.
  const { drawing, parts } = materializeDrawing(pkg, doc, styled);
  setEffects(drawingParts(drawing).properties, { shadow: null, glow: { radius: 50800, color: 'FFC000', alpha: 0.5 } });
  const fragment = await readFormattedDrawing(pkg, doc, styled, drawing, parts);
  expect(describeDrawing(fragment.image.shell).effects).toMatchObject({ shadow: null, glow: { radius: 50800 } });
});
