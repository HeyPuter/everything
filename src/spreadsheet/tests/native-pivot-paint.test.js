import { expect, it } from 'vitest';
import { readNativePivotPaint, nativePivotPaintLayers, nativePivotPaintAt, nativePivotCellNumberFormat as resolve } from '../src/core/native-pivot-paint.js';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const dxf = body => `<dxf xmlns="${MAIN}">${body}</dxf>`;
const range = { r1: 4, c1: 2, r2: 8, c2: 5 };
const compile = body => nativePivotPaintLayers([{ range, dxf: dxf(body), type: 'wholeTable' }]);
it('distinguishes inside edges, perimeter edges and explicit clears', () => {
  const layers = compile('<border><left/><right style="double"><color rgb="FF112233"/></right><top style="thick"/><bottom/><horizontal style="thin"><color rgb="FF556677"/></horizontal><vertical/></border>');
  expect(nativePivotPaintAt(layers, 4, 2)).toMatchObject({ bl: false, bt: true, btBorder: { bs: 'thick', bc: null }, bb: true, bbBorder: { bs: 'thin', bc: '#556677' }, br: false });
  expect(nativePivotPaintAt(layers, 6, 4)).toMatchObject({ bt: true, bb: true, bl: false, br: false });
  expect(nativePivotPaintAt(layers, 8, 5)).toMatchObject({ bb: false, br: true, brBorder: { bs: 'double', bc: '#112233' } });
});
it('preserves layer order even when the spatial index visits regions in another order', () => {
  const layers = nativePivotPaintLayers([
    { range, dxf: dxf('<font><b/><i/><strike/></font><border><top style="thick"/><horizontal style="thin"/></border>') },
    { range: { ...range, r2: 4 }, dxf: dxf('<font><b val="0"/><i val="0"/></font><border><top/><bottom/></border>') },
  ]);
  expect(nativePivotPaintAt(layers, 4, 3)).toMatchObject({ bold: false, italic: false, strike: true, bt: false, bb: false });
  expect(nativePivotPaintAt(layers, 5, 3)).toMatchObject({ bold: true, italic: true, bt: true, btBorder: { bs: 'thin' } });
});
it('separates inherited base formatting from explicit direct overrides', () => {
  const layers = compile('<font><b val="0"/><i val="0"/></font><fill><patternFill patternType="none"/></fill>');
  const base = { bold: true, italic: true, bg: '#abcdef', valign: 'middle', fmt: 'custom', code: '0.00' };
  const result = nativePivotPaintAt(layers, 6, 3, { base, direct: { bg: '#123456', bold: true } });
  expect(result).toEqual({ bold: true, italic: false, bg: '#123456', valign: 'middle', fmt: 'custom', code: '0.00' });
  expect(base.italic).toBe(true);
});
it('does not share mutable pens with inputs, compiled layers or returned cell styles', () => {
  const layers = compile('<border><horizontal style="thin"><color rgb="FF123456"/></horizontal></border>');
  const first = nativePivotPaintAt(layers, 6, 3); first.btBorder.bc = '#ffffff';
  expect(nativePivotPaintAt(layers, 6, 3).btBorder.bc).toBe('#123456');
  expect(Object.isFrozen(layers)).toBe(true); expect(Object.isFrozen(layers[0].style.bhBorder)).toBe(true);
});
it('decodes number formats and retains explicit false emphasis', () => {
  const paint = readNativePivotPaint(dxf('<font><b val="false"/><strike val="0"/><u val="none"/></font><numFmt numFmtId="190" formatCode="0.00&quot; units&quot;"/>'));
  expect(paint).toMatchObject({ bold: false, strike: false, underline: false, fmt: 'custom', code: '0.00" units"' });
  expect(readNativePivotPaint(dxf('<numFmt numFmtId="+190"/>'), null, { numberFormats: { 190: '0%' } }).code).toBe('0%');
  expect(() => readNativePivotPaint(dxf('<numFmt numFmtId="191"/>'))).toThrow(/number format/);
});
it('retains theme font identity and resolves border tint without reading comments as paint', () => {
  const themes = { themeElements: { clrScheme: [{ rgb: '123456' }] } };
  const paint = readNativePivotPaint(dxf('<!-- <font><b/><color rgb="FFFF0000"/></font> --><font><color theme="0"/></font><border><top style="thin"><color theme="0" tint="0.5"/></top></border>'), themes);
  expect(paint.color).toMatchObject({ theme: 0, rgb: '#123456' }); expect(paint).not.toHaveProperty('bold');
  expect(paint.btBorder.bc).not.toBe('#123456');
});
it.each([
  '<fill><gradientFill/></fill>', '<font><shadow/></font>', '<font><u val="wavy"/></font>',
  '<alignment horizontal="start"/>', '<border><left style="wavy"/></border>', '<border diagonalUp="1"/>',
  '<border outline="0"><horizontal/></border>', '<extLst/>', '<font><other xmlns="urn:extension"/></font>',
])('refuses unimplemented differential effects %s', body => {
  expect(() => readNativePivotPaint(dxf(body))).toThrow(/not implemented/);
});
it('rejects unresolved paint and malformed or off-grid coordinates', () => {
  expect(() => readNativePivotPaint(dxf('<font><color theme="9"/></font>'))).toThrow(/color/);
  expect(() => readNativePivotPaint(dxf('<fill><patternFill patternType="solid"><bgColor theme="9"/></patternFill></fill>'))).toThrow(/color/);
  expect(() => nativePivotPaintLayers([{ range: { ...range, r2: 1048576 }, dxf: dxf('') }])).toThrow(/bounds/);
  expect(() => nativePivotPaintAt([], -1, 0)).toThrow(/coordinates/);
});
it('stays sparse for whole-sheet layers and reuses identical decoded formats', () => {
  const layers = nativePivotPaintLayers([{ range: { r1: 0, c1: 0, r2: 1048575, c2: 16383 }, dxf: dxf('<font><b/></font>') }, { range, dxf: dxf('<font><b/></font>') }]);
  expect(layers).toHaveLength(2); expect(layers[0].style).toBe(layers[1].style);
  expect(nativePivotPaintAt(layers, 1048575, 16383)).toEqual({ bold: true });
  expect(nativePivotPaintAt([], 0, 0, { base: { bg: '#123456' } })).toEqual({ bg: '#123456' });
});

