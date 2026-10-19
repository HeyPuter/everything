import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Excel's Date and Text length rules came in as Formula rules (IF(ISNUMBER(A1),AND(A1>=(45292),...))),
// so the validation dialog showed a formula instead of the dates, and the next save gave Excel a Custom
// rule in place of its own. They now open as this app's Date and Text length rules, and a save writes
// Excel's native rule again wherever both mean the same.
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const rule = (type, operator, first, second = '') => `<dataValidation type="${type}" operator="${operator}" allowBlank="1" showErrorMessage="1" sqref="A1:A3"><formula1>${escape(first)}</formula1>${second === '' ? '' : `<formula2>${escape(second)}</formula2>`}</dataValidation>`;
async function open(xmlRule) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[0]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const entry = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  entry.content = new TextEncoder().encode(new TextDecoder().decode(entry.content).replace('</worksheet>', () => `<dataValidations count="1">${xmlRule}</dataValidations></worksheet>`));
  entry.size = entry.content.length;
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx');
}
const sheetXml = async (wb) => new TextDecoder().decode(X.CFB.find(X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' }), '/xl/worksheets/sheet1.xml').content);

it.each([
  ['date', 'between', '45292', '45657', { type: 'date', min: 45292, max: 45657 }, 45300, 45700],
  ['date', 'greaterThan', '45292', '', { type: 'date', min: 45292, operator: 'greaterThan' }, 45293, 45292],
  ['date', 'greaterThanOrEqual', '45292', '', { type: 'date', min: 45292, operator: 'greaterThanOrEqual' }, 45292, 45291],
  ['textLength', 'between', '2', '5', { type: 'text', min: 2, max: 5 }, 'abc', 'abcdef'],
  ['textLength', 'lessThanOrEqual', '10', '', { type: 'text', min: 10, operator: 'lessThanOrEqual' }, 'short', 'much too long'],
  ['textLength', 'notBetween', '2', '5', { type: 'text', min: 2, max: 5, operator: 'notBetween' }, 'a', 'abc'],
])('opens a native %s %s rule as its own type and saves it natively again', async (type, operator, first, second, expected, good, bad) => {
  const wb = await open(rule(type, operator, first, second));
  const id = wb.activeSheetId;
  expect(wb.activeSheet.validations[0]).toMatchObject(expected);
  expect(wb.validateValue(id, 0, 0, good).ok).toBe(true);
  expect(wb.validateValue(id, 0, 0, bad).ok).toBe(false);
  if (type === 'date') expect(wb.validateValue(id, 0, 0, 'text').ok).toBe(false);
  const xml = await sheetXml(wb);
  const saved = xml.match(/<dataValidation [^>]*>/)[0];
  expect(saved).toContain(`type="${type}"`);
  expect(saved).toContain(`operator="${operator === 'between' && type === 'date' ? 'between' : operator}"`);
  expect(xml).toContain(`<formula1>${first}</formula1>`);
});

it('keeps a date comparison that a negative number could pass as a formula', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', validations: [{ range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'date', min: 45292, operator: 'lessThan', strict: true }] }] });
  const xml = await sheetXml(wb);
  expect(xml).toMatch(/<dataValidation type="custom"/);
  expect(xml).toContain('&gt;=0');
});
