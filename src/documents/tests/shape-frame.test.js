// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { carriedFrame } from '../src/engine/shape-editing.js';
import { shapeDrawingXml } from '../src/engine/authored-shapes.js';

const anchor = { horizontal: 'margin', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order: 2 };
// A centered shape with alt text, a title and a lock, as Word writes it.
const original = shapeDrawingXml({ id: 3, name: 'Logo', preset: 'rect', width: 914400, height: 914400, fill: '4472C4', line: '2F528F', lineWidth: 12700, anchor })
  .replace('<wp:posOffset>0</wp:posOffset></wp:positionH>', '<wp:align>center</wp:align></wp:positionH>')
  .replace('<wp:docPr id="3" name="Logo"/>', '<wp:docPr id="3" name="Logo" descr="Company logo" title="Logo"/>')
  .replace('<wp:cNvGraphicFramePr/>', '<wp:cNvGraphicFramePr><a:graphicFrameLocks noMove="1"/></wp:cNvGraphicFramePr>');

it('keeps a shape\'s alignment, alt text and locks when it is resized or recolored', () => {
  const rebuilt = shapeDrawingXml({ id: 3, name: 'Logo', preset: 'rect', width: 1828800, height: 914400, fill: 'FF0000', line: '2F528F', lineWidth: 12700, anchor });
  const xml = carriedFrame(original, rebuilt, new Set());
  expect(xml).toContain('<wp:align>center</wp:align>');
  expect(xml).toContain('descr="Company logo"');
  expect(xml).toContain('title="Logo"');
  expect(xml).toContain('noMove="1"');
  expect(xml).toContain('<wp:extent cx="1828800" cy="914400"/>');
  expect(xml).toContain('val="FF0000"');
});

it('takes the new position of an axis the edit moved', () => {
  const rebuilt = shapeDrawingXml({ id: 3, name: 'Logo', preset: 'rect', width: 914400, height: 914400, fill: '4472C4', line: '2F528F', lineWidth: 12700, anchor: { ...anchor, x: 457200 } });
  const xml = carriedFrame(original, rebuilt, new Set(['x']));
  expect(xml).not.toContain('<wp:align>center</wp:align>');
  expect(xml).toContain('<wp:posOffset>457200</wp:posOffset>');
  expect(xml).toContain('descr="Company logo"');
});
