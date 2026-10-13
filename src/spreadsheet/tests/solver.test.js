import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { prepareSolver, solveSolver, applySolverResult, readSolverModel, saveSolverModel, emptyModel, runSolver,
  modelToCells, modelFromCells, saveModelToCells, availableReports, hasSolverModel } from '../src/core/solver.js';

/** A workbook from rows of cell inputs (A1 down), on its first sheet. */
function book(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((text, c) => { if (text !== null && text !== '') wb.setInput(id, r, c, String(text)); }));
  wb.clearHistory();
  return { wb, id, v: (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); const c = m[1].charCodeAt(0) - 65; return wb.getValue(id, Number(m[2]) - 1, c); } };
}
const model = (patch) => ({ ...emptyModel(), ...patch, options: { ...emptyModel().options, ...(patch.options || {}) } });
const solve = (wb, id, m) => {
  const p = prepareSolver(wb, id, m);
  if (p.error) throw new Error(p.error);
  return { p, r: solveSolver(p) };
};

describe('Simplex LP', () => {
  // Maximize 3x + 5y with x <= 4, 2y <= 12, 3x + 2y <= 18: x = 2, y = 6, profit 36.
  const productMix = () => book([
    ['', 'x', 'y'],
    ['Qty', 0, 0],
    ['Profit', '=3*B2+5*C2'],
    ['Plant 1', '=B2', '', 4],
    ['Plant 2', '=2*C2', '', 12],
    ['Plant 3', '=3*B2+2*C2', '', 18],
  ]);
  const mix = { objective: '$B$3', goal: 'max', variables: '$B$2:$C$2', engine: 'simplex',
    constraints: [{ lhs: '$B$4:$B$6', rel: '<=', rhs: '$D$4:$D$6' }] };

  it('solves a product mix and keeps the solution as one undo step', () => {
    const { wb, id, v } = productMix();
    const { p, r } = solve(wb, id, model(mix));
    expect(r.status).toBe('optimal');
    expect(r.x).toEqual([2, 6]);
    expect(r.objective).toBeCloseTo(36, 9);
    expect(v('B2')).toBe(0); // nothing changes until the result is applied
    applySolverResult(wb, p, r, { keep: true });
    expect(v('B2')).toBe(2);
    expect(v('B3')).toBe(36);
    expect(wb.undoLabels()).toEqual(['Solver']);
    wb.undo();
    expect(v('B2')).toBe(0);
    expect(v('B3')).toBe(0);
    expect(hasSolverModel(wb, id)).toBe(false);
    wb.redo();
    expect(v('C2')).toBe(6);
    expect(hasSolverModel(wb, id)).toBe(true);
  });

  it('restores the original values when asked, still saving the model', () => {
    const { wb, id, v } = productMix();
    const { p, r } = solve(wb, id, model(mix));
    applySolverResult(wb, p, r, { keep: false });
    expect(v('B2')).toBe(0);
    expect(readSolverModel(wb, id).objective).toBe('$B$3');
  });

  it('writes Answer, Sensitivity and Limits reports with shadow prices and ranges', () => {
    const { wb, id } = productMix();
    const { p, r } = solve(wb, id, model(mix));
    expect(availableReports(p, r)).toEqual(['answer', 'sensitivity', 'limits']);
    const { reportSheetIds } = applySolverResult(wb, p, r, { keep: true, reports: ['answer', 'sensitivity', 'limits'] });
    expect(reportSheetIds).toHaveLength(3);
    expect(wb.activeSheetId).toBe(id);
    const grid = (sid) => {
      const s = wb.sheet(sid);
      const out = [];
      for (const [key, cell] of s.cells) { const [rr, cc] = key.split(',').map(Number); (out[rr] ||= [])[cc] = cell.v; }
      return out;
    };
    const sens = grid(wb.sheetByName('Sensitivity Report 1').id);
    const row = (label) => sens.find((line) => line?.[1] === label);
    // Variable cells: final value, reduced cost, coefficient, allowable increase and decrease.
    expect(row('$B$2').slice(3, 8)).toEqual([2, 0, 3, 4.5, 3]);
    expect(row('$C$2').slice(3, 8)).toEqual([6, 0, 5, 1e30, 3]);
    // Constraints: final value, shadow price, right side, allowable increase and decrease.
    expect(row('$B$4').slice(3, 8)).toEqual([2, 0, 4, 1e30, 2]);
    expect(row('$B$5').slice(3, 8)).toEqual([12, 1.5, 12, 6, 6]);
    expect(row('$B$6').slice(3, 8)).toEqual([18, 1, 18, 6, 6]);
    const answer = grid(wb.sheetByName('Answer Report 1').id);
    const plant3 = answer.find((line) => line?.[1] === '$B$6' && line?.[4]);
    expect(plant3.slice(2, 7)).toEqual(['Plant 3 x', 18, '$B$6<=$D$6', 'Binding', 0]);
    expect(answer.find((line) => line?.[1] === '$B$4' && line?.[4])?.slice(5, 7)).toEqual(['Not Binding', 2]);
    const limits = grid(wb.sheetByName('Limits Report 1').id);
    const lx = limits.find((line) => line?.[1] === '$B$2' && line?.[3] === 2);
    expect(lx[5]).toBe(0); expect(lx[6]).toBe(30); expect(lx[8]).toBe(2); expect(lx[9]).toBe(36);
    expect(wb.undoLabels()).toEqual(['Solver']);
    wb.undo();
    expect(wb.sheets).toHaveLength(1);
  });

  it('solves a transportation problem at minimum cost', () => {
    // Three plants (supply 20, 30, 25) to four markets (demand 10, 25, 20, 20).
    const cost = [[8, 6, 10, 9], [9, 12, 13, 7], [14, 9, 16, 5]];
    const rows = [['', 'M1', 'M2', 'M3', 'M4', 'Shipped', 'Supply']];
    for (let i = 0; i < 3; i++) rows.push([`P${i + 1}`, 0, 0, 0, 0, `=SUM(B${i + 2}:E${i + 2})`, [20, 30, 25][i]]);
    rows.push(['Received', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)', '=SUM(E2:E4)']);
    rows.push(['Demand', 10, 25, 20, 20]);
    cost.forEach((line) => rows.push(['', ...line]));
    rows.push(['Cost', '=SUMPRODUCT(B2:E4,B7:E9)']);
    const { wb, id } = book(rows);
    const { r } = solve(wb, id, model({ objective: 'B10', goal: 'min', variables: 'B2:E4', engine: 'simplex',
      constraints: [{ lhs: 'F2:F4', rel: '<=', rhs: 'G2:G4' }, { lhs: 'B5:E5', rel: '>=', rhs: 'B6:E6' }] }));
    expect(r.status).toBe('optimal');
    expect(r.objective).toBeCloseTo(615, 6);
  });

  it('solves a 0-1 knapsack by branch and bound', () => {
    const values = [60, 100, 120, 80, 30, 70], weights = [10, 20, 30, 15, 5, 25];
    const { wb, id } = book([values, weights, [0, 0, 0, 0, 0, 0], ['=SUMPRODUCT(A1:F1,A3:F3)', '=SUMPRODUCT(A2:F2,A3:F3)']]);
    const { r } = solve(wb, id, model({ objective: 'A4', goal: 'max', variables: 'A3:F3', engine: 'simplex', options: { integerOptimality: 0 },
      constraints: [{ lhs: 'B4', rel: '<=', rhs: '60' }, { lhs: 'A3:F3', rel: 'bin', rhs: 'binary' }] }));
    expect(r.status).toBe('optimal');
    // Best under 60: items 1, 2, 4, 5 (weights 10+20+15+5 = 50 → 270) or 1, 2, 5, 6 (60 → 260)…
    let best = 0;
    for (let mask = 0; mask < 64; mask++) {
      let v = 0, w = 0;
      for (let k = 0; k < 6; k++) if (mask & (1 << k)) { v += values[k]; w += weights[k]; }
      if (w <= 60) best = Math.max(best, v);
    }
    expect(r.objective).toBe(best);
    expect(r.x.every((x) => x === 0 || x === 1)).toBe(true);
  });

  it('solves a general integer program', () => {
    // max x + y st -2x + 2y >= 1, -8x + 10y <= 13, x, y integer ≥ 0: LP optimum (4, 4.5), integer (1, 2).
    const { wb, id } = book([[0, 0], ['=A1+B1'], ['=-2*A1+2*B1'], ['=-8*A1+10*B1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'max', variables: 'A1:B1', engine: 'simplex', options: { integerOptimality: 0 },
      constraints: [{ lhs: 'A3', rel: '>=', rhs: '1' }, { lhs: 'A4', rel: '<=', rhs: '13' }, { lhs: 'A1:B1', rel: 'int', rhs: 'integer' }] }));
    expect(r.status).toBe('optimal');
    expect(r.x).toEqual([1, 2]);
  });

  it('finds an assignment with an all-different constraint', () => {
    // Four jobs to four slots: slot numbers 1..4, cost = |slot - wanted|·weight.
    const { wb, id } = book([[1, 1, 1, 1], [3, 1, 4, 2], ['=ABS(A1-A2)+ABS(B1-B2)+ABS(C1-C2)+ABS(D1-D2)']]);
    const { r } = solve(wb, id, model({ objective: 'A3', goal: 'min', variables: 'A1:D1', engine: 'evolutionary', options: { seed: 5, maxTimeNoImprove: 60 },
      constraints: [{ lhs: 'A1:D1', rel: 'dif', rhs: 'AllDifferent' }] }));
    expect(r.x).toEqual([3, 1, 4, 2]);
    expect(r.objective).toBe(0);
  });

  it('meets an objective value', () => {
    const { wb, id } = book([[0, 0], ['=2*A1+3*B1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'value', value: 12, variables: 'A1:B1', engine: 'simplex', constraints: [{ lhs: 'A1', rel: '=', rhs: '3' }] }));
    expect(r.status).toBe('optimal');
    expect(r.x).toEqual([3, 2]);
  });

  it('reports an infeasible model', () => {
    const { wb, id } = book([[0], ['=A1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'max', variables: 'A1', engine: 'simplex', constraints: [{ lhs: 'A2', rel: '>=', rhs: '5' }, { lhs: 'A2', rel: '<=', rhs: '3' }] }));
    expect(r.status).toBe('infeasible');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not find/i);
  });

  it('reports an unbounded model', () => {
    const { wb, id } = book([[0, 0], ['=A1+B1'], ['=A1-B1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'max', variables: 'A1:B1', engine: 'simplex', constraints: [{ lhs: 'A3', rel: '<=', rhs: '3' }] }));
    expect(r.status).toBe('unbounded');
  });

  it('refuses a model that is not linear', () => {
    const { wb, id } = book([[1, 1], ['=A1*B1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'max', variables: 'A1:B1', engine: 'simplex', constraints: [{ lhs: 'A1:B1', rel: '<=', rhs: '3' }] }));
    expect(r.status).toBe('notLinear');
    expect(wb.getValue(id, 0, 0)).toBe(1);
  });

  it('treats unconstrained variables as free when nonnegativity is off', () => {
    const { wb, id } = book([[5], ['=A1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1', engine: 'simplex', nonNegative: false, constraints: [{ lhs: 'A1', rel: '>=', rhs: '-7' }] }));
    expect(r.x).toEqual([-7]);
  });
});

describe('GRG Nonlinear', () => {
  it('minimizes the Rosenbrock function', () => {
    const { wb, id } = book([[-1.2, 1], ['=100*(B1-A1^2)^2+(1-A1)^2']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', nonNegative: false }));
    expect(['localOptimal', 'converged']).toContain(r.status);
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(1, 3);
    expect(r.objective).toBeLessThan(1e-6);
  });

  it('solves a constrained nonlinear model and reports Lagrange multipliers', () => {
    // max x·y st x + 2y <= 10 → x = 5, y = 2.5, objective 12.5, multiplier 2.5.
    const { wb, id } = book([[1, 1], ['=A1*B1'], ['=A1+2*B1']]);
    const { p, r } = solve(wb, id, model({ objective: 'A2', goal: 'max', variables: 'A1:B1', constraints: [{ lhs: 'A3', rel: '<=', rhs: '10' }] }));
    expect(r.solved).toBe(true);
    expect(r.x[0]).toBeCloseTo(5, 3);
    expect(r.x[1]).toBeCloseTo(2.5, 3);
    expect(r.objective).toBeCloseTo(12.5, 4);
    const { reportSheetIds } = applySolverResult(wb, p, r, { reports: ['sensitivity'] });
    const s = wb.sheet(reportSheetIds[0]);
    const lines = [];
    for (const [key, cell] of s.cells) { const [rr, cc] = key.split(',').map(Number); (lines[rr] ||= [])[cc] = cell.v; }
    const row = lines.find((line) => line?.[1] === '$A$3');
    expect(row[4]).toBeCloseTo(2.5, 2);
  });

  it('handles equality and >= constraints', () => {
    // min x² + y² st x·y >= 1 → (1, 1); and st x + y = 1 → (0.5, 0.5).
    const a = book([[2, 2], ['=A1^2+B1^2'], ['=A1*B1']]);
    const r1 = solve(a.wb, a.id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', constraints: [{ lhs: 'A3', rel: '>=', rhs: '1' }] })).r;
    expect(r1.x[0]).toBeCloseTo(1, 3);
    expect(r1.objective).toBeCloseTo(2, 4);
    const b = book([[3, 0], ['=A1^2+B1^2'], ['=A1+B1']]);
    const r2 = solve(b.wb, b.id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', nonNegative: false, constraints: [{ lhs: 'A3', rel: '=', rhs: '1' }] })).r;
    expect(r2.x[0]).toBeCloseTo(0.5, 4);
    expect(r2.x[1]).toBeCloseTo(0.5, 4);
  });

  it('respects bounds from constraints on the variable cells', () => {
    const { wb, id } = book([[0], ['=(A1-3)^2']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1', constraints: [{ lhs: 'A1', rel: '<=', rhs: '1' }] }));
    expect(r.x[0]).toBeCloseTo(1, 6);
  });

  it('reports infeasibility', () => {
    const { wb, id } = book([[2], ['=A1'], ['=A1^2+1']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1', nonNegative: false, constraints: [{ lhs: 'A3', rel: '<=', rhs: '0' }] }));
    expect(r.status).toBe('infeasible');
  });

  it('finds the global minimum with multistart', () => {
    const { wb, id } = book([[4], ['=SIN(3*A1)+0.1*A1^2']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1', nonNegative: false, options: { multistart: true, population: 20, seed: 3 },
      constraints: [{ lhs: 'A1', rel: '>=', rhs: '-5' }, { lhs: 'A1', rel: '<=', rhs: '5' }] }));
    expect(r.x[0]).toBeCloseTo(-0.5122, 3);
  });

  it('branches on integer variables', () => {
    // min (x - 2.6)² + (y - 1.4)², x and y integer → (3, 1).
    const { wb, id } = book([[0, 0], ['=(A1-2.6)^2+(B1-1.4)^2']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', options: { integerOptimality: 0 }, constraints: [{ lhs: 'A1:B1', rel: 'int', rhs: 'integer' }] }));
    expect(r.x).toEqual([3, 1]);
  });
});

describe('Evolutionary', () => {
  it('solves a non-smooth model within bounds', () => {
    const { wb, id } = book([[0, 0], ['=ABS(A1-3)+ABS(B1+1)+IF(A1>2.5,0,1)']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', nonNegative: false, engine: 'evolutionary', options: { seed: 11, maxTimeNoImprove: 60 },
      constraints: [{ lhs: 'A1:B1', rel: '>=', rhs: '-10' }, { lhs: 'A1:B1', rel: '<=', rhs: '10' }] }));
    expect(r.ok).toBe(true);
    expect(r.objective).toBeLessThan(1e-3);
  });

  it('asks for bounds', () => {
    const { wb, id } = book([[0], ['=ABS(A1-3)']]);
    const { r } = solve(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1', engine: 'evolutionary' }));
    expect(r.status).toBe('needsBounds');
  });
});

describe('Model', () => {
  const full = () => model({ objective: '$B$3', goal: 'min', variables: '$B$2:$C$2,$E$2', engine: 'evolutionary', nonNegative: false,
    constraints: [{ lhs: '$B$4:$B$6', rel: '<=', rhs: '$D$4:$D$6' }, { lhs: '$B$2', rel: '>=', rhs: '1.5' }, { lhs: '$B$2:$C$2', rel: 'int', rhs: 'integer' },
      { lhs: '$E$2', rel: 'bin', rhs: 'binary' }, { lhs: '$B$7', rel: '=', rhs: '$D$7*2' }],
    options: { precision: 1e-5, maxTime: 30, population: 50, seed: 42, multistart: true, derivatives: 'central', integerOptimality: 0.5 } });

  it('round-trips through hidden sheet names, the document and .xlsx', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.renameSheet(id, 'Plan A');
    saveSolverModel(wb, id, full());
    const names = wb.names.filter((n) => n.name.startsWith('solver_'));
    expect(names.every((n) => n.hidden && n.sheet === 'Plan A')).toBe(true);
    expect(names.find((n) => n.name === 'solver_adj').ref).toBe("'Plan A'!$B$2:$C$2,'Plan A'!$E$2");
    expect(names.find((n) => n.name === 'solver_rel3').ref).toBe('4');
    expect(names.find((n) => n.name === 'solver_rhs3').ref).toBe('"integer"');
    expect(names.find((n) => n.name === 'solver_rhs5').ref).toBe("'Plan A'!$D$7*2");
    expect(readSolverModel(wb, id)).toEqual(full());
    const again = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(readSolverModel(again, again.activeSheetId)).toEqual(full());
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'x.xlsx');
    expect(readSolverModel(back, back.sheets[0].id)).toEqual(full());
  });

  it('follows rows inserted above its cells', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    saveSolverModel(wb, id, full());
    wb.insertRows(id, 0, 2);
    const m = readSolverModel(wb, id);
    expect(m.objective).toBe('$B$5');
    expect(m.variables).toBe('$B$4:$C$4,$E$4');
    expect(m.constraints[0]).toEqual({ lhs: '$B$6:$B$8', rel: '<=', rhs: '$D$6:$D$8' });
  });

  it('saves to cells and loads back', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const m = full();
    const count = saveModelToCells(wb, id, 10, 7, m);
    expect(count).toBe(modelToCells(m).length);
    expect(wb.getCell(id, 10, 7).f).toBe('MIN($B$3)');
    const loaded = modelFromCells(wb, id, { r1: 10, c1: 7, r2: 10 + count - 1, c2: 7 });
    expect(loaded.error).toBeUndefined();
    expect(loaded.model).toEqual(m);
    expect(modelFromCells(wb, id, { r1: 0, c1: 0, r2: 3, c2: 0 }).error).toMatch(/objective/);
  });

  it('refuses bad models with the field to blame', () => {
    const { wb, id } = book([[1, '=A1'], ['x']]);
    expect(prepareSolver(wb, id, model({ objective: 'A1', variables: 'A1' }))).toMatchObject({ field: 'objective' });
    expect(prepareSolver(wb, id, model({ objective: 'B1', variables: 'B1' }))).toMatchObject({ field: 'variables' });
    expect(prepareSolver(wb, id, model({ objective: 'B1', variables: 'A2' }))).toMatchObject({ field: 'variables' });
    expect(prepareSolver(wb, id, model({ objective: 'B1', variables: 'nowhere!' }))).toMatchObject({ field: 'variables' });
    expect(prepareSolver(wb, id, model({ objective: 'B1', variables: 'A1', constraints: [{ lhs: 'B1', rel: 'int', rhs: 'integer' }] }))).toMatchObject({ field: 'constraint', index: 0 });
  });
});

describe('runSolver', () => {
  it('solves across frames, keeps trial values out of the cells between them and can be stopped', async () => {
    const { wb, id } = book([[-1.2, 1], ['=100*(B1-A1^2)^2+(1-A1)^2']]);
    const p = prepareSolver(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', nonNegative: false }));
    const seen = [];
    const r = await runSolver(p, { sliceMs: 0, onProgress: () => seen.push(wb.getValue(id, 0, 0)), pause: () => Promise.resolve() });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((v) => v === -1.2)).toBe(true);
    expect(r.x[0]).toBeCloseTo(1, 3);
    const q = prepareSolver(wb, id, model({ objective: 'A2', goal: 'min', variables: 'A1:B1', nonNegative: false }));
    let k = 0;
    const stopped = await runSolver(q, { sliceMs: 0, onProgress: () => { if (++k === 5) q.cancelled = true; }, pause: () => Promise.resolve() });
    expect(stopped.status).toBe('stopped');
    expect(stopped.ok).toBe(true);
    expect(wb.getValue(id, 0, 0)).toBe(-1.2);
  });
});
