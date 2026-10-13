// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openSolver } from '../src/ui/solver.js';
import { closeAllModals } from '../src/ui/modal.js';
import { readSolverModel } from '../src/core/solver.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].at(-1);
const title = () => panel().getAttribute('aria-label');
const labelled = (text) => {
  const label = [...panel().querySelectorAll('label')].find((l) => l.textContent.trim() === text);
  return label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input");
};
const button = (text) => [...panel().querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const submit = () => panel().querySelector('form').requestSubmit();
const until = async (fn) => { for (let k = 0; k < 400 && !fn(); k++) await new Promise((r) => setTimeout(r, 5)); };

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['', 'x', 'y'], ['Qty', 0, 0], ['Profit', '=3*B2+5*C2'], ['Plant 1', '=B2', '', 4], ['Plant 2', '=2*C2', '', 12], ['Plant 3', '=3*B2+2*C2', '', 18]];
  rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') wb.setInput(id, r, c, String(v)); }));
  wb.clearHistory();
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 1, c1: 1, r2: 1, c2: 2 }), ranges: () => [{ r1: 1, c1: 1, r2: 1, c2: 2 }], active: () => ({ r: 2, c: 1 }), grid: { focus: vi.fn() } };
  return { wb, id, ctx };
}

describe('Solver dialog', () => {
  it('builds a model, solves it, keeps the solution and adds a report', async () => {
    const { wb, id, ctx } = setup();
    openSolver(ctx);
    expect(title()).toBe('Solver Parameters');
    expect(labelled('Set objective').value).toBe('$B$3');
    labelled('By changing variable cells').value = '$B$2:$C$2';
    labelled('Solving method').value = 'simplex';
    labelled('Solving method').dispatchEvent(new Event('change'));
    expect(panel().querySelector('.sv-engine-note').textContent).toMatch(/linear/);
    button('Add…').click();
    expect(title()).toBe('Add Constraint');
    labelled('Cell reference').value = '$B$4:$B$6';
    labelled('Constraint').value = '$D$4:$D$6';
    submit();
    expect(title()).toBe('Solver Parameters');
    expect([...labelled('Subject to the constraints').options].map((o) => o.textContent)).toEqual(['$B$4:$B$6 <= $D$4:$D$6']);
    submit();
    await until(() => title() === 'Solver Results');
    expect(panel().querySelector('.sv-result-message').textContent).toMatch(/found a solution/);
    labelled('Answer').checked = true;
    submit();
    expect(wb.getValue(id, 1, 1)).toBe(2);
    expect(wb.getValue(id, 1, 2)).toBe(6);
    expect(wb.sheetByName('Answer Report 1')).toBeTruthy();
    expect(wb.undoLabels()).toEqual(['Solver']);
    expect(readSolverModel(wb, id).constraints).toEqual([{ lhs: '$B$4:$B$6', rel: '<=', rhs: '$D$4:$D$6' }]);
  });

  it('blames the field a model gets wrong', () => {
    const { ctx } = setup();
    openSolver(ctx);
    labelled('By changing variable cells').value = '$B$3';
    submit();
    const input = labelled('By changing variable cells');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(panel().querySelector('.field-error').textContent).toMatch(/formula/);
  });

  it('greys the right side for integer constraints and edits options', () => {
    const { ctx } = setup();
    openSolver(ctx);
    button('Add…').click();
    const rel = labelled('Relation');
    rel.value = 'int';
    rel.dispatchEvent(new Event('change'));
    expect(labelled('Constraint').disabled).toBe(true);
    expect(labelled('Constraint').value).toBe('integer');
    button('Cancel').click();
    button('Options…').click();
    expect(title()).toBe('Solver Options');
    const tabs = panel().querySelectorAll('[role="tab"]');
    expect([...tabs].map((t) => t.textContent)).toEqual(['All Methods', 'GRG Nonlinear', 'Evolutionary']);
    labelled('Constraint precision').value = '2';
    submit();
    expect(panel().querySelector('.field-error').textContent).toMatch(/precision/);
    labelled('Constraint precision').value = '0.0001';
    tabs[1].click();
    labelled('Use multistart').checked = true;
    submit();
    expect(title()).toBe('Solver Parameters');
  });

  it('closes keeping the model in the sheet', () => {
    const { wb, id, ctx } = setup();
    openSolver(ctx);
    labelled('By changing variable cells').value = '$B$2:$C$2';
    labelled('Min').checked = true;
    button('Close').click();
    const m = readSolverModel(wb, id);
    expect(m).toMatchObject({ objective: '$B$3', goal: 'min', variables: '$B$2:$C$2' });
    openSolver(ctx);
    expect(labelled('Min').checked).toBe(true);
  });
});
