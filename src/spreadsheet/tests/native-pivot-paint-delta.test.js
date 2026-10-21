import { expect, it } from 'vitest';
import { nativePivotPaintDelta as delta } from '../src/core/native-pivot-paint-delta.js';
import { Workbook } from '../src/core/workbook.js';
import { styleToNumFmt, AUTOMATIC_FORMAT } from '../src/core/format.js';
import { writeNativePivotPaint } from '../src/core/native-pivot-paint-xml.js';
import { readNativePivotPaint } from '../src/core/native-pivot-paint.js';
import { normalizeNativeFill } from '../src/core/native-fill.js';
const fill = body => normalizeNativeFill({ key: 'test-fill', xml: `<fill xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</fill>` });

it('keeps XF fill ownership out of differential color and no-fill edits', () => {
  expect(delta({ nativeFill: fill('<patternFill patternType="solid"><fgColor rgb="FF123456"/></patternFill>'), bg: '#123456' }, ['bg', 'nativeFill']))
    .toEqual({ bg: '#123456' });
  expect(delta({ nativeFill: fill('<patternFill patternType="none"/>') }, ['bg', 'nativeFill'])).toEqual({ bg: 'transparent' });
  expect(delta({ nativeFill: null }, ['nativeFill'])).toEqual({});
});
it.each([
  '<patternFill patternType="darkTrellis"><fgColor theme="4"/></patternFill>',
  '<!-- patternType="none" --><gradientFill><stop position="0"><color theme="4"/></stop></gradientFill>',
])('refuses to flatten native fill geometry into a differential clear (%s)', body => {
  expect(() => delta({ nativeFill: fill(body) }, ['nativeFill'])).toThrow(/pattern\/gradient/);
});
it('retains edit provenance rather than persisting the flattened effective cell style', () => {
  const after = { bold: true, font: 'arial', size: 20, color: '#112233', bg: '#abcdef', fmt: 'currency', cur: 'EUR', dec: 3, wrap: true };
  expect(delta(after, ['bold'])).toEqual({ bold: true });
  expect(delta(after, ['bold', 'bold'])).toEqual({ bold: true });
  expect(delta(after, [])).toEqual({});
  expect(delta(after, ['dec'], { locale: 'en-US' })).toEqual({ fmt: 'custom', code: styleToNumFmt(after, 'en-US') });
});
it('encodes explicit resets and leaves unrelated properties absent', () => {
  expect(delta({}, ['bold', 'italic', 'underline', 'strike', 'wrap', 'bg', 'color', 'align', 'valign', 'indent', 'fmt']))
    .toEqual({ bold: false, italic: false, underline: false, strike: false, wrap: false, bg: 'transparent', color: 'windowtext', align: null, valign: 'middle', indent: 0, fmt: 'custom', code: 'General' });
});
it('requires real rendering defaults for font/size resets and accepts explicit inherited values', () => {
  expect(() => delta({}, ['font'])).toThrow(/default font/);
  expect(() => delta({}, ['size'])).toThrow(/default size/);
  expect(() => delta({ font: false }, ['font'], { defaultFont: 'arial' })).toThrow(/font/);
  expect(delta({ font: 'default', size: null }, ['font', 'size'], { defaultFont: 'font:Example Face', defaultSize: 17 }))
    .toEqual({ font: 'font:Example Face', size: 17 });
  expect(delta({ font: 'cambria', size: 22 }, ['font', 'size'], { defaultFont: 'arial', defaultSize: 13 })).toEqual({ font: 'cambria', size: 22 });
});
it.each([
  { fmt: 'number', dec: 4, group: false }, { fmt: 'currency', cur: 'JPY' }, { fmt: 'percent', dec: 1 },
  { fmt: 'date', dateStyle: 'long' }, { fmt: 'time', sec: true }, { fmt: 'datetime', dateStyle: 'medium', sec: true },
  { fmt: 'scientific', dec: 6 }, { fmt: 'text' }, { fmt: 'custom', code: '[Red]0.000" units"' }, {},
])('resolves the complete native number format for %j', style => {
  const out = delta(style, ['fmt'], { locale: 'de-DE' });
  expect(out).toEqual({ fmt: 'custom', code: styleToNumFmt(style, 'de-DE') });
  expect(readNativePivotPaint(writeNativePivotPaint(out, { numberFormatId: 180 }))).toEqual(out);
});
it('uses effective post-patch line inheritance for partial number formats and resets', () => {
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: { '2,3': { v: 12, s: { bold: true, dec: 2 } } } }] });
  const sheet = wb.sheets[0]; sheet.colStyles.set(3, { fmt: 'currency', cur: 'EUR', bold: true, wrap: true });
  const resolve = patch => delta({ ...wb._lineStyle(sheet, 2, 3), ...wb.patchedCellStyle(sheet.id, 2, 3, patch) }, Object.keys(patch), { locale: 'en-US' });
  expect(resolve({ dec: 4 })).toEqual({ fmt: 'custom', code: styleToNumFmt({ fmt: 'currency', cur: 'EUR', dec: 4 }, 'en-US') });
  expect(resolve({ bold: null, wrap: null })).toEqual({ bold: false, wrap: false });
  expect(resolve(AUTOMATIC_FORMAT)).toEqual({ fmt: 'custom', code: 'General' });
});
it('captures only affected border edges and resolves shared/per-edge pens', () => {
  const after = { bl: true, bt: true, br: false, bs: 'thick', bc: '#112233', btBorder: { bs: 'double', bc: null } };
  expect(delta(after, ['bl'])).toEqual({ bl: true, blBorder: { bs: 'thick', bc: '#112233' } });
  expect(delta(after, ['br'])).toEqual({ br: false });
  expect(delta(after, ['bc'])).toEqual({ bl: true, blBorder: { bs: 'thick', bc: '#112233' }, bt: true, btBorder: { bs: 'double', bc: null } });
  expect(delta({}, ['bc'])).toEqual({});
  expect(delta(after, ['btBorder'])).toEqual({ bt: true, btBorder: { bs: 'double', bc: null } });
});
it('owns its nested style values without modifying inputs', () => {
  const after = { color: { theme: 0, base: '#123456', rgb: '#123456' }, bl: true, blBorder: { bs: 'thin', bc: '#abcdef' } }, before = structuredClone(after);
  const out = delta(after, ['color', 'bl']); out.blBorder.bc = '#ffffff';
  expect(after).toEqual(before); expect(out.color).not.toBe(after.color);
});
it.each([
  [{ rot: 91 }, ['rot']], [{ clip: true }, ['clip']], [{}, ['unknown']], [{ bold: 'true' }, ['bold']],
  [{ size: 0 }, ['size']], [{ bg: '#abc' }, ['bg']], [{ indent: 251 }, ['indent']], [{ fmt: 'unknown' }, ['fmt']],
  [{ align: 'start' }, ['align']], [{ bl: 1 }, ['bl']], [{ bl: true, bs: 'wavy' }, ['bl']],
  [{ bl: true, blBorder: { bad: true } }, ['bl']], [{ fmt: 'custom', code: '0'.repeat(256) }, ['fmt']],
])('rejects unsupported or unresolved edits %j', (after, keys) => {
  const before = structuredClone(after); expect(() => delta(after, keys)).toThrow(); expect(after).toEqual(before);
});

