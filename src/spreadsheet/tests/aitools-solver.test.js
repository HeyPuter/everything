import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, callTarget, changesWorkbook } from '../src/core/aitools.js';
import { readSolverModel, hasSolverModel } from '../src/core/solver.js';

// max 3x + 5y with x <= 4, 2y <= 12, 3x + 2y <= 18: the best is x = 2, y = 6, worth 36.
function production() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  wb.setInput(id, 0, 0, 'x'); wb.setInput(id, 0, 1, '1');
  wb.setInput(id, 1, 0, 'y'); wb.setInput(id, 1, 1, '1');
  wb.setInput(id, 0, 2, '=2*B2');
  wb.setInput(id, 1, 2, '=3*B1+2*B2');
  wb.setInput(id, 3, 0, 'Profit'); wb.setInput(id, 3, 1, '=3*B1+5*B2');
  wb.clearHistory();
  return { wb, id, env, run: (name, args, e = env) => runTool(wb, name, args, e) };
}

const MODEL = {
  objective: 'B4', goal: 'max', variables: 'B1:B2', method: 'simplex',
  constraints: [{ cell: 'B1', relation: '<=', value: 4 }, { cell: 'C1', relation: '<=', value: 12 }, { cell: 'C2', relation: '<=', value: '18' }],
};

