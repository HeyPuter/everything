// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openSolver } from '../src/ui/solver.js';
import { closeAllModals } from '../src/ui/modal.js';
import { readSolverModel } from '../src/core/solver.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  setLocale('de-DE');
});
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].at(-1);
const title = () => panel().getAttribute('aria-label');
const labelled = (text) => {
  const label = [...panel().querySelectorAll('label')].find((l) => l.textContent.trim() === text);
  return label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input');
};
const button = (text) => [...panel().querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const submit = () => panel().querySelector('form').requestSubmit();
const until = async (fn) => { for (let k = 0; k < 400 && !fn(); k++) await new Promise((r) => setTimeout(r, 5)); };

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 1, cell: { v: 0 } }, { r: 1, c: 1, cell: { v: 0 } }, { r: 2, c: 1, cell: { v: null, f: 'B1+B2' } }]);
  wb.clearHistory();
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 0, c1: 1, r2: 1, c2: 1 }), ranges: () => [{ r1: 0, c1: 1, r2: 1, c2: 1 }], active: () => ({ r: 2, c: 1 }), grid: { focus: vi.fn() } };
  return { wb, id, ctx };
}

it('reads a constraint typed with a decimal comma as the number it is, and solves the model', async () => {
  const { wb, id, ctx } = setup();
  openSolver(ctx);
  labelled('By changing variable cells').value = '$B$1:$B$2';
  labelled('Solving method').value = 'simplex';
  labelled('Solving method').dispatchEvent(new Event('change'));
  button('Add…').click();
  labelled('Cell reference').value = '$B$1:$B$2';
  labelled('Constraint').value = '2,5';
  submit();
  expect(title()).toBe('Solver Parameters');
  // Shown in the regional format, stored as the model's formulas write it.
  expect([...labelled('Subject to the constraints').options].map((o) => o.textContent)).toEqual(['$B$1:$B$2 <= 2,5']);
  submit();
  await until(() => title() === 'Solver Results');
  expect(panel().querySelector('.sv-result-message').textContent).toMatch(/found a solution/);
  submit();
  expect([wb.getValue(id, 0, 1), wb.getValue(id, 1, 1)]).toEqual([2.5, 2.5]);
  expect(readSolverModel(wb, id).constraints[0].rhs).toBe('2.5');
});

it('takes the target of Value Of and the options in the regional format', async () => {
  const { wb, id, ctx } = setup();
  openSolver(ctx);
  labelled('By changing variable cells').value = '$B$1';
  const goal = panel().querySelector('input[type="radio"][value="value"]');
  goal.checked = true;
  goal.dispatchEvent(new Event('change'));
  const value = panel().querySelector('.sv-value');
  expect(value.value).toBe('0');
  value.value = '7,25';
  button('Options…').click();
  expect(title()).toBe('Solver Options');
  expect(labelled('Constraint precision').value).toBe('0,000001');
  labelled('Constraint precision').value = '0,00001';
  submit();
  expect(title()).toBe('Solver Parameters');
  submit();
  await until(() => title() === 'Solver Results');
  submit();
  expect(wb.getValue(id, 2, 1)).toBeCloseTo(7.25, 6);
  expect(readSolverModel(wb, id)).toMatchObject({ goal: 'value', value: 7.25, options: { precision: 0.00001 } });
});