it('captures base and direct edge pens independently of later layers global stroke settings', () => {
  const layers = compile('<border><bottom style="thick"><color rgb="FF0000FF"/></bottom></border>');
  const base = { bt: true, bs: 'medium', bc: '#ff0000' };
  const paint = nativePivotPaintAt(layers, 8, 3, { base, direct: { bb: true, bs: 'dashed', bc: '#00ff00' } });
  expect(paint.btBorder).toEqual({ bs: 'medium', bc: '#ff0000' });
  expect(paint.bbBorder).toEqual({ bs: 'dashed', bc: '#00ff00' });
  expect(nativePivotPaintAt(layers, 8, 3, { base, direct: { bt: false } }).btBorder).toBeNull();
});

it('resolves measure and member formats by identity, including explicit General', () => {
  const layout = { measures: [{ numFmtId: 180 }, { numFmtId: 0 }, {}], fields: [{ numFmtId: 181 }] };
  const codes = { 180: '0.00%', 181: '0000' };
  expect(resolve(layout, { role: 'value', measure: 0 }, codes)).toEqual({ fmt: 'custom', code: '0.00%' });
  expect(resolve(layout, { role: 'value', measure: 1 }, codes)).toEqual({ fmt: 'custom', code: 'General' });
  expect(resolve(layout, { role: 'value', measure: 2 }, codes)).toBeNull();
  expect(resolve(layout, { role: 'member', field: 0 }, codes)).toEqual({ fmt: 'custom', code: '0000' });
  for (const role of ['rowHeader', 'measureHeader', 'subtotal', 'grand']) expect(resolve(layout, { role, field: 0, measure: 0 }, codes)).toBeNull();
});
it('rejects missing format owners and unresolved or invalid format identifiers', () => {
  expect(() => resolve({ measures: [], fields: [] }, { role: 'value', measure: 0 })).toThrow(/owner/);
  for (const numFmtId of [-1, 1.5, 4294967296]) expect(() => resolve({ measures: [{ numFmtId }] }, { role: 'value', measure: 0 })).toThrow(/format id/);
  expect(() => resolve({ fields: [{ numFmtId: 199 }] }, { role: 'member', field: 0 }, Object.create({ 199: '0%' }))).toThrow(/unresolved/);
});
it('applies refresh number formats after old direct cell formats while keeping other direct properties', () => {
  const layers = compile('<numFmt numFmtId="190" formatCode="0.00%"/>');
  const direct = { fmt: 'currency', code: '0.0', bg: '#abc123' };
  expect(nativePivotPaintAt(layers, 5, 3, { direct, numberFormat: { fmt: 'custom', code: 'General' } }))
    .toMatchObject({ fmt: 'custom', code: 'General', bg: '#abc123' });
  expect(nativePivotPaintAt(layers, 5, 3, { direct })).toMatchObject(direct);
});

