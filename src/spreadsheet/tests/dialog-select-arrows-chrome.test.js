// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Workbook } from '../src/core/workbook.js';
import { openMoveSheetDialog } from '../src/ui/movesheet.js';
import { closeAllModals } from '../src/ui/modal.js';
import { stylesheet, declared } from './helpers/css.js';

vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

// With native styling off, only the .select field style draws the arrow that says "this opens a list"; a
// drop-down built as a plain .input (Move or Copy's workbook, Print's paper size, the Equation, Text Box,
// chart, theme, import and Copy to another spreadsheet lists, the filter menu's condition) looked like a box
// to type into. A list box shown open (size > 1) has no arrow to draw and keeps the plain field style.
it('builds every drop-down list as a .select field', () => {
  const root = path.resolve(process.cwd(), 'src');
  const files = [...readdirSync(path.join(root, 'ui')).map((f) => path.join(root, 'ui', f)), path.join(root, 'views', 'editor.js')].filter((f) => f.endsWith('.js'))
    // The PivotTable and Power Query dialogs have a test of their own (dialog-select-arrows.test.js).
    .filter((f) => !['pivotdialog.js', 'get-data.js', 'query-editor.js'].includes(path.basename(f)));
  const plain = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/el\('select\.input[^']*', \{[^}]*\}/g)) if (!/\bsize: *\d/.test(m[0])) plain.push(`${path.basename(file)}: ${m[0].slice(0, 60)}`);
  }
  expect(plain).toEqual([]);
});

it('shows the arrow on Move or Copy\'s workbook list and none on its open list of sheets', () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'More' }] });
  openMoveSheetDialog({ wb, doc: { name: 'Book' }, grid: { focus() {} }, run() {} }, wb.activeSheetId);
  const [book, before] = document.querySelectorAll('.modal-panel select');
  expect(book.classList.contains('select')).toBe(true);
  expect(before.size).toBeGreaterThan(1);
  expect(before.classList.contains('select')).toBe(false);
});

it('keeps the filter menu\'s condition list compact with room for its arrow', () => {
  const css = stylesheet('editor.css');
  expect(declared(css, '.filter-cond-row .select')['padding-right']).toBe('30px');
  expect(declared(stylesheet('chart-ui.css'), '.chart-pane-field select.select')['line-height']).toBe('24px');
});
