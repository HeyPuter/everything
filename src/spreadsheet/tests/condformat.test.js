import { describe, it, expect } from 'vitest';
import { matchesRule, mixColors, scaleColor, describeRule, RULE_TYPES, iconFor, ICON_SETS, DATE_PERIODS, todaySerialUTC } from '../src/core/condformat.js';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';

describe('range-wide and formula rules', () => {
  function book(cells) {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    const at = (a1) => { const { r, c } = parseCellRef(a1); return wb.conditionalStyle(id, r, c, wb.getValue(id, r, c)); };
    return { wb, id, at };
  }

  it('flags duplicates and unique values case-insensitively', () => {
    const { wb, id, at } = book({ A1: 'x', A2: 'X', A3: 'y', A4: '', A5: '3', A6: '3' });
    wb.addRule(id, { range: parseRange('A1:A6'), type: 'dup', style: { bg: '#f00' } });
    expect(at('A1')).toEqual({ bg: '#f00' });
    expect(at('A2')).toEqual({ bg: '#f00' });
    expect(at('A3')).toBeNull();
    expect(at('A4')).toBeNull();
    expect(at('A6')).toEqual({ bg: '#f00' });
    wb.deleteRule(id, wb.sheet(id).rules[0].id);
    wb.addRule(id, { range: parseRange('A1:A6'), type: 'unique', style: { bold: true } });
    expect(at('A3')).toEqual({ bold: true });
    expect(at('A1')).toBeNull();
  });

  it('highlights the top and bottom N numbers', () => {
    const { wb, id, at } = book({ A1: '5', A2: '9', A3: '1', A4: '7', A5: 'text' });
    wb.addRule(id, { range: parseRange('A1:A5'), type: 'top', value: 2, style: { bg: '#0f0' } });
    expect(at('A2')).toEqual({ bg: '#0f0' });
    expect(at('A4')).toEqual({ bg: '#0f0' });
    expect(at('A1')).toBeNull();
    expect(at('A5')).toBeNull();
    wb.addRule(id, { range: parseRange('A1:A5'), type: 'bottom', value: 1, style: { color: '#00f' } });
    expect(at('A3')).toEqual({ color: '#00f' });
    wb.setInput(id, 2, 0, '100'); // A3 becomes the largest
    expect(at('A3')).toEqual({ bg: '#0f0' });
    expect(at('A1')).toEqual({ color: '#00f' }); // 5 is now the smallest
  });

  it('evaluates custom formulas relative to each cell, including blank ones', () => {
    const { wb, id, at } = book({ A1: 'Rent', B1: '100', C1: '80', A2: 'Food', B2: '50', C2: '70', A3: 'Fun', B3: '20', C3: '' });
    wb.addRule(id, { range: parseRange('A1:C3'), type: 'formula', value: '=$C1>$B1', style: { bg: '#fdd' } });
    expect(at('A1')).toBeNull();
    expect(at('A2')).toEqual({ bg: '#fdd' });
    expect(at('B2')).toEqual({ bg: '#fdd' });
    expect(at('C3')).toBeNull(); // blank C3 is 0, not > 20
    wb.addRule(id, { range: parseRange('C1:C3'), type: 'formula', value: '=ISBLANK(C1)', style: { bg: '#eee' } });
    expect(at('C3')).toEqual({ bg: '#eee' });
    expect(wb.evalRuleFormula(id, '=1/0', parseRange('A1:A1'), 0, 0)).toEqual({ error: '#DIV/0!' });
    expect(wb.evalRuleFormula(id, '=(', parseRange('A1:A1'), 0, 0)).toBeNull();
  });

  it('matches text beginnings and endings', () => {
    const { wb, id, at } = book({ A1: 'Apple pie', A2: 'Cherry pie', A3: 'Apple' });
    wb.addRule(id, { range: parseRange('A1:A3'), type: 'beginsWith', value: 'apple', style: { bold: true } });
    wb.addRule(id, { range: parseRange('A1:A3'), type: 'endsWith', value: 'PIE', style: { color: '#f00' } });
    expect(at('A1')).toEqual({ bold: true });
    expect(at('A2')).toEqual({ color: '#f00' });
    expect(at('A3')).toEqual({ bold: true });
  });
});

