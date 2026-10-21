import { expect, it } from 'vitest';
import { writeNativePivotPaint as write } from '../src/core/native-pivot-paint-xml.js';
import { readNativePivotPaint as read, nativePivotPaintLayers, nativePivotPaintAt } from '../src/core/native-pivot-paint.js';
import { parseModelXml } from '../src/core/data-model-metadata.js';
const names = node => Array.from(node.childNodes).filter(n => n.nodeType === 1).map(n => n.localName);

it('writes only supplied properties, including explicit emphasis, fill and alignment resets', () => {
  const style = { bold: false, italic: true, underline: false, strike: false, bg: 'transparent', align: null, wrap: false, indent: 0 };
  expect(read(write(style))).toEqual(style);
  expect(names(parseModelXml(write({ bold: true })))).toEqual(['font']);
  expect(names(parseModelXml(write({})))).toEqual([]);
  expect(read(write({ valign: 'middle' }))).toEqual({ valign: 'middle' });
});
it('writes point sizes and protects literal ST_Xstring escape sequences in names and format codes', () => {
  const style = { font: 'font:Face _x0041_ & Co', size: 21.5, fmt: 'custom', code: '0.00" _x0042_ & units"' };
  const xml = write(style, { numberFormatId: 180 });
  expect(xml).toContain('_x005F_x0041_'); expect(xml).toContain('_x005F_x0042_'); expect(xml).toContain('&amp;');
  expect(read(xml)).toEqual(style);
});
it('keeps matching palette references and converts foreign palette references to source RGB', () => {
  const color = { theme: 0, base: '#123456', rgb: '#123456' };
  const xml = write({ color }, { palette: { theme: ['#123456'] } });
  expect(xml).toContain('theme="0"');
  expect(read(xml, { themeElements: { clrScheme: [{ rgb: '123456' }] } }).color).toMatchObject(color);
  expect(read(write({ color }, { palette: { theme: ['#ffffff'] } })).color).toBe('#123456');
  expect(read(write({ color: null })).color).toBe('windowtext');
});
it.each(['theme', 'indexed'])('retains %s pivot fill references and resolves foreign palettes to source paint', key => {
  const bg = { [key]: 4, base: '#286844', rgb: '#286844' };
  const palette = { [key]: [null, null, null, null, '#286844'] };
  const themes = key === 'theme'
    ? { themeElements: { clrScheme: [null, null, null, null, { rgb: '286844' }] } }
    : { indexedColors: [null, null, null, null, '286844'] };
  const xml = write({ bg }, { palette });
  expect(xml).toContain(`<bgColor ${key}="4"/>`);
  expect(read(xml, themes).bg).toEqual(bg);
  expect(read(write({ bg }, { palette: { [key]: [null, null, null, null, '#aabbcc'] } })).bg).toBe('#286844');
});
it('preserves per-edge pens and explicit clears in SpreadsheetML child order', () => {
  const style = { bold: true, size: 16, color: '#112233', font: 'calibri', fmt: 'custom', code: '0%', bg: '#abcdef',
    align: 'right', valign: 'top', wrap: true, indent: 3, bl: true, blBorder: { bs: 'thick', bc: '#102030' },
    br: false, bt: true, btBorder: { bs: 'double', bc: null }, bb: false, bv: false, bh: true, bhBorder: { bs: 'dashed', bc: '#aabbcc' } };
  const root = parseModelXml(write(style, { numberFormatId: 181 }));
  expect(names(root)).toEqual(['font', 'numFmt', 'fill', 'alignment', 'border']);
  expect(names(root.firstChild)).toEqual(['b', 'sz', 'color', 'name']);
  expect(names(root.lastChild)).toEqual(['left', 'right', 'top', 'bottom', 'vertical', 'horizontal']);
  const layers = nativePivotPaintLayers([{ range: { r1: 3, c1: 2, r2: 5, c2: 4 }, dxf: write(style, { numberFormatId: 181 }) }]);
  expect(nativePivotPaintAt(layers, 3, 2)).toMatchObject({ blBorder: { bs: 'thick', bc: '#102030' }, btBorder: { bs: 'double', bc: null }, bbBorder: { bs: 'dashed', bc: '#aabbcc' }, br: false, size: 16, indent: 3 });
});
it.each([
  { bold: null }, { italic: 1 }, { size: 0 }, { size: 546 }, { size: Infinity }, { font: null },
  { color: undefined }, { color: '#abc' }, { bg: '#abcd' }, { bg: null }, { align: 'general' }, { valign: 'justify' },
  { wrap: 1 }, { indent: 251 }, { indent: -1 }, { indent: 0.5 }, { rot: 91 }, { unknown: true },
  { fmt: 'currency' }, { code: '0' }, { fmt: 'custom', code: 42 },
  { bs: 'thin' }, { blBorder: { bs: 'thin' } }, { bl: false, blBorder: { bs: 'thin' } },
  { bl: true, bs: 'wavy' }, { bl: true, blBorder: { future: true } }, { bl: true, bc: '#abc' }, { bh: 'true' },
])('rejects unresolved or unrepresentable paint %j without modifying it', style => {
  const before = structuredClone(style); expect(() => write(style)).toThrow(); expect(style).toEqual(before);
});
it.each([null, -1, 1.5, 4294967296])('requires a valid workbook-local number format id (%s)', numberFormatId => {
  expect(() => write({ fmt: 'custom', code: 'General' }, { numberFormatId })).toThrow(/format id/);
});

