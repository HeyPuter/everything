import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as A from '../src/core/analysis-tools.js';

/** The cell value of a layout at (r, c). */
const at = (layout, r, c) => {
  const cell = layout.cells[r]?.[c];
  return cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell;
};
/** The value beside the first cell in column `c` that reads `label`. */
const row = (layout, label, c = 0) => layout.cells.findIndex((cells) => at({ cells: [cells] }, 0, c) === label);
const beside = (layout, label, k = 1, c = 0) => at(layout, row(layout, label, c), c + k);

/** A workbook with columns of numbers from A1, and a way to work a formula out in it. */
function sheetWith(columns) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  columns.forEach((col, c) => col.forEach((v, r) => { if (v != null) wb.setInput(id, r, c, String(v)); }));
  wb.clearHistory();
  const fx = (formula) => { wb.setInput(id, 200, 30, `=${formula}`); return wb.getValue(id, 200, 30); };
  return { wb, id, fx };
}
const g = (label, values) => ({ label, values });

const A1 = [12, 15, 9, 20, 17];
const B1 = [14, 18, 22, 16, 25, 19];
const C1 = [8, 11, 10, 13];

describe('Anova', () => {
  it('single factor matches sums of squares worked out by hand and F.DIST.RT', () => {
    const layout = A.anovaSingleFactor([g('A', A1), g('B', B1), g('C', C1)], { alpha: 0.05 });
    const all = [...A1, ...B1, ...C1];
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gm = mean(all);
    const ssb = [A1, B1, C1].reduce((s, xs) => s + xs.length * (mean(xs) - gm) ** 2, 0);
    const ssw = [A1, B1, C1].reduce((s, xs) => s + xs.reduce((t, x) => t + (x - mean(xs)) ** 2, 0), 0);
    expect(beside(layout, 'Between Groups', 1)).toBeCloseTo(ssb, 10);
    expect(beside(layout, 'Within Groups', 1)).toBeCloseTo(ssw, 10);
    expect(beside(layout, 'Between Groups', 2)).toBe(2);
    expect(beside(layout, 'Within Groups', 2)).toBe(all.length - 3);
    expect(beside(layout, 'Total', 1)).toBeCloseTo(ssb + ssw, 10);
    const F = (ssb / 2) / (ssw / (all.length - 3));
    expect(beside(layout, 'Between Groups', 4)).toBeCloseTo(F, 10);
    const { fx } = sheetWith([]);
    expect(beside(layout, 'Between Groups', 5)).toBeCloseTo(fx(`F.DIST.RT(${F},2,${all.length - 3})`), 12);
    expect(beside(layout, 'Between Groups', 6)).toBeCloseTo(fx(`F.INV.RT(0.05,2,${all.length - 3})`), 12);
    // The summary rows: count, sum, average, sample variance.
    const r = row(layout, 'B');
    expect(layout.cells[r].slice(1)).toEqual([6, 114, 19, expect.closeTo(fx('VAR.S(14,18,22,16,25,19)'), 12)]);
  });

  it('single factor refuses a lone group and a bad alpha', () => {
    expect(A.anovaSingleFactor([g('A', A1)]).error).toMatch(/two groups/);
    expect(A.anovaSingleFactor([g('A', A1), g('B', B1)], { alpha: 2 }).error).toMatch(/Alpha/);
  });

  it('two factors with replication split the sums of squares', () => {
    // Two samples (rows) of 2 replicates, three columns.
    const block = [[null, 'P', 'Q', 'R'], ['S1', 4, 6, 8], [null, 5, 7, 9], ['S2', 6, 9, 13], [null, 7, 8, 12]];
    const layout = A.anovaTwoFactorReplication(block, { rowsPerSample: 2 });
    const data = { S1: [[4, 5], [6, 7], [8, 9]], S2: [[6, 7], [9, 8], [13, 12]] };
    const all = Object.values(data).flat(2);
    const m = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gm = m(all);
    const ssRows = 3 * 2 * Object.values(data).reduce((s, cols) => s + (m(cols.flat()) - gm) ** 2, 0);
    const ssCols = 2 * 2 * [0, 1, 2].reduce((s, j) => s + (m([...data.S1[j], ...data.S2[j]]) - gm) ** 2, 0);
    const ssWithin = Object.values(data).flat().reduce((s, cell) => s + cell.reduce((t, x) => t + (x - m(cell)) ** 2, 0), 0);
    const ssTotal = all.reduce((s, x) => s + (x - gm) ** 2, 0);
    expect(beside(layout, 'Sample', 1)).toBeCloseTo(ssRows, 10);
    expect(beside(layout, 'Columns', 1)).toBeCloseTo(ssCols, 10);
    expect(beside(layout, 'Within', 1)).toBeCloseTo(ssWithin, 10);
    expect(beside(layout, 'Interaction', 1)).toBeCloseTo(ssTotal - ssRows - ssCols - ssWithin, 10);
    expect(beside(layout, 'Interaction', 2)).toBe(2);
    expect(beside(layout, 'Within', 2)).toBe(6);
    expect(A.anovaTwoFactorReplication(block, { rowsPerSample: 3 }).error).toMatch(/divide evenly/);
  });

  it('two factors without replication', () => {
    const rows = [[3, 5, 7], [4, 6, 9], [2, 4, 5], [5, 8, 10]];
    const layout = A.anovaTwoFactor(rows, {});
    const all = rows.flat();
    const m = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gm = m(all);
    const ssr = 3 * rows.reduce((s, r) => s + (m(r) - gm) ** 2, 0);
    const ssc = 4 * [0, 1, 2].reduce((s, j) => s + (m(rows.map((r) => r[j])) - gm) ** 2, 0);
    const sst = all.reduce((s, x) => s + (x - gm) ** 2, 0);
    expect(beside(layout, 'Rows', 1)).toBeCloseTo(ssr, 10);
    expect(beside(layout, 'Columns', 1)).toBeCloseTo(ssc, 10);
    expect(beside(layout, 'Error', 1)).toBeCloseTo(sst - ssr - ssc, 10);
    expect(beside(layout, 'Error', 2)).toBe(6);
    expect(beside(layout, 'Row 2', 2)).toBe(19);
  });
});