describe('alternating colors', () => {
  it('paints a header and two alternating fills, under other rules', () => {
    // The banding is the table-like coat a cell's own fill lies over, so its fills carry the `coat` mark; a rule's fill does not.
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (let r = 0; r < 5; r++) wb.setInput(id, r, 0, String(r));
    const at = (r) => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0));
    wb.addRule(id, { range: parseRange('A1:B5'), type: 'bands', style: {}, header: true, headerColor: '#aaa', color1: '#111', color2: '#222' });
    expect(at(0)).toEqual({ bg: '#aaa', bold: true, coat: true });
    expect(at(1)).toEqual({ bg: '#111', coat: true });
    expect(at(2)).toEqual({ bg: '#222', coat: true });
    expect(at(3)).toEqual({ bg: '#111', coat: true });
    expect(wb.conditionalStyle(id, 4, 1, null)).toEqual({ bg: '#222', coat: true }); // blank cells too
    expect(at(5)).toBeNull();
    wb.addRule(id, { range: parseRange('A1:B5'), type: 'gt', value: 2, style: { bg: '#f00' } });
    expect(at(3)).toEqual({ bg: '#f00' }); // a matching rule wins over the banding
    expect(at(1)).toEqual({ bg: '#111', coat: true });
    wb.updateRule(id, wb.sheet(id).rules[0].id, { header: false });
    expect(at(0)).toEqual({ bg: '#111', coat: true });
  });
});

describe('matchesRule', () => {
  const r = (type, value, value2) => ({ type, value, value2 });
  it('compares numbers, including numeric text', () => {
    expect(matchesRule(r('gt', 10), 11)).toBe(true);
    expect(matchesRule(r('gt', 10), 10)).toBe(false);
    expect(matchesRule(r('gte', 10), 10)).toBe(true);
    expect(matchesRule(r('lt', '10'), 9)).toBe(true);
    expect(matchesRule(r('lte', 10), 10)).toBe(true);
    expect(matchesRule(r('between', 5, 1), 3)).toBe(true);
    expect(matchesRule(r('between', 1, 5), 6)).toBe(false);
    expect(matchesRule(r('gt', 10), 'text')).toBe(false);
    expect(matchesRule(r('gt', 10), { error: '#DIV/0!' })).toBe(false);
    expect(matchesRule(r('gt', 'abc'), 5)).toBe(false);
  });

  it('handles equality, text, and emptiness', () => {
    expect(matchesRule(r('eq', 5), '5')).toBe(true);
    expect(matchesRule(r('eq', 'Rent'), 'rent')).toBe(true);
    expect(matchesRule(r('neq', 'Rent'), 'Food')).toBe(true);
    expect(matchesRule(r('eq', ''), null)).toBe(false);
    expect(matchesRule(r('contains', 'en'), 'Rent')).toBe(true);
    expect(matchesRule(r('contains', ''), 'Rent')).toBe(false);
    expect(matchesRule(r('notContains', 'x'), 'Rent')).toBe(true);
    expect(matchesRule(r('empty'), null)).toBe(true);
    expect(matchesRule(r('empty'), '')).toBe(true);
    expect(matchesRule(r('notEmpty'), 0)).toBe(true);
  });

  it('mixes colors and describes rules', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColors('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(mixColors('#ff0000', '#0000ff', 2)).toBe('#0000ff');
    expect(scaleColor({ from: '#000000', to: '#ffffff' }, 5, 0, 10)).toBe('#7f7f7f');
    expect(scaleColor({}, 5, 5, 5)).toBe('#4a8dff');
    expect(scaleColor({}, 'x', 0, 10)).toBeNull();
    // Three stops: the midpoint color sits at the middle of the value span.
    const three = { from: '#000000', mid: '#ff0000', to: '#ffffff' };
    expect(scaleColor(three, 5, 0, 10)).toBe('#ff0000');
    expect(scaleColor(three, 2.5, 0, 10)).toBe('#7f0000');
    expect(scaleColor(three, 7.5, 0, 10)).toBe('#ff7f7f');
    expect(scaleColor(three, 0, 0, 10)).toBe('#000000');
    expect(scaleColor(three, 10, 0, 10)).toBe('#ffffff');
    expect(scaleColor(three, 4, 4, 4)).toBe('#ffffff');
    expect(describeRule({ type: 'scale', mid: '#ff0000' })).toBe('Three-color scale');
    expect(describeRule({ type: 'between', value: 1, value2: 5 })).toBe('Between 1 and 5');
    expect(describeRule({ type: 'gt', value: 3 })).toBe('Greater than 3');
    expect(describeRule({ type: 'scale' })).toBe('Color scale');
    expect(RULE_TYPES.length).toBeGreaterThan(8);
  });
});

