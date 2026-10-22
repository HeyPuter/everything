import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { prepareSolver, solveSolver, applySolverResult, saveModelToCells, emptyModel } from '../src/core/solver.js';

// Solver keeps its solution in the variable cells of the model's sheet. With that sheet grouped with another (both
// tabs selected), Keep Solver Solution wrote the values over the same cells of the other sheet as well, as typing into
// a group is, and Save Model wrote the model there too: Notes!A1 lost what it held for the solution's 5.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Model' }, { name: 'Notes' }] });
  const [model, notes] = wb.sheets.map((s) => s.id);
  wb.setActiveSheet(model);
  wb.setInput(model, 0, 0, '1'); wb.setInput(model, 1, 0, '=A1*2');
  wb.setInput(notes, 0, 0, 'Mine'); wb.setInput(notes, 4, 3, 'Kept');
  wb.groupSheets([model, notes]);
  return { wb, model, notes };
}
const grid = (wb, id) => Array.from({ length: 6 }, (_, r) => Array.from({ length: 5 }, (_, c) => wb.getValue(id, r, c)));

it('keeps a solution and saves a model on the model\'s sheet only, whatever sheets are grouped with it', () => {
  const { wb, model, notes } = book();
  const before = grid(wb, notes);
  const p = prepareSolver(wb, model, { ...emptyModel(), objective: '$A$2', goal: 'value', value: 10, variables: '$A$1' });
  applySolverResult(wb, p, solveSolver(p), { keep: true });
  expect(wb.getValue(model, 0, 0)).toBeCloseTo(5, 9);
  expect(grid(wb, notes)).toEqual(before);
  saveModelToCells(wb, model, 0, 4, p.model);
  expect(wb.getCell(model, 0, 4)).toBeTruthy();
  expect(grid(wb, notes)).toEqual(before);
});