describe('Correlation, covariance, descriptive statistics', () => {
  const x = [2, 4, 5, 7, 9, 12], y = [1, 3, 2, 6, 8, 9], z = [10, 8, 9, 5, 4, 1];
  it('match CORREL and COVARIANCE.P', () => {
    const { fx } = sheetWith([x, y, z]);
    const corr = A.correlation([g('x', x), g('y', y), g('z', z)]);
    expect(at(corr, 0, 1)).toBe('x');
    expect(at(corr, 1, 1)).toBe(1);
    expect(at(corr, 2, 1)).toBeCloseTo(fx('CORREL(A1:A6,B1:B6)'), 14);
    expect(at(corr, 3, 2)).toBeCloseTo(fx('CORREL(B1:B6,C1:C6)'), 14);
    expect(at(corr, 1, 2)).toBeUndefined(); // the upper triangle stays empty
    const cov = A.covariance([g('x', x), g('y', y), g('z', z)]);
    expect(at(cov, 1, 1)).toBeCloseTo(fx('VAR.P(A1:A6)'), 12);
    expect(at(cov, 3, 1)).toBeCloseTo(fx('COVARIANCE.P(A1:A6,C1:C6)'), 12);
  });

  it('descriptive statistics agree with the sheet functions', () => {
    const data = [3, 7, 7, 2, 9, 12, 4, 5];
    const { fx } = sheetWith([data]);
    const layout = A.descriptiveStatistics([g('Data', data)], { summary: true, confidence: 0.95, kthLargest: 2, kthSmallest: 3 });
    const v = (label) => beside(layout, label);
    expect(at(layout, 0, 0)).toBe('Data');
    expect(v('Mean')).toBeCloseTo(fx('AVERAGE(A1:A8)'), 14);
    expect(v('Standard Error')).toBeCloseTo(fx('STDEV.S(A1:A8)/SQRT(8)'), 14);
    expect(v('Median')).toBe(fx('MEDIAN(A1:A8)'));
    expect(v('Mode')).toBe(7);
    expect(v('Standard Deviation')).toBeCloseTo(fx('STDEV.S(A1:A8)'), 14);
    expect(v('Sample Variance')).toBeCloseTo(fx('VAR.S(A1:A8)'), 14);
    expect(v('Kurtosis')).toBeCloseTo(fx('KURT(A1:A8)'), 14);
    expect(v('Skewness')).toBeCloseTo(fx('SKEW(A1:A8)'), 14);
    expect(v('Range')).toBe(10);
    expect(v('Minimum')).toBe(2);
    expect(v('Maximum')).toBe(12);
    expect(v('Sum')).toBe(49);
    expect(v('Count')).toBe(8);
    expect(v('Largest(2)')).toBe(9);
    expect(v('Smallest(3)')).toBe(4);
    expect(v('Confidence Level(95.0%)')).toBeCloseTo(fx('CONFIDENCE.T(0.05,STDEV.S(A1:A8),8)'), 12);
    // No repeated value: Mode is #N/A, as MODE.SNGL says.
    const unique = A.descriptiveStatistics([g('u', [1, 2, 3])]);
    expect(beside(unique, 'Mode')).toEqual({ error: '#N/A' });
    expect(A.descriptiveStatistics([g('u', [1])], { summary: false }).error).toMatch(/at least one/);
  });
});

