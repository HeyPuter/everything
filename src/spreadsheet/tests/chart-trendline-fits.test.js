import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { DEFAULT_TREND, fitTrend, normalizeTrend, normalizeTrendlines, trendEquationText, trendFor, trendName, trendNumber, trendPoints,
  trendProblem, trendRSquaredText } from '../src/core/trendline.js';

// Format Trendline offered a straight line only; these are the fits Excel offers beside it, checked against the
// sheet's own LINEST, LOGEST and RSQ over the same points.
const XS = [1, 2, 3, 4, 5, 6], YS = [2.1, 3.9, 8.2, 15.8, 26.1, 37.9];
const POINTS = XS.map((x, i) => [x, YS[i]]);
const fit = (type, extra = {}) => fitTrend(POINTS, normalizeTrend({ type, ...extra }));

/** A formula's value over the points: x in A1:A6, y in B1:B6. */
function sheetValue(formula) {
  const wb = new Workbook(), id = wb.activeSheetId;
  XS.forEach((x, r) => { wb.setInput(id, r, 0, String(x)); wb.setInput(id, r, 1, String(YS[r])); });
  wb.setInput(id, 0, 5, `=${formula}`);
  return wb.getValue(id, 0, 5);
}

describe('the fits', () => {
  it('fits a line as LINEST does, with RSQ for its R²', () => {
    const f = fit('linear');
    expect(f.terms.coefficients[1]).toBeCloseTo(sheetValue('INDEX(LINEST(B1:B6,A1:A6),1,1)'), 10);
    expect(f.terms.coefficients[0]).toBeCloseTo(sheetValue('INDEX(LINEST(B1:B6,A1:A6),1,2)'), 10);
    expect(f.r2).toBeCloseTo(sheetValue('RSQ(B1:B6,A1:A6)'), 10);
  });

  it('fits a polynomial as LINEST over the powers of x does', () => {
    for (const order of [2, 3, 4]) {
      const f = fit('poly', { order }), powers = Array.from({ length: order }, (_, k) => k + 1).join(',');
      for (let p = 0; p <= order; p++) {
        expect(f.terms.coefficients[p]).toBeCloseTo(sheetValue(`INDEX(LINEST(B1:B6,A1:A6^{${powers}}),1,${order + 1 - p})`), 6);
      }
      expect(f.r2).toBeCloseTo(sheetValue(`INDEX(LINEST(B1:B6,A1:A6^{${powers}},TRUE,TRUE),3,1)`), 8);
    }
  });

  it('fits an exponential as LOGEST does, its R² over ln y', () => {
    const f = fit('exp');
    expect(f.terms.a).toBeCloseTo(sheetValue('INDEX(LOGEST(B1:B6,A1:A6),1,2)'), 8);
    expect(f.terms.b).toBeCloseTo(Math.log(sheetValue('INDEX(LOGEST(B1:B6,A1:A6),1,1)')), 8);
    expect(f.r2).toBeCloseTo(sheetValue('RSQ(LN(B1:B6),A1:A6)'), 8);
  });

  it('fits a logarithmic curve over ln x and a power curve over ln x and ln y', () => {
    const log = fit('log');
    expect(log.terms.a).toBeCloseTo(sheetValue('SLOPE(B1:B6,LN(A1:A6))'), 8);
    expect(log.terms.b).toBeCloseTo(sheetValue('INTERCEPT(B1:B6,LN(A1:A6))'), 8);
    expect(log.r2).toBeCloseTo(sheetValue('RSQ(B1:B6,LN(A1:A6))'), 8);
    const power = fit('power');
    expect(power.terms.b).toBeCloseTo(sheetValue('SLOPE(LN(B1:B6),LN(A1:A6))'), 8);
    expect(power.terms.a).toBeCloseTo(Math.exp(sheetValue('INTERCEPT(LN(B1:B6),LN(A1:A6))')), 8);
    expect(power.r2).toBeCloseTo(sheetValue('RSQ(LN(B1:B6),LN(A1:A6))'), 8);
  });

  it('forces a fit through a set intercept, as LINEST without a constant fits y minus it', () => {
    const line = fit('linear', { intercept: 1 });
    expect(line.terms.coefficients[0]).toBe(1);
    expect(line.terms.coefficients[1]).toBeCloseTo(sheetValue('INDEX(LINEST(B1:B6-1,A1:A6,FALSE),1,1)'), 10);
    expect(line.r2).toBeCloseTo(sheetValue('INDEX(LINEST(B1:B6-1,A1:A6,FALSE,TRUE),3,1)'), 10);
    const exp = fit('exp', { intercept: 2 });
    expect(exp.terms.a).toBeCloseTo(2, 12);
    expect(exp.predict(0)).toBeCloseTo(2, 12);
  });

  it('averages each run of `period` points, from the period-th point on', () => {
    const f = fit('movingAvg', { period: 3 });
    expect(f.points).toEqual([[3, expect.closeTo(14.2 / 3, 10)], [4, expect.closeTo(27.9 / 3, 10)], [5, expect.closeTo(50.1 / 3, 10)], [6, expect.closeTo(79.8 / 3, 10)]]);
    expect(f.r2).toBeNull();
    expect(trendEquationText(f)).toBe('');
  });

  it('keeps a sixth-order fit over dates exact enough to draw', () => {
    const dates = Array.from({ length: 30 }, (_, i) => [45000 + i, 100 + 3 * i + 0.2 * i * i]);
    const f = fitTrend(dates, normalizeTrend({ type: 'poly', order: 6 }));
    for (const [x, y] of dates) expect(f.predict(x)).toBeCloseTo(y, 6);
    expect(f.r2).toBeCloseTo(1, 10);
  });

  it('declines what Excel declines, and says why', () => {
    const negative = [[1, 2], [2, -1], [3, 4]], atZero = [[0, 2], [1, 3], [2, 5]];
    expect(fitTrend(negative, normalizeTrend({ type: 'exp' }))).toBeNull();
    expect(trendProblem(negative, normalizeTrend({ type: 'exp' }))).toMatch(/exponential trendline needs every value above zero/);
    expect(fitTrend(atZero, normalizeTrend({ type: 'log' }))).toBeNull();
    expect(trendProblem(atZero, normalizeTrend({ type: 'log' }))).toMatch(/logarithmic trendline needs every x value above zero/);
    expect(trendProblem(atZero, normalizeTrend({ type: 'poly', order: 3 }))).toMatch(/at least 4 points/);
    expect(trendProblem(atZero, normalizeTrend({ type: 'movingAvg', period: 5 }))).toMatch(/at least 5/);
    expect(trendProblem(atZero, normalizeTrend({ type: 'exp', intercept: -1 }))).toMatch(/above zero/);
    expect(trendProblem(POINTS, normalizeTrend({ type: 'poly', order: 3 }))).toBeNull();
    expect(fitTrend([[2, 1], [2, 5]], DEFAULT_TREND)).toBeNull();
  });
});

