// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { expandPrintText, marginBoxContent, printFolder, buildPrintRoot } from '../src/ui/print.js';
import { sectionStoredText, HEADER_ELEMENTS } from '../src/ui/page-layout.js';
import { Workbook } from '../src/core/workbook.js';

// Page Layout's Header & Footer ▸ File Path puts &[Path]&[File] in a section, stored as Excel's &Z&F. The print
// read &F alone, so the footer came out as "&ZBudget".
it('prints the folder for &Z and &[Path], as Excel prints the file path', () => {
  const stored = sectionStoredText(HEADER_ELEMENTS.find(([name]) => name === 'File Path')[1]);
  expect(stored).toBe('&Z&F');
  const info = { file: 'Budget', path: '/alice/Documents/' };
  expect(expandPrintText(stored, info)).toBe('/alice/Documents/Budget');
  expect(expandPrintText('&[Path]&[File]', info)).toBe('/alice/Documents/Budget');
  expect(marginBoxContent(stored, info)).toBe('"/alice/Documents/" "Budget"');
  // A spreadsheet not saved yet has no folder: the code prints nothing rather than itself.
  expect(expandPrintText(stored, { file: 'Untitled' })).toBe('Untitled');
  expect(expandPrintText('&&Z', info)).toBe('&Z');
});

it('names the folder of a saved file, and none for a file without an address', () => {
  expect(printFolder('/alice/Documents/Budget.xlsx')).toBe('/alice/Documents/');
  expect(printFolder(null)).toBe('');
  expect(printFolder('Spreadsheets/Budget.xlsx')).toBe('');
});

it('puts the folder in the printed footer', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'x');
  wb.setPrintSettings(id, { footer: '&L&Z&F' });
  const root = buildPrintRoot(wb, id, 'Budget', { marginBoxes: true, filePath: '/alice/Documents/' });
  const css = root.querySelector('style').textContent;
  expect(css).toContain('"/alice/Documents/" "Budget"');
  expect(css).not.toContain('&Z');
});