describe('Smoothing and moving averages', () => {
  const xs = [10, 12, 11, 15, 14, 18, 17];
  it('exponential smoothing damps the last forecast', () => {
    const layout = A.exponentialSmoothing(g('s', xs), { damping: 0.4, standardErrors: true, chart: true });
    expect(at(layout, 0, 0)).toEqual({ error: '#N/A' });
    expect(at(layout, 1, 0)).toBe(10);
    let f = 10;
    const fs = [null, 10];
    for (let t = 2; t < xs.length; t++) { f = 0.6 * xs[t - 1] + 0.4 * f; fs.push(f); expect(at(layout, t, 0)).toBeCloseTo(f, 12); }
    expect(at(layout, 2, 1)).toEqual({ error: '#N/A' });
    const se = Math.sqrt(((xs[1] - fs[1]) ** 2 + (xs[2] - fs[2]) ** 2 + (xs[3] - fs[3]) ** 2) / 3);
    expect(at(layout, 3, 1)).toBeCloseTo(se, 12);
    expect(layout.charts[0].type).toBe('line');
    expect(layout.charts[0].series[1].values).toEqual({ rel: [0, 0, xs.length - 1, 0] });
    expect(A.exponentialSmoothing(g('s', xs), { damping: 1.5 }).error).toMatch(/damping/i);
  });

  it('moving average and its standard error', () => {
    const layout = A.movingAverage(g('m', xs), { interval: 3, labels: true, standardErrors: true });
    expect(at(layout, 0, 0)).toBe('Forecast');
    expect(at(layout, 2, 0)).toEqual({ error: '#N/A' });
    expect(at(layout, 3, 0)).toBeCloseTo(11, 12);
    expect(at(layout, 7, 0)).toBeCloseTo((14 + 18 + 17) / 3, 12);
    const f = (t) => (xs[t - 2] + xs[t - 1] + xs[t]) / 3;
    const se = Math.sqrt([2, 3, 4].reduce((s, t) => s + (xs[t] - f(t)) ** 2, 0) / 3);
    expect(at(layout, 4, 1)).toEqual({ error: '#N/A' });
    expect(at(layout, 5, 1)).toBeCloseTo(se, 12);
    expect(A.movingAverage(g('m', [1, 2]), { interval: 3 }).error).toMatch(/at least 3/);
  });
});

