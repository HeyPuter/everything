import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import * as X from '../src/vendor/xlsx.mjs';
import { CELL_STYLES } from '../src/core/cellstyles.js';
import {
  normalizeCellStyles, stylePatch, styleFromPreset, styleFromCell, styleNameProblem, foldFormat, styleAsCell, partSummary,
  mergeStyleLists, clashingStyleNames,
} from '../src/core/custom-cell-styles.js';

const BRAND = {
  name: 'Brand total',
  parts: { number: true, alignment: false, font: true, border: true, fill: true, protection: false },
  style: { fmt: 'currency', dec: 2, bold: true, color: '#1f3b73', size: 16, bg: '#fff2cc', align: 'center' },
  borders: [{ side: 'bottom', style: 'double', color: '#4a8dff' }],
};

const bytesOf = async (wb) => new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
const part = (bytes, path) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), path).content);

describe('custom cell style definitions', () => {
  it('keeps only the included parts, unique names and known edges', () => {
    const [def] = normalizeCellStyles([BRAND, { ...BRAND, name: 'brand TOTAL' }, { name: '' }, null]);
    expect(def.style).toEqual({ fmt: 'currency', dec: 2, bold: true, color: '#1f3b73', size: 16, bg: '#fff2cc' }); // alignment is left out
    expect(def.borders).toEqual([{ side: 'bottom', style: 'double', color: '#4a8dff' }]);
    expect(normalizeCellStyles([BRAND, { ...BRAND, name: 'brand TOTAL' }])).toHaveLength(1);
  });

  it('applies only the included parts, resetting what the style leaves unset within them', () => {
    const { patch, borders } = stylePatch(normalizeCellStyles([BRAND])[0]);
    expect(patch).toMatchObject({ fmt: 'currency', dec: 2, bold: true, italic: null, bg: '#fff2cc', cellStyle: 'Brand total' });
    expect(patch).not.toHaveProperty('align');
    expect(patch).not.toHaveProperty('locked');
    expect(borders[0]).toEqual({ kind: 'none' });
    expect(borders).toContainEqual({ kind: 'bottom', style: 'double', color: '#4a8dff' });
    expect(borders).toContainEqual({ kind: 'horizontal', style: 'double', color: '#4a8dff' });
  });

  it('turns presets and cells into definitions, and folds a Format Cells result into a scratch style', () => {
    const heading = styleFromPreset(CELL_STYLES.find((s) => s.key === 'heading'));
    expect(heading.parts).toMatchObject({ font: true, border: true, fill: false, number: false });
    expect(heading.borders).toEqual([{ side: 'bottom', style: 'medium', color: '#4a8dff' }]);
    const normal = styleFromPreset(CELL_STYLES[0]);
    expect(Object.values(normal.parts).every(Boolean)).toBe(true);
    const fromCell = styleFromCell('Mine', { bold: true, bt: true, bs: 'thin', bc: '#000000', locked: false });
    expect(fromCell.style).toMatchObject({ bold: true, locked: false });
    expect(fromCell.borders).toEqual([{ side: 'top', style: 'thin', color: '#000000' }]);
    const folded = foldFormat(styleAsCell(fromCell), { patch: { bold: null, italic: true }, borders: [{ kind: 'outer', style: 'thick', color: null }] });
    expect(folded.bold).toBeUndefined();
    expect(folded.italic).toBe(true);
    expect(folded.bl && folded.br && folded.bt && folded.bb).toBe(true);
    expect(folded.blBorder).toEqual({ bs: 'thick', bc: null });
    expect(partSummary(normalizeCellStyles([BRAND])[0], 'number')).toBe('Currency, 2 decimal places');
    expect(partSummary(normalizeCellStyles([BRAND])[0], 'border')).toBe('Bottom double #4a8dff');
  });

  it('refuses empty, built-in and duplicate names', () => {
    const wb = new Workbook({ cellStyles: [BRAND] });
    expect(styleNameProblem(wb, '  ')).toMatch(/Enter a name/);
    expect(styleNameProblem(wb, 'heading')).toMatch(/built-in/);
    expect(styleNameProblem(wb, 'BRAND TOTAL')).toMatch(/already/);
    expect(styleNameProblem(wb, 'Brand total', 'Brand total')).toBeNull();
    expect(styleNameProblem(wb, 'Fresh')).toBeNull();
  });

  it('merges another list, keeping or replacing same-named styles', () => {
    const mine = normalizeCellStyles([BRAND]);
    const theirs = [{ ...BRAND, style: { bold: false } }, { name: 'Other', style: { italic: true } }];
    expect(clashingStyleNames(mine, theirs)).toEqual(['Brand total']);
    const kept = mergeStyleLists(mine, theirs);
    expect([kept.added, kept.replaced, kept.kept]).toEqual([1, 0, 1]);
    expect(kept.list[0].style.bold).toBe(true);
    const replaced = mergeStyleLists(mine, theirs, { replace: true });
    expect(replaced.list[0].style.bold).toBe(false);
  });
});