describe('the forecast', () => {
  it('runs the fit forward and backward over the x it spans', () => {
    const f = fit('linear', { forward: 2, backward: 0.5 });
    expect([f.lo, f.hi]).toEqual([0.5, 8]);
    const pts = trendPoints(f);
    expect(pts.map(p => p[0])).toEqual([0.5, 8]);
    expect(trendPoints(fit('poly', { forward: 1 }), { count: 4 }).map(p => p[0])).toEqual([1, 2.5, 4, 5.5, 7]);
  });

  it('stops a logarithmic forecast short of zero, where the curve has no value', () => {
    expect(fit('log', { backward: 3 }).lo).toBe(1);
    expect(fit('log', { backward: 0.5 }).lo).toBe(0.5);
  });

  it('draws a straight fit by its ends, and a straight fit on a logarithmic axis as a curve', () => {
    expect(trendPoints(fit('linear'))).toHaveLength(2);
    expect(trendPoints(fit('linear'), { straight: false, count: 10 })).toHaveLength(11);
  });
});

describe('the equation', () => {
  it('writes numbers as a trendline label does in General', () => {
    expect(trendNumber(7.234321)).toBe('7.2343');
    expect(trendNumber(-9.65)).toBe('-9.65');
    expect(trendNumber(0)).toBe('0');
    expect(trendNumber(0.00006)).toBe('6E-05');
    expect(trendNumber(1.23456e12)).toBe('1.2346E+12');
    expect(trendNumber(0.5, v => `${v * 100}%`)).toBe('50%');
  });

  it('writes each kind\'s equation, highest power first, a negative term with a minus', () => {
    expect(trendEquationText(fit('linear'))).toBe('y = 7.2343x - 9.6533');
    expect(trendEquationText(fit('poly', { order: 2 }))).toBe('y = 1.3214x^2 - 2.0157x + 2.68');
    expect(trendEquationText(fit('exp'))).toMatch(/^y = 1\.2564e\^0\.595x$/);
    expect(trendEquationText(fit('log'))).toBe('y = 18.4262ln(x) - 4.5384');
    expect(trendEquationText(fit('power'))).toBe('y = 1.6353x^1.6587');
    expect(trendRSquaredText(fit('linear'))).toBe(`R² = ${trendNumber(sheetValue('RSQ(B1:B6,A1:A6)'))}`);
  });

  it('leaves off a coefficient of one and a term of zero', () => {
    expect(trendEquationText(fitTrend([[1, 2], [2, 3], [3, 4]], DEFAULT_TREND))).toBe('y = x + 1');
    expect(trendEquationText(fitTrend([[1, -1], [2, -2], [3, -3]], DEFAULT_TREND))).toBe('y = -x');
    expect(trendEquationText(fitTrend([[1, 5], [2, 5], [3, 5]], DEFAULT_TREND))).toBe('y = 5');
    expect(trendEquationText(fitTrend([[1, 0], [2, 0]], DEFAULT_TREND))).toBe('y = 0');
  });

  it('names a trendline for its kind and series unless it has a name of its own', () => {
    expect(trendName(normalizeTrend({ type: 'exp' }), 'Sales')).toBe('Expon. (Sales)');
    expect(trendName(normalizeTrend({ type: 'movingAvg', period: 4 }), 'Sales')).toBe('4 per. Mov. Avg. (Sales)');
    expect(trendName(normalizeTrend({ type: 'poly', name: 'Fit' }), 'Sales')).toBe('Fit');
  });
});