it.each([undefined, null, false])('uses native default overflow when clipping is disabled (%s)', clip => {
  for (const wrap of [false, true]) {
    const paint = delta({ wrap, clip }, ['wrap', 'clip']); expect(paint).toEqual({ wrap });
    expect(readNativePivotPaint(writeNativePivotPaint(paint))).toEqual({ wrap });
  }
});
it.each([true, 0, 1, 'false'])('rejects active or malformed clipping (%s)', clip => {
  expect(() => delta({ wrap: true, clip }, ['wrap', 'clip'])).toThrow(/clipping/);
});

it('includes a changed family binding and writes explicit scheme resets', () => {
  expect(delta({ font: 'arial', scheme: 'none' }, ['font'])).toEqual({ font: 'arial', scheme: 'none' });
  expect(delta({ scheme: 'major' }, ['scheme'])).toEqual({ scheme: 'major' });
  expect(delta({}, ['scheme'])).toEqual({ scheme: 'none' });
  expect(() => delta({ scheme: 'invalid' }, ['scheme'])).toThrow(/font scheme/);
});
it('projects shrink to fit edits and keeps cell protection in the cell format', () => {
  expect(delta({ shrink: true, locked: false }, ['shrink'])).toEqual({ shrink: true });
  // An inherited shrink cleared by the edit is written as an explicit reset.
  expect(delta({}, ['shrink'])).toEqual({ shrink: false });
  // Protection is not report appearance: a replacement or clear naming it leaves it to the cell's XF.
  expect(delta({ locked: false, formulaHidden: true, bold: true }, ['locked', 'formulaHidden', 'bold'])).toEqual({ bold: true });
  expect(() => delta({ shrink: 'yes' }, ['shrink'])).toThrow(/shrink/);
});
