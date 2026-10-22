// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { openCreateNamesDialog } from '../src/ui/createnames.js';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Create Names from Selection redefined a name the workbook already had without asking: with Sales naming B2:B9 and
// read by formulas, labels Sales and Costs over D1:E5 pointed Sales at D2:D5, and every formula using it read other
// cells. As Excel does, it now asks first: Replace takes the new cells, Keep existing leaves that name as it was and
// creates the others, and dismissing the question leaves everything as it was.
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.defineName('Sales', 'Sheet1!$B$2:$B$9');
  wb.setInput(id, 0, 3, 'Sales'); wb.setInput(id, 0, 4, 'Costs');
  for (let r = 1; r <= 4; r++) { wb.setInput(id, r, 3, r); wb.setInput(id, r, 4, r * 2); }
  const modal = openCreateNamesDialog({ wb, sheetId: () => id, grid: { focus() {} } }, parseRange('D1:E5'));
  const ref = (name) => wb.names.find((n) => n.name === name)?.ref;
  const question = () => [...document.querySelectorAll('.modal-root:not(.closing)')].at(-1);
  const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  return { wb, modal, ref, question, button };
}

it('asks before replacing an existing name, and replaces it on Replace', async () => {
  const { modal, ref, question, button } = setup();
  modal.panel.querySelector('form').requestSubmit();
  await settle();
  expect(question().textContent).toContain('Sales (Sheet1!$B$2:$B$9) already exists');
  expect(ref('Costs')).toBeUndefined();
  button(question(), 'Replace').click();
  await settle();
  expect(ref('Sales')).toBe('Sheet1!$D$2:$D$5');
  expect(ref('Costs')).toBe('Sheet1!$E$2:$E$5');
});

it('keeps the existing name and creates the others on Keep existing', async () => {
  const { modal, ref, question, button } = setup();
  modal.panel.querySelector('form').requestSubmit();
  await settle();
  button(question(), 'Keep existing').click();
  await settle();
  expect(ref('Sales')).toBe('Sheet1!$B$2:$B$9');
  expect(ref('Costs')).toBe('Sheet1!$E$2:$E$5');
});

it('changes nothing when the question is dismissed', async () => {
  const { wb, modal, ref, question } = setup();
  modal.panel.querySelector('form').requestSubmit();
  await settle();
  question().querySelector('.modal-head button').click();
  await settle();
  expect(ref('Sales')).toBe('Sheet1!$B$2:$B$9');
  expect(ref('Costs')).toBeUndefined();
  expect(wb.names.length).toBe(1);
  expect(modal.panel.isConnected).toBe(true);
});