describe('Two-sample tests', () => {
  const x = [19, 22, 16, 29, 24, 20, 25];
  const y = [20, 19, 15, 26, 24, 17, 22];
  it('paired t-test matches T.TEST type 1', () => {
    const { fx } = sheetWith([x, y]);
    const layout = A.tTest(g('Before', x), g('After', y), { kind: 'paired', alpha: 0.05 });
    expect(at(layout, 0, 0)).toBe('t-Test: Paired Two Sample for Means');
    expect(beside(layout, 'Pearson Correlation')).toBeCloseTo(fx('CORREL(A1:A7,B1:B7)'), 14);
    expect(beside(layout, 'P(T<=t) two-tail')).toBeCloseTo(fx('T.TEST(A1:A7,B1:B7,2,1)'), 12);
    expect(beside(layout, 'P(T<=t) one-tail')).toBeCloseTo(fx('T.TEST(A1:A7,B1:B7,1,1)'), 12);
    expect(beside(layout, 't Critical two-tail')).toBeCloseTo(fx('T.INV.2T(0.05,6)'), 12);
    expect(beside(layout, 't Critical one-tail')).toBeCloseTo(fx('T.INV(0.95,6)'), 12);
    expect(beside(layout, 'df')).toBe(6);
  });

  it('equal-variance t-test matches T.TEST type 2', () => {
    const b = [...y, 30];
    const { fx } = sheetWith([x, b]);
    const layout = A.tTest(g('x', x), g('y', b), { kind: 'equal' });
    expect(beside(layout, 'P(T<=t) two-tail')).toBeCloseTo(fx('T.TEST(A1:A7,B1:B8,2,2)'), 12);
    expect(beside(layout, 'df')).toBe(13);
    const pooled = (6 * fx('VAR.S(A1:A7)') + 7 * fx('VAR.S(B1:B8)')) / 13;
    expect(beside(layout, 'Pooled Variance')).toBeCloseTo(pooled, 12);
  });

  it('unequal-variance t-test reports Welch degrees of freedom, rounded', () => {
    const b = [5, 40, 12, 33, 2, 27];
    const { fx } = sheetWith([x, b]);
    const layout = A.tTest(g('x', x), g('y', b), { kind: 'unequal', difference: 0 });
    const v1 = fx('VAR.S(A1:A7)') / 7, v2 = fx('VAR.S(B1:B6)') / 6;
    const df = Math.round((v1 + v2) ** 2 / (v1 * v1 / 6 + v2 * v2 / 5));
    expect(beside(layout, 'df')).toBe(df);
    const t = (fx('AVERAGE(A1:A7)') - fx('AVERAGE(B1:B6)')) / Math.sqrt(v1 + v2);
    expect(beside(layout, 't Stat')).toBeCloseTo(t, 12);
    expect(beside(layout, 'P(T<=t) two-tail')).toBeCloseTo(fx(`T.DIST.2T(${Math.abs(t)},${df})`), 12);
  });

  it('paired test refuses ranges of different sizes', () => {
    expect(A.tTest(g('x', [1, 2, 3]), g('y', [1, 2]), { kind: 'paired' }).error).toMatch(/same size/);
  });

  it('z-test with known variances', () => {
    const { fx } = sheetWith([x, y]);
    const layout = A.zTest(g('x', x), g('y', y), { variance1: 16, variance2: 12, alpha: 0.05 });
    const z = (fx('AVERAGE(A1:A7)') - fx('AVERAGE(B1:B7)')) / Math.sqrt(16 / 7 + 12 / 7);
    expect(beside(layout, 'z')).toBeCloseTo(z, 12);
    expect(beside(layout, 'P(Z<=z) one-tail')).toBeCloseTo(1 - fx(`NORM.S.DIST(${Math.abs(z)},TRUE)`), 12);
    expect(beside(layout, 'z Critical two-tail')).toBeCloseTo(1.959963984540054, 12);
    expect(A.zTest(g('x', x), g('y', y), { variance1: 0, variance2: 1 }).error).toMatch(/variance/);
  });

  it('F-test of two variances in the tail F falls in', () => {
    const { fx } = sheetWith([x, y]);
    const layout = A.fTest(g('x', x), g('y', y), { alpha: 0.05 });
    const F = fx('VAR.S(A1:A7)/VAR.S(B1:B7)');
    expect(beside(layout, 'F')).toBeCloseTo(F, 12);
    expect(F).toBeGreaterThan(1);
    expect(beside(layout, 'P(F<=f) one-tail')).toBeCloseTo(fx(`F.DIST.RT(${F},6,6)`), 12);
    expect(beside(layout, 'F Critical one-tail')).toBeCloseTo(fx('F.INV.RT(0.05,6,6)'), 12);
    const low = A.fTest(g('y', y), g('x', x), { alpha: 0.05 });
    expect(beside(low, 'P(F<=f) one-tail')).toBeCloseTo(fx(`F.DIST(${1 / F},6,6,TRUE)`), 12);
    expect(beside(low, 'F Critical one-tail')).toBeCloseTo(fx('F.INV(0.05,6,6)'), 12);
  });
});

