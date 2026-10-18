// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import * as S from '../src/core/selection.js';
import { openPivotDialog } from '../src/ui/pivotdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

// A field drawn with native styling off shows the arrow that says "this opens a list" only with the .select class
// (components.css); a select styled as a plain .input reads as a text box.
it('draws the drop-down arrow on every list in the PivotTable dialog', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Amount'], ['East', '10'], ['West', '20']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const range = parseRange('A1:B3');
  const { panel } = openPivotDialog({ wb, sheetId: () => id, range: () => range, selection: () => S.fromRange(range), grid: { focus: vi.fn() } });
  const selects = [...panel.querySelectorAll('select')];
  expect(selects).toHaveLength(6);
  for (const s of selects) expect(s.classList.contains('select')).toBe(true);
});

it('builds the Power Query dialogs\' lists as .select fields', () => {
  for (const file of ['../src/ui/query-editor.js', '../src/ui/get-data.js', '../src/ui/pivotdialog.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/el\('select\.input/);
  }
});
