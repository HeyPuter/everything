import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readSlicerPaint, resolveSlicerPaint, slicerGradientBackground } from '../src/core/slicer-paint.js';
import { applySlicerPaint, slicerStatePaint } from '../src/ui/slicer-paint.js';
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const dxf = body => `<dxf xmlns="${ns}">${body}</dxf>`;
const stops = '<stop position="0"><color rgb="FFFF0000"/></stop><stop position="1"><color rgb="FF0000FF"/></stop>';
const read = body => readSlicerPaint(dxf(body));
it('resolves differential fonts, mixed borders, clears and theme colors without changing source XML', () => {
  const xml = dxf('<font><b val="0"/><i/><strike val="false"/><u val="double"/><sz val="13.5"/><color theme="0"/></font><fill><patternFill patternType="none"/></fill><border><left/><right style="double"><color rgb="FF123456"/></right></border>');
  const style = { frame: { wholeTable: xml }, items: { selectedItemWithData: null } };
  const result = resolveSlicerPaint(style, { themeElements: { clrScheme: [{ rgb: '112233' }] } });
  expect(result.frame.wholeTable).toMatchObject({ bold: false, italic: true, strike: false, underline: 'double', size: 13.5, bg: 'transparent', bl: false, br: true, brBorder: { bs: 'double', bc: '#123456' }, color: { theme: 0, rgb: '#112233' } });
  expect(result.items.selectedItemWithData).toEqual({}); expect(style.frame.wholeTable).toBe(xml);
});
it.each([[0, 90], [90, 180], [180, 270], [270, 0], [-90, 0], [450, 180]])('converts native angle %s to CSS angle %s', (degree, css) => {
  const paint = read(`<fill><gradientFill degree="${degree}">${stops}</gradientFill></fill>`);
  expect(slicerGradientBackground(paint.gradient, 160, 25)).toBe(`linear-gradient(${css}deg, #ff0000 0%, #0000ff 100%)`);
});
it('retains path convergence geometry and renders rectangular sides rather than an elliptical approximation', () => {
  const paint = read(`<fill><gradientFill type="path" left="0.2" right="0.7" top="0.1" bottom="0.8">${stops}</gradientFill></fill>`);
  expect(paint.gradient).toMatchObject({ type: 'path', left: .2, right: .7, top: .1, bottom: .8 });
  const uri = slicerGradientBackground(paint.gradient, 200, 100);
  const svg = decodeURIComponent(uri.slice('url("data:image/svg+xml,'.length, -2));
  expect(svg).toContain('points="0,0 200,0 140,10 40,10"');
  expect(svg).toContain('x1="140" y1="0" x2="200" y2="0"');
  expect(svg).toContain('preserveAspectRatio="none"');
  expect(svg.match(/<polygon/g)).toHaveLength(4); expect(svg).not.toContain('radialGradient');
});
it('supports corner convergence, missing angle and duplicate stop offsets', () => {
  expect(read(`<fill><gradientFill>${stops}</gradientFill></fill>`).gradient.degree).toBe(0);
  const g = read(`<fill><gradientFill type="path">${stops}</gradientFill></fill>`).gradient;
  const svg = decodeURIComponent(slicerGradientBackground(g, 20, 10));
  expect(svg.match(/<polygon/g)).toHaveLength(2);
  expect(read(`<fill><gradientFill>${stops.replace('position="1"', 'position="0"')}</gradientFill></fill>`).gradient.stops).toHaveLength(2);
});
it('merges hover differences, honors fill clears and removes stale styles on transitions', () => {
  const node = new JSDOM().window.document.createElement('button');
  const base = read(`<font><b/><i/><sz val="14"/></font><fill><gradientFill>${stops}</gradientFill></fill><border><bottom style="double"/></border>`);
  const paints = { items: { selectedItemWithData: base, hoveredSelectedItemWithData: { bg: 'transparent', bold: false } } };
  const hovered = slicerStatePaint(paints, { selected: true, available: true, hovered: true });
  expect(hovered.gradient).toBeUndefined(); expect(hovered.italic).toBe(true);
  applySlicerPaint(node, hovered, 100, 20); expect(node.style.fontWeight).toBe('400'); expect(node.style.backgroundColor).toBe('transparent');
  applySlicerPaint(node, base, 100, 20); expect(node.style.backgroundImage).toContain('linear-gradient'); expect(node.style.backgroundSize).toBe('100% 100%'); expect(node.style.fontWeight).toBe('700');
  applySlicerPaint(node, {}, 100, 20); expect(node.style.backgroundImage).toBe(''); expect(node.style.backgroundSize).toBe(''); expect(node.style.fontStyle).toBe(''); expect(node.style.borderBottom).toBe('');
});
it.each([
  '<fill><gradientFill degree="NaN"/></fill>',
  `<fill><gradientFill>${stops.replace('position="0"', 'position="2"')}</gradientFill></fill>`,
  `<fill><gradientFill>${stops.replace('position="0"', 'position="1"').replace('position="1"><color rgb="FF0000FF"','position="0"><color rgb="FF0000FF"')}</gradientFill></fill>`,
  '<fill><gradientFill><stop position="0"><color theme="4"/></stop></gradientFill></fill>',
  `<fill><gradientFill type="path" left="0.8" right="0.2">${stops}</gradientFill></fill>`,
  '<font><b val="maybe"/></font>', '<font><sz val="infinite"/></font>',
])('rejects malformed or unresolved paint %s', body => { expect(() => read(body)).toThrow(/Invalid slicer paint/); });
it('does not invent unsupported patterns or unknown built-in definitions', () => {
  expect(() => read('<fill><patternFill patternType="darkGrid"/></fill>')).toThrow(/not implemented/);
  expect(() => resolveSlicerPaint({ name: 'SlicerStyleLight7', builtIn: true })).toThrow(/Unknown built-in slicer style/);
});

it('does not interpret a foreign namespace or extension as formatting', () => {
  expect(readSlicerPaint(`<dxf xmlns="${ns}" xmlns:x="urn:other"><x:font><x:b/><x:color rgb="FFFF0000"/></x:font><extLst><ext><font><b/></font></ext></extLst></dxf>`)).toEqual({});
});
it.each(['<border><left style="wavy"/></border>', '<font><outline/></font>', '<font><u val="singleAccounting"/></font>'])('explicitly rejects unimplemented paint %s', body => { expect(() => read(body)).toThrow(/not implemented/); });
