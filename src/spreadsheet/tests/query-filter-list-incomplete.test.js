// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { applyStep, normalizeQuery, stepFormula, queryByName } from '../src/core/queries.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';

window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.CSS ||= {};
CSS.escape ||= (s) => String(s).replace(/["\\]/g, '\\$&');
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const ids = (rows, distinct) => ({ columns: ['Id', 'N'], types: ['text', 'int'], rows: Array.from({ length: rows }, (_, i) => [`id${i % distinct}`, i]) });

it('keeps the values a cut-short filter list did not show, leaving out only those cleared', () => {
  const step = normalizeQuery({ name: 'Q', steps: [{ type: 'filterRows', column: 'Id', conditions: [{ op: 'notIn', values: ['id1', 'id2'] }] }] }).steps[0];
  expect(step.conditions).toEqual([{ op: 'notIn', values: ['id1', 'id2'] }]);
  expect(applyStep(ids(3000, 1500), step).rows).toHaveLength(2996);
  expect(stepFormula({ source: { kind: 'blank' }, steps: [step] }, 1)).toBe('= Table.SelectRows(Source, each not List.Contains({"id1", "id2"}, [Id]))');
});

it('clearing a value in the filter list of a column with more than 1,000 values keeps the rest of the rows', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['Id', 'N'], ...Array.from({ length: 3000 }, (_, i) => [`id${i % 1500}`, i])];
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3000, c2: 1 }, { name: 'Ids' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => id, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const editor = openQueryEditor(ctx, { draft: { id: 'q1', name: 'Ids', source: { kind: 'table', table: 'Ids' }, steps: [], load: { kind: 'connection' } } });
  await editor.ready;
  const filterOf = async () => {
    [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Filter Id').click();
    return document.querySelector('.pq-popup');
  };
  let popup = await filterOf();
  expect(popup.textContent).toContain('List may be incomplete.');
  const box = (text) => [...popup.querySelectorAll('label.check')].find((l) => l.textContent === text).querySelector('input');
  box('id0').checked = false;
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  await settle();
  // Clearing another keeps the first one out too.
  popup = await filterOf();
  box('id1').checked = false;
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  await settle();
  expect(document.querySelectorAll('.pq-step-name')).toHaveLength(2);
  [...document.querySelector('.pq-editor').querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close & Load').click();
  await settle(20);
  // 1,500 ids twice over, two of them left out.
  expect(queryByName(wb, 'Ids').rowCount).toBe(2996);
});