describe('workbook rules', () => {
  function book(cells) {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, v] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, v); }
    return { wb, id };
  }

  it('applies the first matching rule and scales', () => {
    const { wb, id } = book({ A1: '5', A2: '50', A3: '500', A4: 'x', B1: '1', B2: '3' });
    wb.addRule(id, { range: parseRange('A1:A4'), type: 'gt', value: 100, style: { bg: '#ff0000', bold: true } });
    wb.addRule(id, { range: parseRange('A1:A4'), type: 'gt', value: 10, style: { bg: '#00ff00' } });
    wb.addRule(id, { range: parseRange('B1:B2'), type: 'scale', from: '#000000', to: '#ffffff' });
    const at = (a1) => { const { r, c } = parseCellRef(a1); return wb.conditionalStyle(id, r, c, wb.getValue(id, r, c)); };
    expect(at('A1')).toBeNull();
    expect(at('A2')).toEqual({ bg: '#00ff00' });
    expect(at('A3')).toEqual({ bg: '#ff0000', bold: true });
    expect(at('A4')).toBeNull();
    expect(at('B1')).toEqual({ bg: '#000000' });
    expect(at('B2')).toEqual({ bg: '#ffffff' });
    expect(wb.conditionalStyle(id, 9, 9, 1)).toBeNull();
  });

  it('updates, deletes, undoes, follows structure, and serializes', () => {
    const { wb, id } = book({ A1: '5' });
    const ruleId = wb.addRule(id, { range: parseRange('A1:A5'), type: 'gt', value: 1, style: { bg: '#eee' } });
    expect(wb.sheets[0].rules).toHaveLength(1);
    wb.updateRule(id, ruleId, { value: 10 });
    expect(wb.conditionalStyle(id, 0, 0, 5)).toBeNull();
    wb.undo();
    expect(wb.conditionalStyle(id, 0, 0, 5)).toEqual({ bg: '#eee' });
    wb.insertRows(id, 0, 2);
    expect(wb.sheets[0].rules[0].range).toEqual({ r1: 2, c1: 0, r2: 6, c2: 0 });
    wb.deleteRows(id, 0, 10);
    expect(wb.sheets[0].rules).toHaveLength(0);
    wb.undo();
    expect(wb.sheets[0].rules).toHaveLength(1);
    const copy = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(copy.sheets[0].rules[0]).toMatchObject({ type: 'gt', value: 1, range: { r1: 2, c1: 0, r2: 6, c2: 0 } });
    wb.deleteRule(id, ruleId);
    expect(wb.sheets[0].rules).toHaveLength(0);
    wb.undo();
    expect(wb.sheets[0].rules).toHaveLength(1);
  });
});

describe('data bars', () => {
  it('sizes bars from zero for positive ranges and from the minimum with negatives', async () => {
    const { dataBar, describeRule } = await import('../src/core/condformat.js');
    const rule = { type: 'databar', barColor: '#ff0000' };
    expect(dataBar(rule, 50, 10, 100)).toEqual({ bar: 0.5, barColor: '#ff0000' });
    expect(dataBar(rule, 100, 10, 100).bar).toBe(1);
    expect(dataBar(rule, 0, 10, 100).bar).toBe(0);
    expect(dataBar(rule, -5, -10, 10)).toEqual({ bar: 0.25, barColor: '#ff0000' });
    expect(dataBar(rule, 7, 7, 7).bar).toBe(1);
    expect(dataBar(rule, 'x', 0, 10)).toBeNull();
    expect(dataBar({ type: 'databar' }, 5, 0, 10).barColor).toBe('#8fb8ff');
    expect(describeRule({ type: 'databar' })).toBe('Data bar');
  });

  it('is applied by the workbook alongside other rules', async () => {
    const { Workbook } = await import('../src/core/workbook.js');
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    [10, 20, 40].forEach((v, i) => wb.setInput(id, i, 0, String(v)));
    wb.addRule(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'databar', barColor: '#9fdcb4', style: {} });
    wb.addRule(id, { range: { r1: 0, c1: 0, r2: 2, c2: 0 }, type: 'gt', value: 30, style: { bold: true } });
    expect(wb.conditionalStyle(id, 0, 0, 10)).toEqual({ bar: 0.25, barColor: '#9fdcb4' });
    expect(wb.conditionalStyle(id, 2, 0, 40)).toEqual({ bar: 1, barColor: '#9fdcb4', bold: true });
    expect(wb.conditionalStyle(id, 5, 0, null)).toBeNull();
  });
});

