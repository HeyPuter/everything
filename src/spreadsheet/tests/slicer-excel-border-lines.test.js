// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { readSlicerPaint, resolveSlicerPaint } from '../src/core/slicer-paint.js';
import { slicerPaintXml } from '../src/core/xlsx-export-slicer-styles.js';
import { normalizeSlicerFormat } from '../src/core/slicer-format.js';
import { applySlicerPaint } from '../src/ui/slicer-paint.js';
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const dxf = body => `<dxf xmlns="${ns}">${body}</dxf>`;

// Excel's hairline, dash-dot and medium dashed lines are kept in cells and drawn as the nearest line the screen has,
// but a slicer style that edged its buttons with one was refused, so the slicer opened in the default slicer style
// and saving the file wrote that style over the one it came with. Slicers now take every line a cell does.
it.each(['hair', 'dashDot', 'dashDotDot', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot'])('keeps a slicer style edged with %s', bs => {
  const xml = dxf(`<border><left style="${bs}"><color rgb="FF123456"/></left><bottom style="${bs}"><color auto="1"/></bottom></border>`);
  const paint = resolveSlicerPaint({ frame: {}, items: { selectedItemWithData: xml } }, {}).items.selectedItemWithData;
  expect(paint).toMatchObject({ bl: true, blBorder: { bs, bc: '#123456' }, bb: true, bbBorder: { bs } });
  const stored = normalizeSlicerFormat({ items: { selectedItemWithData: paint } }).items.selectedItemWithData;
  expect(readSlicerPaint(slicerPaintXml(stored))).toMatchObject({ blBorder: { bs, bc: '#123456' }, bbBorder: { bs } });
  const node = document.createElement('div');
  applySlicerPaint(node, stored, 160, 25);
  expect(node.style.borderLeft).toMatch(/(dotted|dashed)/);
});