describe('solve', () => {
  it('finds the optimum, keeps it as one undo step and saves the model for the Solver dialog', async () => {
    const { wb, id, env, run } = production();
    expect(changesWorkbook('solve')).toBe(true);
    const pending = run('solve', MODEL);
    expect(typeof pending.then).toBe('function');
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(wb.getValue(id, 0, 1)).toBeCloseTo(2, 9);
    expect(wb.getValue(id, 1, 1)).toBeCloseTo(6, 9);
    expect(wb.getValue(id, 3, 1)).toBeCloseTo(36, 9);
    const out = JSON.parse(res.content);
    expect(out.status).toBe('optimal');
    expect(out.kept).toMatch(/kept/);
    expect(out.objective).toMatchObject({ cell: 'Sheet1!B4', value: '36', before: 8 });
    expect(out.variables).toEqual([{ cell: 'Sheet1!B1', value: '2' }, { cell: 'Sheet1!B2', value: '6' }]);
    expect(out.method).toBe('Simplex LP');
    expect(res.target).toEqual({ sheetId: id, range: { r1: 0, c1: 1, r2: 1, c2: 1 } });
    expect(callTarget(wb, 'solve', MODEL, env).range).toEqual({ r1: 0, c1: 1, r2: 1, c2: 1 });
    // The dialog opens the model the assistant ran.
    const saved = readSolverModel(wb, id);
    expect(saved).toMatchObject({ objective: '$B$4', goal: 'max', variables: '$B$1:$B$2', engine: 'simplex' });
    expect(wb.names.find((n) => n.name === 'solver_adj')).toMatchObject({ ref: 'Sheet1!$B$1:$B$2', hidden: true, sheet: 'Sheet1' });
    expect(saved.constraints).toEqual([{ lhs: '$B$1', rel: '<=', rhs: '4' }, { lhs: '$C$1', rel: '<=', rhs: '12' }, { lhs: '$C$2', rel: '<=', rhs: '18' }]);
    // The time limit bounded the run; the model keeps the options it had.
    expect(saved.options.maxTime).toBe(null);
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    wb.undo();
    expect(wb.getValue(id, 0, 1)).toBe(1);
    expect(hasSolverModel(wb, id)).toBe(false);
  });

  it('runs the model saved on the sheet when no objective is given, with what the call changes', async () => {
    const { wb, id, run } = production();
    await run('solve', MODEL);
    wb.setInput(id, 0, 1, '0'); wb.setInput(id, 1, 1, '0');
    const res = await run('solve', { goal: 'min' });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content).objective.value).toBe('0');
    expect(readSolverModel(wb, id).goal).toBe('min');
    const blank = production();
    const none = await blank.run('solve', {});
    expect(none.ok).toBe(false);
    expect(none.content).toMatch(/No Solver model is saved on Sheet1/);
  });

  it('solves a smooth nonlinear model, with and without the nonnegative assumption', async () => {
    const { wb, id, run } = production();
    wb.setInput(id, 5, 1, '=(B1-3)^2+(B2+1)^2');
    const free = await run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', non_negative: false });
    expect(free.ok).toBe(true);
    expect(wb.getValue(id, 0, 1)).toBeCloseTo(3, 3);
    expect(wb.getValue(id, 1, 1)).toBeCloseTo(-1, 3);
    await run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2' });
    expect(wb.getValue(id, 1, 1)).toBeCloseTo(0, 3);
  });

  it('leaves the cells as they were when no solution meets the constraints, and says so', async () => {
    const { wb, id, run } = production();
    const res = await run('solve', { ...MODEL, constraints: [{ cell: 'B1', relation: '>=', value: 5 }, { cell: 'B1', relation: '<=', value: 3 }] });
    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content);
    expect(out.status).toBe('infeasible');
    expect(out.message).toMatch(/could not find a solution/);
    expect(out.kept).toMatch(/no solution to keep/);
    expect(wb.getValue(id, 0, 1)).toBe(1);
    expect(wb.getValue(id, 1, 1)).toBe(1);
  });

  it('reports the solution without keeping it when asked', async () => {
    const { wb, id, run } = production();
    const res = await run('solve', { ...MODEL, keep: false });
    const out = JSON.parse(res.content);
    expect(out.values_found.map((v) => Math.round(v.value))).toEqual([2, 6]);
    expect(out.objective.value).toBeCloseTo(36, 6);
    expect(out.kept).toMatch(/not kept/);
    expect(wb.getValue(id, 0, 1)).toBe(1);
    expect(wb.getValue(id, 1, 1)).toBe(1);
  });

  it('changes nothing once the user has stopped the assistant', async () => {
    const { wb, id, run, env } = production();
    const res = await run('solve', MODEL, { ...env, stopped: () => true });
    expect(res.changed).toBe(false);
    expect(JSON.parse(res.content.split('\n')[0]).stopped).toMatch(/nothing was changed/);
    expect(wb.getValue(id, 0, 1)).toBe(1);
    expect(hasSolverModel(wb, id)).toBe(false);
  });

  it('changes nothing when the workbook changed while it worked', async () => {
    const { wb, id, run, env } = production();
    let edited = false;
    const res = await run('solve', MODEL, { ...env, stopped: () => { if (!edited) { edited = true; wb.setInput(id, 9, 9, 'typed meanwhile'); } return false; } });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/workbook changed while Solver was running/);
    expect(wb.getValue(id, 0, 1)).toBe(1);
    expect(hasSolverModel(wb, id)).toBe(false);
  });

  it('leaves a variable cell the user typed into between its slices, and rows inserted meanwhile, as the user left them', async () => {
    const realNow = Date.now;
    let now = 0;
    // The clock leaps 50ms at each look, so every slice is one step and a pause follows it.
    Date.now = () => (now += 50);
    try {
      for (const edit of [
        (wb, id) => wb.setInput(id, 0, 1, '7'),
        (wb, id) => wb.insertRows(id, 0, 1),
      ]) {
        const { wb, id, run } = production();
        wb.setInput(id, 5, 1, '=(B1-3)^2+(B2+1)^2');
        const pending = run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', max_seconds: 120 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        edit(wb, id);
        const typed = [0, 1, 2].map((r) => wb.getValue(id, r, 1));
        const res = await pending;
        expect(res.content).toMatch(/workbook changed while Solver was running/);
        expect([0, 1, 2].map((r) => wb.getValue(id, r, 1))).toEqual(typed);
        expect(hasSolverModel(wb, id)).toBe(false);
      }
    } finally { Date.now = realNow; }
  });

  it('goes on when the user only scrolls past the last row or zooms while it works', async () => {
    const realNow = Date.now;
    let now = 0;
    Date.now = () => (now += 50);
    try {
      const { wb, id, run } = production();
      wb.setInput(id, 5, 1, '=(B1-3)^2+(B2+1)^2');
      wb.clearHistory();
      const pending = run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', max_seconds: 120 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      wb.ensureSize(id, wb.sheet(id).rows + 100, wb.sheet(id).cols);
      wb.setSheetView(id, { viewZoom: 1.5 });
      const res = await pending;
      expect(res.ok).toBe(true);
      expect(wb.getValue(id, 0, 1)).toBeCloseTo(3, 3);
      expect(wb.undoLabels(5)).toEqual(['AI edit']);
    } finally { Date.now = realNow; }
  });

  it('adds its reports without taking the user back from the sheet they went to while it worked', async () => {
    const realNow = Date.now;
    let now = 0;
    Date.now = () => (now += 50);
    try {
      const { wb, id, run } = production();
      const other = wb.addSheet('Other');
      wb.setActiveSheet(id);
      wb.setInput(id, 5, 1, '=(B1-3)^2+(B2+1)^2');
      const pending = run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', max_seconds: 120, reports: ['answer'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      wb.setActiveSheet(other.id);
      const res = await pending;
      expect(JSON.parse(res.content).reports_added).toEqual(['Answer Report 1']);
      expect(wb.activeSheetId).toBe(other.id);
    } finally { Date.now = realNow; }
  });

  it('waits for the entry the user is typing to end before it keeps the solution', async () => {
    const { wb, id, env, run } = production();
    let done;
    const waiting = vi.fn();
    const typing = { ...env, whenIdle: () => new Promise((resolve) => { done = resolve; }), waiting };
    let settled = false;
    const pending = run('solve', MODEL, typing).then((res) => { settled = true; return res; });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(waiting).toHaveBeenCalledWith('Waiting for you to finish the cell you are typing in');
    expect(wb.getValue(id, 0, 1)).toBe(1);
    // The entry is cancelled: nothing changed meanwhile, so the solution goes in.
    done();
    expect((await pending).ok).toBe(true);
    expect(wb.getValue(id, 0, 1)).toBeCloseTo(2, 9);
    // An entry committed meanwhile changes the workbook, and the solution is not kept over it.
    const again = production();
    const waitAgain = again.run('solve', MODEL, { ...again.env, whenIdle: () => new Promise((resolve) => { done = resolve; }) });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    again.wb.setInput(again.id, 0, 1, '3');
    done();
    expect((await waitAgain).content).toMatch(/workbook changed while Solver was running/);
    expect(again.wb.getValue(again.id, 0, 1)).toBe(3);
  });

  it('refuses variable cells that hold formulas, are protected, or lie on another sheet', async () => {
    const { wb, id, run } = production();
    expect((await run('solve', { ...MODEL, variables: 'B1:C1' })).content).toMatch(/^Error: variables: The variable cell \$C\$1 holds a formula/);
    wb.addSheet('Other');
    expect((await run('solve', { ...MODEL, variables: 'Other!A1' })).content).toMatch(/variables: .*on this sheet.*the model is on Sheet1/);
    wb.protectRange(id, { r1: 1, c1: 1, r2: 1, c2: 1 });
    expect((await run('solve', MODEL)).content).toMatch(/protected range/);
    expect(wb.getValue(id, 1, 1)).toBe(1);
    const p = production();
    p.wb.setSheetProtected(p.id, true);
    expect((await p.run('solve', MODEL)).content).toMatch(/protected/);
  });

  it('checks its arguments in words the model can act on', async () => {
    const { run } = production();
    expect((await run('solve', { ...MODEL, method: 'magic' })).content).toMatch(/method must be one of grg, simplex, evolutionary/);
    expect((await run('solve', { ...MODEL, constraints: [{ cell: 'B1', relation: '<' , value: 1 }] })).content).toMatch(/Constraint 1: relation must be one of/);
    expect((await run('solve', { ...MODEL, constraints: [{ cell: 'B1', relation: '<=' }] })).content).toMatch(/Constraint 1 \(<=\) needs a value/);
    expect((await run('solve', { ...MODEL, goal: 'value' })).content).toMatch(/number the objective should equal/);
    expect((await run('solve', { ...MODEL, max_seconds: 1000 })).content).toMatch(/max_seconds must be/);
    expect((await run('solve', { ...MODEL, objective: 'B4:B5' })).content).toMatch(/objective must be one cell/);
  });

  it('takes integer constraints and reaches a value', async () => {
    const { wb, id, run } = production();
    const res = await run('solve', { objective: 'B4', goal: 'value', value: 13, variables: 'B1:B2', method: 'simplex', constraints: [{ cell: 'B1:B2', relation: 'int' }, { cell: 'B1', relation: '>=', value: 1 }, { cell: 'B2', relation: '>=', value: 1 }] });
    expect(JSON.parse(res.content).status).toMatch(/optimal/);
    const x = wb.getValue(id, 0, 1), y = wb.getValue(id, 1, 1);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    expect(3 * x + 5 * y).toBe(13);
  });

  it('adds the reports asked for before the model\'s sheet', async () => {
    const { wb, run } = production();
    const res = await run('solve', { ...MODEL, reports: ['answer', 'sensitivity'] });
    const out = JSON.parse(res.content);
    expect(out.reports_added).toEqual(['Answer Report 1', 'Sensitivity Report 1']);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Answer Report 1', 'Sensitivity Report 1', 'Sheet1']);
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
  });

  it('restores the values found when it stops at the time limit, unless told to keep them', async () => {
    const { wb, id, run } = production();
    wb.setInput(id, 5, 1, '=ABS(B1-3)+ABS(B2-2)');
    const bounds = [{ cell: 'B1:B2', relation: '<=', value: 10 }];
    let now = 0;
    const realNow = Date.now;
    // The clock leaps a second at each look, so the limit of one second is reached at once.
    Date.now = () => (now += 1000);
    try {
      const res = await run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', method: 'evolutionary', constraints: bounds, max_seconds: 1 });
      const out = JSON.parse(res.content);
      expect(out.status).toBe('timeLimit');
      expect(out.kept).toMatch(/keep_best_found/);
      expect(wb.getValue(id, 0, 1)).toBe(1);
      // The best found so far is where it began; kept, it leaves the cells as they are.
      const again = await run('solve', { objective: 'B6', goal: 'min', variables: 'B1:B2', method: 'evolutionary', constraints: bounds, max_seconds: 1, keep_best_found: true });
      expect(JSON.parse(again.content.split('\n')[0]).kept).toMatch(/was kept/);
    } finally { Date.now = realNow; }
  });

  it('asks before replacing the variable cells\' values or another saved model', async () => {
    const { wb, env, run } = production();
    const d = describeCall(wb, 'solve', MODEL, env);
    expect(d.label).toBe('Solve: maximize Sheet1!B4 by changing Sheet1!B1:B2');
    expect(d.destructive).toBe(true);
    expect(d.detail).toBe('Replaces the values in 2 variable cells with the solution, if one is found.');
    expect(describeCall(wb, 'solve', { ...MODEL, keep: false }, env).destructive).toBe(false);
    await run('solve', MODEL);
    expect(describeCall(wb, 'solve', { ...MODEL, keep: false, variables: '$B$1:$B$2' }, env).destructive).toBe(false);
    const other = describeCall(wb, 'solve', { ...MODEL, keep: false, goal: 'min' }, env);
    expect(other.destructive).toBe(true);
    expect(other.detail).toBe('Replaces the Solver model saved on Sheet1.');
    expect(describeCall(wb, 'solve', { goal: 'min' }, env).label).toBe('Solve: minimize Sheet1!B4 by changing Sheet1!B1:B2');
  });
});
