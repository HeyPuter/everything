// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createQueriesPane } from '../src/ui/queries-pane.js';
import { saveQuery, deleteQuery } from '../src/core/queries.js';

// With no queries, Queries & Connections put its "no queries" words inside the list of queries (role list), a
// list holding no list item, which screen readers announce as a list and accessibility checkers flag. The words
// now stand beside the list, which is hidden while it is empty.
afterEach(() => { document.body.replaceChildren(); });

it('says there are no queries outside the list, and lists them once there are', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Region'); wb.setInput(id, 1, 0, 'North');
  wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { name: 'Sales' });
  const pane = createQueriesPane({ wb, grid: { focus() {} }, sheetId: () => id, subscribe: () => () => {}, edit() {} });
  document.body.append(pane.el);
  pane.show();
  const list = pane.el.querySelector('[role="list"]');
  const empty = () => [...pane.el.querySelectorAll('p')].find((p) => /This workbook has no queries/.test(p.textContent));
  expect(list.querySelector(':scope > :not([role="listitem"])')).toBeNull();
  expect(list.hidden).toBe(true);
  expect(empty()?.hidden).toBe(false);
  saveQuery(wb, { id: 'c', name: 'Conn', source: { kind: 'table', table: 'Sales' }, steps: [], load: { kind: 'connection' } });
  pane.render(true);
  expect(list.hidden).toBe(false);
  expect(list.querySelectorAll('[role="listitem"]').length).toBe(1);
  expect(empty()?.hidden ?? true).toBe(true);
  deleteQuery(wb, 'c');
  pane.render(true);
  expect(list.hidden).toBe(true);
  expect(empty()?.hidden).toBe(false);
});