it('decodes point sizes and incremental alignment without inventing omitted defaults', () => {
  expect(readNativePivotPaint(dxf('<font><sz val="10.5"/></font><alignment horizontal="right" vertical="center" wrapText="true" indent="+2"/>')))
    .toEqual({ size: 14, align: 'right', valign: 'middle', wrap: true, indent: 2 });
  expect(readNativePivotPaint(dxf('<alignment/>'))).toEqual({});
  expect(readNativePivotPaint(dxf('<font><sz val="1.2e1"/></font>'))).toEqual({ size: 16 });
  expect(readNativePivotPaint(dxf('<alignment wrapText="false"/>'))).toEqual({ wrap: false });
});
it('applies explicit alignment resets in DXF order while keeping omitted base properties', () => {
  const layers = nativePivotPaintLayers([
    { range, dxf: dxf('<font><sz val="15"/></font><alignment horizontal="right" vertical="top" wrapText="1" indent="3"/>') },
    { range, dxf: dxf('<alignment horizontal="general" wrapText="0" indent="0"/>') },
  ]);
  const base = { align: 'left', valign: 'bottom', wrap: true, indent: 5, size: 12, italic: true };
  expect(nativePivotPaintAt(layers, 5, 3, { base })).toEqual({ align: null, valign: 'top', wrap: false, indent: 0, size: 20, italic: true });
  expect(base).toEqual({ align: 'left', valign: 'bottom', wrap: true, indent: 5, size: 12, italic: true });
});
it.each(['', '0', '-1', '410', 'Infinity', 'NaN', '0x10', '1e999'])('rejects unrepresentable native font size %s', size => {
  expect(() => readNativePivotPaint(dxf(`<font><sz val="${size}"/></font>`))).toThrow(/font size/);
});
it.each([
  '<font><sz/></font>', '<font><sz val="11"/><sz val="12"/></font>',
  '<alignment wrapText="yes"/>', '<alignment indent="-1"/>', '<alignment indent="251"/>', '<alignment indent="1.5"/>',
  '<alignment/><alignment/>',
])('rejects malformed typography %s', body => { expect(() => readNativePivotPaint(dxf(body))).toThrow(); });
it.each([
  '<alignment horizontal="start"/>', '<alignment vertical="distributed"/>', '<alignment relativeIndent="1"/>',
  '<alignment textRotation="255"/>', '<alignment readingOrder="2"/>',
  '<alignment xmlns:q="urn:future" q:wrapText="1"/>', '<alignment><extLst/></alignment>',
])('does not approximate unsupported alignment %s', body => { expect(() => readNativePivotPaint(dxf(body))).toThrow(/not implemented/); });

it.each(['0', 'false'])('applies repeated native borders at every cell when outline=%s', outline => {
  const layers = compile(`<border outline="${outline}"><left/><right style="double"><color rgb="FF112233"/></right><top style="thick"/></border>`);
  for (const [r, c] of [[4, 2], [6, 4], [8, 5]]) expect(nativePivotPaintAt(layers, r, c)).toMatchObject({ bl: false, br: true, brBorder: { bs: 'double', bc: '#112233' }, bt: true, btBorder: { bs: 'thick', bc: null } });
  expect(nativePivotPaintAt(layers, 6, 4).bb).toBeUndefined();
});
it.each(['1', 'true'])('keeps explicit outline=%s borders on the perimeter', outline => {
  const layers = compile(`<border outline="${outline}"><top style="thin"/><left style="double"/></border>`);
  expect(nativePivotPaintAt(layers, 6, 4).bt).toBeUndefined(); expect(nativePivotPaintAt(layers, 6, 4).bl).toBeUndefined();
  expect(nativePivotPaintAt(layers, 4, 2)).toMatchObject({ bt: true, bl: true });
});
it.each(['yes', '2', ''])('rejects malformed border outline=%s', outline => {
  expect(() => readNativePivotPaint(dxf(`<border outline="${outline}"/>`))).toThrow(/outline/);
});
