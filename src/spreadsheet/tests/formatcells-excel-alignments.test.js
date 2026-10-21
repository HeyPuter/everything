// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Center Across Selection, Fill, Justify and Distributed open from an Excel file and are kept, but the Horizontal
// list offered only Automatic, Left, Center and Right: a title centred across its columns showed as "Automatic",
// and none of the four could be chosen, as Excel's Format Cells chooses them.
function open(align) {
  const wb = new Workbook(), id = wb.activeSheetId, range = parseRange('A1:C1');
  wb.setInput(id, 0, 0, 'Quarterly report');
  if (align) wb.applyStyle(id, range, { align });
  wb.clearHistory();
  const run = vi.fn((cmd, { patch }) => { if (Object.keys(patch).length) wb.applyStyle(id, range, patch); });
  const modal = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }),
    range: () => range, style: () => wb.styleAt(id, 0, 0) || {}, grid: {}, run }, { panel: 'align' });
  const horizontal = modal.panel.querySelector('[aria-label="Horizontal"]');
  const apply = () => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { wb, id, horizontal, apply };
}

it.each([['centerContinuous', 'Center Across Selection'], ['fill', 'Fill'], ['justify', 'Justify'], ['distributed', 'Distributed']])(
  'shows %s as it is, and OK keeps it', (align, label) => {
    const { wb, id, horizontal, apply } = open(align);
    expect(horizontal.value).toBe(align);
    expect(horizontal.selectedOptions[0].textContent).toBe(label);
    apply();
    expect(wb.styleAt(id, 0, 0).align).toBe(align);
    expect(wb.undoLabels()).toEqual([]);
  });

it('applies Center Across Selection chosen in the list', () => {
  const { wb, id, horizontal, apply } = open(null);
  horizontal.value = 'centerContinuous';
  horizontal.dispatchEvent(new Event('change'));
  apply();
  expect(wb.styleAt(id, 0, 2).align).toBe('centerContinuous');
});