describe('workbook named styles', () => {
  it('records the list as an undo step and keeps it in drafts', () => {
    const wb = new Workbook();
    expect(wb.setCellStyles([BRAND], 'New cell style')).toBe(true);
    expect(wb.undoLabel()).toBe('New cell style');
    expect(new Workbook(wb.toJSON()).cellStyles.map((s) => s.name)).toEqual(['Brand total']);
    wb.undo();
    expect(wb.cellStyles).toEqual([]);
    wb.redo();
    expect(wb.cellStyles).toHaveLength(1);
  });

  it('round trips custom styles through .xlsx cellStyles and cellStyleXfs, with cells linked by xfId', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setCellStyles([BRAND, { name: 'Quiet', parts: { number: false, alignment: false, font: true, border: false, fill: false, protection: true }, style: { italic: true, locked: false } }]);
    wb.setInput(id, 0, 0, '12.5');
    const { patch } = stylePatch(wb.cellStyles[0]);
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, patch);
    const bytes = await bytesOf(wb);
    const styles = part(bytes, '/xl/styles.xml');
    expect(styles).toMatch(/<cellStyle name="Brand total" xfId="1"\/>/);
    expect(styles).toMatch(/<cellStyle name="Quiet" xfId="2"\/>/);
    expect(styles).toMatch(/<cellStyle name="Normal" xfId="0" builtinId="0"\/>/);
    const styleXfs = styles.match(/<cellStyleXfs\b[\s\S]*?<\/cellStyleXfs>/)[0];
    expect(styleXfs).toMatch(/count="3"/);
    expect(styleXfs).toMatch(/applyAlignment="0"/);
    // The cell's format points at its named style.
    const sheet = part(bytes, '/xl/worksheets/sheet1.xml');
    const xfIndex = Number(sheet.match(/<c r="A1"[^>]*\ss="(\d+)"/)[1]);
    const cellXfs = [...styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)[0].matchAll(/<xf\b[^>]*>/g)].map((m) => m[0]);
    expect(cellXfs[xfIndex]).toMatch(/xfId="1"/);

    // Back in this app: the sidecar holds the list exactly.
    const back = await workbookFromFile(bytes, 'b.xlsx');
    expect(back.cellStyles).toEqual(wb.cellStyles);
    expect(back.getCell(back.activeSheetId, 0, 0).s.cellStyle).toBe('Brand total');

    // From the file alone (another program's custom styles): the native records are read.
    // The app's record is a hidden sheet; renamed, the reader no longer takes it for one.
    const zip = X.CFB.read(bytes, { type: 'array' });
    const book = part(bytes, '/xl/workbook.xml').replace(/name="_puter_meta"/, 'name="Elsewhere"');
    X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(book));
    const nativeOnly = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'n.xlsx');
    const brand = nativeOnly.cellStyles.find((s) => s.name === 'Brand total');
    expect(brand.parts).toEqual(BRAND.parts);
    expect(brand.style).toMatchObject({ bold: true, color: '#1f3b73', bg: '#fff2cc', fmt: 'currency' });
    expect(brand.borders).toEqual([{ side: 'bottom', style: 'double', color: '#4a8dff' }]);
    const quiet = nativeOnly.cellStyles.find((s) => s.name === 'Quiet');
    expect(quiet.style).toMatchObject({ italic: true, locked: false });
    expect(nativeOnly.getCell(nativeOnly.activeSheetId, 0, 0).s.cellStyle).toBe('Brand total');
  });
});
