// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createQueriesPane } from '../src/ui/queries-pane.js';
import { closeAllModals } from '../src/ui/modal.js';
import { saveQuery } from '../src/core/queries.js';

window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// A query's row in Queries & Connections opens the Power Query Editor on Enter and asks to delete the query on
// Delete. The row listened for those keys on everything inside it, so Enter on its Refresh, Delete or More
// button did what the button does and opened the editor as well, and Delete on the Edit button asked to delete.
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

function mount(withQuery = true) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Region'); wb.setInput(id, 1, 0, 'North');
  wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { name: 'Sales' });
  if (withQuery) saveQuery(wb, { id: 'c', name: 'Conn', source: { kind: 'table', table: 'Sales' }, steps: [], load: { kind: 'connection' } });
  const edit = vi.fn();
  const pane = createQueriesPane({ wb, grid: { focus() {} }, sheetId: () => id, subscribe: () => () => {}, edit });
  document.body.append(pane.el);
  pane.show();
  return { pane, edit };
}
const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

it('opens the editor from Enter on the row, not from Enter on one of its buttons', () => {
  const { pane, edit } = mount();
  press(pane.el.querySelector('[aria-label="Refresh Conn"]'), 'Enter');
  press(pane.el.querySelector('[aria-label="More for Conn"]'), 'Enter');
  expect(edit).not.toHaveBeenCalled();
  press(pane.el.querySelector('.qc-item'), 'Enter');
  expect(edit).toHaveBeenCalledWith('c');
});

it('asks to delete from Delete on the row only', () => {
  const { pane } = mount();
  press(pane.el.querySelector('[aria-label="Edit Conn"]'), 'Delete');
  expect(document.querySelector('.modal-panel')).toBeNull();
  press(pane.el.querySelector('.qc-item'), 'Delete');
  expect(document.querySelector('.modal-panel')?.textContent).toMatch(/delete "Conn"/);
});

