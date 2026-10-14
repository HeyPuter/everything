import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { DIAGRAM_LAYOUTS, DIAGRAM_COLORS, DEFAULT_OUTLINE, parseOutline, outlineText, diagramShapes, diagramDrawingXml, parseDiagramDescription } from '../src/engine/diagram-builder.js';
import { readDrawingFragment } from '../src/engine/inserted-drawings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

it('parses an indented outline and writes it back', () => {
  const items = parseOutline('Plan\n  Goals\n\t- Budget\nBuild\n• Ship');
  expect(items.map(i => i.text)).toEqual(['Plan', 'Build', 'Ship']);
  expect(items[0].children.map(i => i.text)).toEqual(['Goals', 'Budget']);
  expect(parseOutline(outlineText(items))).toEqual(items);
});

it('lays out every diagram inside its frame', () => {
  const items = parseOutline(DEFAULT_OUTLINE), width = 5486400, height = 2971800;
  for (const layout of DIAGRAM_LAYOUTS) {
    const shapes = diagramShapes(layout.id, items, { width, height });
    expect(shapes.filter(s => s.role === 'node').length, layout.id).toBeGreaterThan(0);
    for (const s of shapes) {
      expect(s.x, layout.id).toBeGreaterThanOrEqual(-1); expect(s.y, layout.id).toBeGreaterThanOrEqual(-1);
      expect(s.x + s.w, layout.id).toBeLessThanOrEqual(width + 2); expect(s.y + s.h, layout.id).toBeLessThanOrEqual(height + 2);
    }
  }
});

it('every layout and color set saves as a group of shapes that reopens editable and regenerates from its description', async () => {
  const items = parseOutline(DEFAULT_OUTLINE);
  for (const layout of DIAGRAM_LAYOUTS) for (const colors of [DIAGRAM_COLORS[0].id, 'colorful']) {
    const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const { image, assets } = await readDrawingFragment(diagramDrawingXml({ layout: layout.id, items, colors, id: 1 }), { sourceParts: pkg.parts, assetId: 'drawing:inserted-1' });
    Object.assign(doc.assets, assets);
    const { assetId, id, ...properties } = image;
    doc.insertImage(assetId, properties);
    const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
    const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    expect(reopened.readOnly, `${layout.id} ${colors}`).toBeFalsy();
    const saved = images(reopened)[0];
    expect(reopened.assets[saved.assetId].scene.type, layout.id).toBe('group');
    const parsed = parseDiagramDescription(saved.alt);
    expect(parsed, layout.id).toMatchObject({ layout: layout.id, colors });
    expect(parsed.items).toEqual(items);
  }
});