describe('the model', () => {
  it('holds every option to what Excel allows', () => {
    expect(normalizeTrend({ type: 'cubic', order: 9, period: 1, forward: -1, intercept: 'x', dispEq: 1, color: 'red', width: 99, dash: 'wavy' }))
      .toEqual({ type: 'linear', order: 2, period: 2, forward: 0, backward: 0, intercept: null, dispEq: false, dispRSqr: false, name: '' });
    expect(normalizeTrend({ type: 'poly', order: 6, color: '#AABBCC', width: 2, dash: 'sysDot', labelFormat: '0.00' }))
      .toMatchObject({ order: 6, color: '#aabbcc', width: 2, dash: 'sysDot', labelFormat: '0.00' });
  });

  it('draws a linear trendline on every series of a chart with trendlines and no list, as charts saved before kept them', () => {
    expect(trendFor({ trendline: true }, 3)).toBe(DEFAULT_TREND);
    expect(trendFor({ trendline: false, trendlines: [{ type: 'exp' }] }, 0)).toBeNull();
    const chart = { trendline: true, trendlines: normalizeTrendlines([{ type: 'exp' }, false]) };
    expect(trendFor(chart, 0).type).toBe('exp');
    expect(trendFor(chart, 1)).toBeNull();
    expect(trendFor(chart, 2)).toBe(DEFAULT_TREND);
  });
});
