import { expect, it } from 'vitest';
import { randomNumbers } from '../src/core/analysis-tools.js';

// Random Number Generation drew a binomial number by flipping every trial one by one, synchronously: 1,000 numbers
// of a million trials took over half a minute, and ten such columns froze the tab for minutes. Many trials are now
// drawn by walking the distribution out from its mode, at a cost of about its spread, with the same distribution.
const moments = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, variance: xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) };
};

it('draws numbers of a million trials at once', () => {
  const start = performance.now();
  const xs = randomNumbers({ variables: 1, count: 200, distribution: 'binomial', seed: 3, params: { p: 0.5, trials: 1e6 } }).cells.flat();
  // Flipping each trial took seconds here (200 million coins); the walk from the mode takes about a millisecond.
  expect(performance.now() - start).toBeLessThan(1000);
  expect(xs).toHaveLength(200);
  expect(xs.every((x) => Number.isInteger(x) && Math.abs(x - 500000) < 5000)).toBe(true);
});

it('keeps the binomial mean and variance, skewed or not', () => {
  for (const [trials, p] of [[1e6, 0.5], [1000, 0.3], [200, 0.98], [100000, 0.001]]) {
    const xs = randomNumbers({ variables: 10, count: 2000, distribution: 'binomial', seed: 11, params: { p, trials } }).cells.flat();
    const { mean, variance } = moments(xs);
    const sd = Math.sqrt(trials * p * (1 - p));
    expect(Math.abs(mean - trials * p)).toBeLessThan(5 * sd / Math.sqrt(xs.length));
    expect(variance / (sd * sd)).toBeGreaterThan(0.9);
    expect(variance / (sd * sd)).toBeLessThan(1.1);
    expect(xs.every((x) => Number.isInteger(x) && x >= 0 && x <= trials)).toBe(true);
  }
});