describe('icon sets', () => {
  it.each(['constructor', '__proto__', 'toString', 'unknown'])('falls back safely for an imported icon set named %s', (set) => {
    expect(iconFor({ type: 'icons', set }, 10, 0, 10)).toEqual(iconFor({ type: 'icons', set: 'arrows' }, 10, 0, 10));
    expect(describeRule({ type: 'icons', set })).toBe(describeRule({ type: 'icons', set: 'arrows' }));
  });

  it('picks the top, middle, or bottom glyph by percent of the range', () => {
    const rule = { type: 'icons', set: 'arrows' };
    expect(iconFor(rule, 10, 0, 10)).toEqual({ icon: '▲', iconColor: '#1baf7a', iconOnly: false });
    expect(iconFor(rule, 5, 0, 10)).toMatchObject({ icon: '▶' });
    expect(iconFor(rule, 1, 0, 10)).toMatchObject({ icon: '▼' });
    expect(iconFor({ type: 'icons', set: 'stars', lo: 50, hi: 90, iconOnly: true }, 6, 0, 10)).toEqual({ icon: '★★☆', iconColor: '#eda100', iconOnly: true });
    expect(iconFor(rule, 'x', 0, 10)).toBeNull();
    expect(iconFor(rule, 4, 4, 4)).toMatchObject({ icon: '▲' });
    expect(describeRule({ type: 'icons', set: 'traffic' })).toBe('Icon set: Traffic lights');
    expect(Object.keys(ICON_SETS)).toContain('checks');
  });
});

describe('date rules', () => {
  // 46085 is 2026-03-04, a Wednesday.
  const today = 46085;
  const is = (period, day) => matchesRule({ type: 'date', value: period }, day, { today });
  it('tests a day against named periods relative to today', () => {
    expect(is('today', today)).toBe(true);
    expect(is('today', today + 0.75)).toBe(true);
    expect(is('yesterday', today - 1)).toBe(true);
    expect(is('tomorrow', today + 1)).toBe(true);
    expect(is('last7', today - 6)).toBe(true);
    expect(is('last7', today - 7)).toBe(false);
    expect(is('next7', today + 6)).toBe(true);
    expect(is('thisWeek', today - 3)).toBe(true); // Sunday: weeks run Sunday to Saturday, as in Excel
    expect(is('thisWeek', today - 4)).toBe(false); // Saturday before
    expect(is('lastWeek', today - 4)).toBe(true);
    expect(is('thisMonth', today - 3)).toBe(true); // 1 March
    expect(is('thisMonth', today - 4)).toBe(false); // 28 February
    expect(is('lastMonth', today - 4)).toBe(true);
    expect(is('thisYear', today + 200)).toBe(true);
    expect(is('past', today - 400)).toBe(true);
    expect(is('future', today - 400)).toBe(false);
    expect(is('today', 'text')).toBe(false);
    expect(DATE_PERIODS.map((p) => p.value)).toContain('lastMonth');
    expect(describeRule({ type: 'date', value: 'last7' })).toBe('Date is in the last 7 days');
    expect(todaySerialUTC(new Date(2026, 2, 4))).toBe(today);
  });
});

describe('rule order', () => {
  it('moves a rule up or down, earlier rules winning where they overlap, with undo', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, '5');
    const a = wb.addRule(id, { range: parseRange('A1:A1'), type: 'gt', value: 1, style: { bg: '#ff0000' } });
    const b = wb.addRule(id, { range: parseRange('A1:A1'), type: 'gt', value: 2, style: { bg: '#00ff00' } });
    expect(wb.conditionalStyle(id, 0, 0, 5).bg).toBe('#ff0000');
    expect(wb.moveRule(id, b, -1)).toBe(true);
    expect(wb.sheet(id).rules.map((r) => r.id)).toEqual([b, a]);
    expect(wb.conditionalStyle(id, 0, 0, 5).bg).toBe('#00ff00');
    expect(wb.moveRule(id, b, -1)).toBe(false);
    wb.undo();
    expect(wb.sheet(id).rules.map((r) => r.id)).toEqual([a, b]);
  });
});
