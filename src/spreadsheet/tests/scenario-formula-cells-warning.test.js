// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openScenarioEditor } from '../src/ui/scenario-manager.js';
import { showScenario } from '../src/core/scenarios.js';
import { closeAllModals } from '../src/ui/modal.js';

// A scenario whose changing cells held formulas was added without a word, and showing it wrote its values over
// those formulas. Excel says so when the scenario is added ("formulas will be replaced by constant values when
// the scenario is shown"); the dialog now asks before going on to the values, and Cancel goes back to it.
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

const panels = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')];
const submit = () => panels().at(-1).querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
const button = (text) => [...panels().at(-1).querySelectorAll('button')].find((b) => b.textContent === text);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function open() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2');
  wb.setInput(id, 0, 1, '=A1*3');
  const range = { r1: 0, c1: 0, r2: 0, c2: 1 };
  openScenarioEditor({ wb, sheetId: () => id, range: () => range, ranges: () => [range], grid: { focus: vi.fn() } }, null);
  panels().at(-1).querySelector('input').value = 'Best case';
  return { wb, id };
}

it('asks before a scenario changes a cell that holds a formula, and Cancel keeps the dialog', async () => {
  open();
  submit();
  await flush();
  expect(panels().at(-1).textContent).toContain('hold a formula');
  button('Cancel').click();
  await flush();
  expect(panels().at(-1).getAttribute('aria-label')).toBe('Add Scenario');
});

it('goes on to the values once the warning is accepted', async () => {
  const { wb, id } = open();
  submit();
  await flush();
  button('OK').click();
  await flush();
  expect(panels().at(-1).getAttribute('aria-label')).toBe('Scenario Values');
  submit();
  expect(wb.sheet(id).scenarios.list[0].values).toEqual([2, 6]);
  showScenario(wb, id, 'Best case');
  expect(wb.getCell(id, 0, 1)).toMatchObject({ v: 6, f: null });
});

it('asks nothing when every changing cell holds a value', () => {
  const { wb, id } = open();
  wb.setInput(id, 0, 1, '5');
  submit();
  expect(panels().at(-1).getAttribute('aria-label')).toBe('Scenario Values');
});
