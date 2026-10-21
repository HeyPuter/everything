import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';
import { borderCss } from '../src/core/format.js';

afterEach(() => vi.unstubAllGlobals());

const KINDS = ['hair', 'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot', 'medium'];
// Cells A1:A8, each with a bottom border in one of Excel's line styles.
function excelFile() {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(KINDS.map(kind => [kind])), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  let borderBase, xfBase;
  edit('/xl/styles.xml', xml => xml
    .replace(/<borders count="(\d+)">([\s\S]*?)<\/borders>/, (_, count, body) => { borderBase = Number(count); return `<borders count="${borderBase + KINDS.length}">${body}${
      KINDS.map(kind => `<border><left/><right/><top/><bottom style="${kind}"><color rgb="FF1F4E79"/></bottom><diagonal/></border>`).join('')}</borders>`; })
    .replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (_, count, body) => { xfBase = Number(count); return `<cellXfs count="${xfBase + KINDS.length}">${body}${
      KINDS.map((_, i) => `<xf numFmtId="0" fontId="0" fillId="0" borderId="${borderBase + i}" xfId="0" applyBorder="1"/>`).join('')}</cellXfs>`; }));
  edit('/xl/worksheets/sheet1.xml', xml => xml.replace(/<c r="A(\d)"/g, (all, row) => `<c r="A${row}" s="${xfBase + Number(row) - 1}"`));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const bottoms = wb => KINDS.map((_, r) => { const s = wb.getCell(wb.activeSheetId, r, 0).s; return s?.bb ? (s.bbBorder || s).bs : null; });
const withoutAppRecord = zip => {
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
};

// Opening an Excel file turned every border line Excel draws other than thin, medium, thick, dashed, dotted and
// double into a thin solid line, so a hairline or a medium dashed rule showed as thin and saved back as thin.
it('opens Excel\'s hair, dash-dot and medium dashed borders and saves them as they were', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(), 'borders.xlsx');
  expect(bottoms(wb)).toEqual(KINDS);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const styles = new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content);
  for (const kind of KINDS) expect(styles).toContain(`<bottom style="${kind}"><color rgb="FF1F4E79"/></bottom>`);
  expect(bottoms(await workbookFromFile(withoutAppRecord(zip), 'again.xlsx'))).toEqual(KINDS);
});

it('draws each as the nearest line the screen has, medium weights two pixels wide', () => {
  expect(KINDS.map(bs => { const css = borderCss({ bs }); return `${css.width} ${css.style}`; })).toEqual([
    '1px dotted', '2px dashed', '1px dashed', '2px dashed', '1px dashed', '2px dashed', '2px dashed', '2px solid']);
});

it('saves them to an .ods file as the nearest line it holds', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(), 'borders.xlsx');
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), { type: 'array' }), 'content.xml').content);
  for (const line of ['0.74pt dotted #1f4e79', '1.76pt dashed #1f4e79', '0.74pt dashed #1f4e79', '1.76pt solid #1f4e79']) expect(content).toContain(`fo:border-bottom="${line}"`);
});