describe('Fourier analysis', () => {
  it('transforms and inverts', () => {
    const layout = A.fourier(g('x', [1, 2, 3, 4]));
    expect(layout.cells.map((r) => at({ cells: [r] }, 0, 0))).toEqual(['10', '-2+2i', '-2', '-2-2i']);
    const back = A.fourier(g('X', ['10', '-2+2i', '-2', '-2-2i']), { inverse: true });
    expect(back.cells.map((r) => at({ cells: [r] }, 0, 0))).toEqual(['1', '2', '3', '4']);
    // A cosine of one cycle over 8 points lands in bins 1 and 7.
    const cos = A.fourier(g('c', Array.from({ length: 8 }, (_, i) => Math.cos((2 * Math.PI * i) / 8))));
    expect(cos.cells.map((r) => at({ cells: [r] }, 0, 0))).toEqual(['0', '4', '0', '0', '0', '0', '0', '4']);
    expect(A.fourier(g('x', [1, 2, 3])).error).toMatch(/power of 2/);
  });
});

describe('Histogram', () => {
  const data = [1, 2, 2, 3, 5, 5, 5, 8, 9, 10];
  it('counts against given bins, with More, Pareto and cumulative percent', () => {
    const { fx, wb, id } = sheetWith([data, [2, 5, 8]]);
    const layout = A.histogram(g('d', data), { bins: [2, 5, 8], pareto: true, cumulative: true, chart: true });
    expect(layout.cells.slice(1, 5).map((r) => [r[0], r[1]].map((c) => (c && typeof c === 'object' ? c.v : c)))).toEqual([[2, 3], [5, 4], [8, 1], ['More', 2]]);
    wb.setInput(id, 0, 3, '=FREQUENCY(A1:A10,B1:B3)');
    expect([0, 1, 2, 3].map((r) => wb.getValue(id, r, 3))).toEqual([3, 4, 1, 2]);
    expect(at(layout, 4, 2)).toBe(1);
    expect(at(layout, 1, 2)).toBeCloseTo(0.3, 12);
    // The sorted table beside it.
    expect([1, 2, 3, 4].map((r) => at(layout, r, 5))).toEqual([4, 3, 2, 1]);
    expect(at(layout, 1, 4)).toBe(5);
    expect(layout.charts[0]).toMatchObject({ type: 'combo', secondaryAxis: true });
    expect(fx('SUM(1)')).toBe(1);
  });

  it('makes equal bins from the minimum to the maximum when none are given', () => {
    const layout = A.histogram(g('d', data));
    const bins = layout.cells.slice(1).map((r) => (r[0] && typeof r[0] === 'object' ? r[0].v : r[0]));
    expect(bins[0]).toBe(1);
    expect(bins.at(-2)).toBe(10);
    expect(bins.at(-1)).toBe('More');
    const counts = layout.cells.slice(1).map((r) => (r[1] && typeof r[1] === 'object' ? r[1].v : r[1]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(data.length);
  });
});

describe('Random numbers and sampling', () => {
  it('a seed repeats the draw; distributions keep to their support', () => {
    const one = A.randomNumbers({ variables: 2, count: 50, distribution: 'uniform', seed: 7, params: { from: 3, to: 5 } });
    const two = A.randomNumbers({ variables: 2, count: 50, distribution: 'uniform', seed: 7, params: { from: 3, to: 5 } });
    expect(one.cells).toEqual(two.cells);
    expect(one.cells.flat().every((v) => v >= 3 && v < 5)).toBe(true);
    const bern = A.randomNumbers({ count: 200, distribution: 'bernoulli', seed: 1, params: { p: 0.3 } }).cells.flat();
    expect(new Set(bern)).toEqual(new Set([0, 1]));
    const binom = A.randomNumbers({ count: 200, distribution: 'binomial', seed: 1, params: { p: 0.5, trials: 6 } }).cells.flat();
    expect(binom.every((v) => Number.isInteger(v) && v >= 0 && v <= 6)).toBe(true);
    const pois = A.randomNumbers({ count: 2000, distribution: 'poisson', seed: 3, params: { lambda: 4 } }).cells.flat();
    expect(pois.reduce((a, b) => a + b, 0) / pois.length).toBeCloseTo(4, 0);
    const norm = A.randomNumbers({ count: 4000, distribution: 'normal', seed: 5, params: { mean: 10, sd: 2 } }).cells.flat();
    const m = norm.reduce((a, b) => a + b, 0) / norm.length;
    expect(m).toBeCloseTo(10, 0);
    const disc = A.randomNumbers({ count: 100, distribution: 'discrete', seed: 2, params: { values: [1, 5, 9], probabilities: [0.2, 0.5, 0.3] } }).cells.flat();
    expect(disc.every((v) => [1, 5, 9].includes(v))).toBe(true);
    expect(A.randomNumbers({ count: 1, distribution: 'discrete', params: { values: [1, 2], probabilities: [0.5, 0.6] } }).error).toMatch(/add up to 1/);
  });

  it('patterned numbers repeat each value and the sequence', () => {
    const layout = A.randomNumbers({ variables: 2, distribution: 'patterned', params: { from: 1, to: 2, step: 0.5, repeatEach: 2, repeatSequence: 2 } });
    expect(layout.cells.map((r) => r[0])).toEqual([1, 1, 1.5, 1.5, 2, 2, 1, 1, 1.5, 1.5, 2, 2]);
    expect(layout.cells.every((r) => r[1] === r[0])).toBe(true);
  });

  it('periodic and random sampling', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(A.sampling(xs, { method: 'periodic', period: 3 }).cells.flat()).toEqual([3, 6, 9]);
    const r = A.sampling(xs, { method: 'random', count: 20, seed: 4 }).cells.flat();
    expect(r).toHaveLength(20);
    expect(r.every((v) => xs.includes(v))).toBe(true);
    expect(A.sampling(xs, { method: 'random', count: 20, seed: 4 }).cells.flat()).toEqual(r);
    expect(A.sampling(xs, { method: 'periodic', period: 10 }).error).toMatch(/period/);
  });
});

describe('Rank and percentile', () => {
  it('sorts largest first with RANK.EQ and PERCENTRANK.INC', () => {
    const xs = [40, 75, 75, 20, 90];
    const { fx } = sheetWith([xs]);
    const layout = A.rankAndPercentile([g('Score', xs)]);
    expect(layout.cells[0].map((c) => c.v)).toEqual(['Point', 'Score', 'Rank', 'Percent']);
    const body = layout.cells.slice(1).map((r) => r.map((c) => (c && typeof c === 'object' ? c.v : c)));
    expect(body.map((r) => r[0])).toEqual([5, 2, 3, 1, 4]);
    expect(body.map((r) => r[2])).toEqual([1, 2, 2, 4, 5]);
    expect(body[1][3]).toBe(fx('PERCENTRANK.INC(A1:A5,75)'));
    expect(body[3][3]).toBe(fx('PERCENTRANK.INC(A1:A5,40)'));
  });
});

describe('Regression', () => {
  const y = [3.1, 4.9, 7.2, 8.8, 11.1, 13.2, 14.8];
  const x1 = [1, 2, 3, 4, 5, 6, 7];
  const x2 = [2, 1, 4, 3, 6, 5, 8];
  it('matches LINEST and its statistics, with intervals at two levels', () => {
    const { fx, wb, id } = sheetWith([y, x1, x2]);
    const layout = A.regression(y, [x1, x2], { confidence: 0.9, residuals: true, standardized: true, normalPlot: true, residualPlots: true, lineFitPlots: true, xLabels: ['a', 'b'] });
    wb.setInput(id, 0, 5, '=LINEST(A1:A7,B1:C7,TRUE,TRUE)');
    const L = (r, c) => wb.getValue(id, r, 5 + c);
    expect(beside(layout, 'R Square')).toBeCloseTo(L(2, 0), 14);
    expect(beside(layout, 'Multiple R')).toBeCloseTo(Math.sqrt(L(2, 0)), 14);
    expect(beside(layout, 'Standard Error')).toBeCloseTo(L(2, 1), 14);
    expect(beside(layout, 'Adjusted R Square')).toBeCloseTo(1 - (1 - L(2, 0)) * 6 / 4, 14);
    expect(beside(layout, 'Observations')).toBe(7);
    expect(beside(layout, 'Regression', 4)).toBeCloseTo(L(3, 0), 10);
    expect(beside(layout, 'Residual', 1)).toBe(4);
    expect(beside(layout, 'Regression', 5)).toBeCloseTo(fx(`F.DIST.RT(${L(3, 0)},2,4)`), 12);
    expect(beside(layout, 'Intercept')).toBeCloseTo(L(0, 2), 12);
    expect(beside(layout, 'a')).toBeCloseTo(L(0, 1), 12);
    expect(beside(layout, 'b')).toBeCloseTo(L(0, 0), 12);
    expect(beside(layout, 'b', 2)).toBeCloseTo(L(1, 0), 12);
    const t = L(0, 0) / L(1, 0);
    expect(beside(layout, 'b', 3)).toBeCloseTo(t, 12);
    expect(beside(layout, 'b', 4)).toBeCloseTo(fx(`T.DIST.2T(${Math.abs(t)},4)`), 12);
    const head = layout.cells[row(layout, 'Intercept') - 1].map((c) => c.v);
    expect(head.slice(5)).toEqual(['Lower 95%', 'Upper 95%', 'Lower 90%', 'Upper 90%']);
    const w90 = fx('T.INV.2T(0.1,4)') * L(1, 0);
    expect(beside(layout, 'b', 7)).toBeCloseTo(L(0, 0) - w90, 12);
    // Residuals and the probability output.
    const top = row(layout, 'Observation');
    const predicted = L(0, 2) + L(0, 1) * x1[0] + L(0, 0) * x2[0];
    expect(at(layout, top + 1, 1)).toBeCloseTo(predicted, 12);
    expect(at(layout, top + 1, 2)).toBeCloseTo(y[0] - predicted, 12);
    const sdRes = Math.sqrt(fx('INDEX(LINEST(A1:A7,B1:C7,TRUE,TRUE),5,2)') / 6);
    expect(at(layout, top + 1, 3)).toBeCloseTo((y[0] - predicted) / sdRes, 12);
    expect(at(layout, top, 5)).toBe('Percentile');
    expect(at(layout, top + 1, 5)).toBeCloseTo(100 / 14, 12);
    expect(at(layout, top + 1, 6)).toBe(3.1);
    expect(layout.charts.map((c) => c.title)).toEqual(['Normal Probability Plot', 'a Residual Plot', 'b Residual Plot', 'a Line Fit Plot', 'b Line Fit Plot']);
  });

  it('through the origin', () => {
    const { wb, id } = sheetWith([y, x1]);
    const layout = A.regression(y, [x1], { constantZero: true });
    wb.setInput(id, 0, 5, '=LINEST(A1:A7,B1:B7,FALSE,TRUE)');
    expect(beside(layout, 'X Variable')).toBeCloseTo(wb.getValue(id, 0, 5), 12);
    expect(beside(layout, 'Intercept')).toBe(0);
    expect(beside(layout, 'Intercept', 2)).toEqual({ error: '#N/A' });
    expect(beside(layout, 'R Square')).toBeCloseTo(wb.getValue(id, 2, 5), 12);
    expect(beside(layout, 'Total', 1)).toBe(7);
  });

  it('refuses mismatched or too-short data', () => {
    expect(A.regression([1, 2, 3], [[1, 2]]).error).toMatch(/same number of rows/);
    expect(A.regression([1, 2], [[1, 2]]).error).toMatch(/at least 3 rows/);
    expect(A.regression([1, 2, null], [[1, 2, 3]]).error).toMatch(/number in every row/);
  });
});

describe('Reading ranges and writing output', () => {
  it('reads groups with labels and refuses text', () => {
    const { wb, id } = sheetWith([['Height', 1, 2, 3], ['Weight', 4, null, 6]]);
    const read = A.readGroups(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { labels: true });
    expect(read.groups.map((x) => x.label)).toEqual(['Height', 'Weight']);
    expect(read.groups[1].values).toEqual([4, null, 6]);
    expect(read.groups[0].ref.range).toEqual({ r1: 1, c1: 0, r2: 3, c2: 0 });
    expect(A.readGroups(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }).error).toMatch(/non-numeric data \(cell A1\)/);
    const rows = A.readGroups(wb, id, { r1: 1, c1: 0, r2: 3, c2: 1 }, { by: 'rows' });
    expect(rows.groups[0]).toMatchObject({ label: 'Row 1', values: [1, 4] });
  });

  it('writes to a new sheet as one undo step, with its chart', () => {
    const { wb, id } = sheetWith([[1, 2, 2, 3, 4, 7]]);
    const before = wb.sheets.length;
    const read = A.readGroups(wb, id, { r1: 0, c1: 0, r2: 5, c2: 0 });
    const layout = A.exponentialSmoothing(read.groups[0], { damping: 0.5, chart: true });
    const out = A.writeAnalysisOutput(wb, layout, { kind: 'sheet', name: 'Smoothed' });
    expect(wb.sheets).toHaveLength(before + 1);
    expect(wb.sheet(out.sheetId).name).toBe('Smoothed');
    expect(wb.getValue(out.sheetId, 1, 0)).toBe(1);
    const chart = wb.sheet(out.sheetId).charts[0];
    expect(chart.sourceRefs.map((s) => s.values)).toEqual(['Sheet1!$A$1:$A$6', 'Smoothed!$A$1:$A$6']);
    expect(wb.undoLabels(5)).toEqual(['Exponential Smoothing']);
    wb.undo();
    expect(wb.sheets).toHaveLength(before);
    wb.redo();
    expect(wb.sheetByName('Smoothed')).toBeTruthy();
    expect(A.writeAnalysisOutput(wb, layout, { kind: 'sheet', name: 'Smoothed' }).error).toBeTruthy();
  });

  it('writes into a range as one undo step and can be found occupied', () => {
    const { wb, id } = sheetWith([[5, 6, 7, 8]]);
    const layout = A.descriptiveStatistics([{ label: 'v', values: [5, 6, 7, 8] }]);
    expect(A.outputOccupied(wb, id, layout, 0, 0)).toBe(true);
    expect(A.outputOccupied(wb, id, layout, 0, 3)).toBe(false);
    const out = A.writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: id, r: 0, c: 3 });
    expect(out.range).toEqual({ r1: 0, c1: 3, r2: 13, c2: 4 });
    expect(wb.getValue(id, 1, 3)).toBe('Mean');
    expect(wb.getValue(id, 1, 4)).toBe(6.5);
    expect(wb.getCell(id, 0, 3).s).toMatchObject({ italic: true });
    expect(wb.undoLabels(1)).toEqual(['Descriptive Statistics']);
    wb.undo();
    expect(wb.getValue(id, 1, 3)).toBe(null);
  });

  it('builds a separate workbook whose charts carry the input values', () => {
    const { wb, id } = sheetWith([[2, 4, 5, 4, 5], [1, 2, 3, 4, 5]]);
    const ys = A.readGroups(wb, id, { r1: 0, c1: 0, r2: 4, c2: 0 }).groups[0];
    const xs = A.readGroups(wb, id, { r1: 0, c1: 1, r2: 4, c2: 1 }).groups[0];
    const layout = A.regression(ys.values, [xs.values], { residualPlots: true, yRef: ys.ref, xRefs: [xs.ref] });
    const book = A.analysisWorkbook(wb, layout, 'Regression');
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0].name).toBe('Regression');
    expect(book.getValue(book.activeSheetId, 0, 0)).toBe('Regression Summary');
    const source = book.sheets[0].charts[0].sourceRefs[0];
    expect(source.literal.categories).toEqual([1, 2, 3, 4, 5]);
    expect(source.values).toMatch(/^Regression!\$C\$\d+:\$C\$\d+$/);
    expect(book.undoLabels()).toEqual([]);
  });
});
