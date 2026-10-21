import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { evaluate, globalValues, applyGlobals, deleteGlobal } from '../src/core/globals.js';

describe('formulas', () => {
  const vars = { 'Floor Height': 3200, Module: 1200, n: 4 };
  const look = (name) => {
    if (!(name in vars)) throw new Error(`No parameter named "${name}"`);
    return vars[name];
  };
  it('follow arithmetic precedence and functions', () => {
    expect(evaluate('1 + 2 * 3', look)).toBe(7);
    expect(evaluate('(1 + 2) * 3', look)).toBe(9);
    expect(evaluate('2 ^ 3 ^ 2', look)).toBe(512);
    expect(evaluate('-Module / 2 + max(n, 10)', look)).toBe(-590);
    expect(evaluate('Floor Height - 300', look)).toBe(2900);
    expect(evaluate('round(Module * n / 1000) * 1000', look)).toBe(5000);
  });
  it('report what they cannot read', () => {
    expect(() => evaluate('1 +', look)).toThrow();
    expect(() => evaluate('Height + 1', look)).toThrow(/No parameter/);
    expect(() => evaluate('1 / 0', look)).toThrow();
  });
});

describe('global parameters', () => {
  it('resolve formulas of each other and catch circular ones', () => {
    const { doc, add } = project();
    const a = add({ kind: 'globalParam', name: 'Floor Height', type: 'length', value: 3200 });
    const b = add({ kind: 'globalParam', name: 'Ceiling', type: 'length', formula: 'Floor Height - 500' });
    const c = add({ kind: 'globalParam', name: 'Loop', type: 'length', formula: 'Loop + 1', value: 7 });
    const v = globalValues(doc);
    expect(v.get(a.id).value).toBe(3200);
    expect(v.get(b.id).value).toBe(2700);
    expect(v.get(c.id).error).toBeTruthy();
  });

  it('drive associated element parameters', () => {
    const { doc, add, wall } = project();
    doc.solver = (drivers) => applyGlobals(doc, drivers);
    const g = add({ kind: 'globalParam', name: 'Wall Height', type: 'length', value: 2800 });
    const w = wall([0, 0], [4000, 0], { topLevelId: null });
    doc.transact('bind', () => doc.update(w.id, { bindings: { height: g.id } }));
    expect(doc.get(w.id).height).toBe(2800);
    doc.transact('change', () => doc.update(g.id, { value: 3500 }));
    expect(doc.get(w.id).height).toBe(3500);
    doc.undo();
    expect(doc.get(w.id).height).toBe(2800);
    doc.transact('delete', () => deleteGlobal(doc, g.id));
    expect(doc.get(w.id).bindings).toBeNull();
    expect(doc.get(w.id).height).toBe(2800);
  });
});