it.each([true, false])('round trips explicit border outline=%s', borderOutline => {
  const style = { borderOutline, bt: true, btBorder: { bs: 'thin', bc: '#123456' }, bb: false };
  const xml = write(style); expect(xml).toContain(`outline="${borderOutline ? 1 : 0}"`);
  expect(read(xml)).toMatchObject(style);
  const layers = nativePivotPaintLayers([{ range: { r1: 1, r2: 3, c1: 1, c2: 3 }, dxf: xml }]);
  expect(nativePivotPaintAt(layers, 2, 2).bt).toBe(borderOutline ? undefined : true);
  expect(nativePivotPaintAt(layers, 2, 2).bb).toBe(borderOutline ? undefined : false);
});
it.each([{ borderOutline: 0 }, { borderOutline: false, bh: true }, { borderOutline: false, bv: false }])('rejects invalid or unresolved border modes %j', style => {
  expect(() => write(style)).toThrow(/border/);
});

it('round-trips theme bindings and explicit clears in differential pivot fonts', () => {
  const fontTheme = { major: { latin: { typeface: 'Georgia' } }, minor: { latin: { typeface: 'Courier New' } } };
  for (const [scheme, font] of [['major', 'georgia'], ['minor', 'courier'], ['none', 'arial']]) {
    const xml = write({ font: 'arial', scheme });
    expect(read(xml, { fontTheme })).toEqual({ font, scheme });
  }
  expect(() => write({ scheme: 'invalid' })).toThrow(/font scheme/);
  expect(() => read(write({ scheme: 'minor' }).replace('minor', 'invalid'))).toThrow(/font scheme/);
});
it('writes and reads shrink to fit as an explicit alignment setting or reset', () => {
  for (const shrink of [true, false]) {
    const xml = write({ shrink, wrap: false });
    expect(xml).toContain(`shrinkToFit="${shrink ? 1 : 0}"`);
    expect(read(xml)).toEqual({ shrink, wrap: false });
  }
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  expect(read(`<dxf xmlns="${ns}"><alignment shrinkToFit="true"/></dxf>`)).toEqual({ shrink: true });
  expect(() => read(`<dxf xmlns="${ns}"><alignment shrinkToFit="yes"/></dxf>`)).toThrow(/shrink to fit/);
  expect(() => write({ shrink: 1 })).toThrow(/shrink to fit/);
});
it('layers shrink to fit like other alignment settings', () => {
  const layers = nativePivotPaintLayers([
    { range: { r1: 0, c1: 0, r2: 1, c2: 1 }, dxf: write({ shrink: true }) },
    { range: { r1: 1, c1: 1, r2: 1, c2: 1 }, dxf: write({ shrink: false }) },
  ]);
  expect(nativePivotPaintAt(layers, 0, 0)).toMatchObject({ shrink: true });
  expect(nativePivotPaintAt(layers, 1, 1)).toMatchObject({ shrink: false });
});
