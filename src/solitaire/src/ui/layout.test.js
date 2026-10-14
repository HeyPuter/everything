import { describe, it, expect } from 'vitest';
import {
  computeSizes, renderModeFor, cardRadiusFor, RICH_MODE_MIN_CARD_W, fitFan,
} from './layout.js';

describe('computeSizes', () => {
  it('fits seven cards plus six gaps into the board width', () => {
    const { cardW, gap } = computeSizes(980);
    expect(cardW * 7 + gap * 6).toBeCloseTo(980, 5);
  });

  it('keeps the locked 1:1.4 aspect ratio', () => {
    const { cardW, cardH } = computeSizes(980);
    expect(cardH).toBeCloseTo(cardW * 1.4, 5);
  });

  it('clamps the gap between 8 and 16', () => {
    expect(computeSizes(200).gap).toBe(8);
    expect(computeSizes(4000).gap).toBe(16);
    expect(computeSizes(700).gap).toBeCloseTo(700 * 0.018, 5);
  });

  it('never returns a negative card width, even for degenerate sizes', () => {
    expect(computeSizes(0).cardW).toBe(0);
    expect(computeSizes(10).cardW).toBeGreaterThanOrEqual(0);
    expect(computeSizes(40).cardW).toBeGreaterThanOrEqual(0);
    expect(computeSizes(100).cardW).toBeGreaterThan(0);
  });
});

describe('renderModeFor', () => {
  it('is rich at and above the threshold', () => {
    expect(renderModeFor(RICH_MODE_MIN_CARD_W)).toBe('rich');
    expect(renderModeFor(RICH_MODE_MIN_CARD_W + 40)).toBe('rich');
  });

  it('is simple below the threshold', () => {
    expect(renderModeFor(RICH_MODE_MIN_CARD_W - 1)).toBe('simple');
    expect(renderModeFor(44)).toBe('simple');
  });

  it('stays simple at the width where court art was measured illegible', () => {
    // The probe showed courts as mush at 44px and barely readable at 56px.
    expect(renderModeFor(56)).toBe('simple');
  });
});

describe('cardRadiusFor', () => {
  it('scales with card width and stays inside 4..10', () => {
    expect(cardRadiusFor(40)).toBeGreaterThanOrEqual(4);
    expect(cardRadiusFor(1000)).toBeLessThanOrEqual(10);
    expect(cardRadiusFor(120)).toBeGreaterThan(cardRadiusFor(50));
  });
});

describe('computeSizes columns', () => {
  it('fits ten columns into the same width as seven', () => {
    const seven = computeSizes(980);
    const ten = computeSizes(980, 10);
    expect(ten.cardW * 10 + ten.gap * 9).toBeCloseTo(980);
    expect(ten.cardW).toBeLessThan(seven.cardW);
  });

  it('lets ten-column gaps shrink below the seven-column floor on a phone', () => {
    expect(computeSizes(200, 10).gap).toBe(4);
    expect(computeSizes(200).gap).toBe(8);
  });
});

describe('fitFan', () => {
  const base = { down: 10, up: 30, cardH: 100 };

  it('leaves a column that fits alone', () => {
    expect(fitFan({ ...base, faceDown: 2, faceUp: 3, avail: 1000 })).toEqual({ down: 10, up: 30 });
  });

  it('squeezes face-down cards before face-up ones', () => {
    // natural: 5*10 + 10*30 + 100 = 450
    const f = fitFan({ ...base, faceDown: 5, faceUp: 10, avail: 420 });
    expect(f.up).toBe(30);
    expect(f.down).toBeCloseTo(4);
  });

  it('then squeezes face-up cards, never below the readable floor', () => {
    const f = fitFan({ ...base, faceDown: 5, faceUp: 20, avail: 500 });
    expect(f.down).toBe(4);
    expect(f.up).toBeCloseTo((500 - 100 - 20) / 20);
    expect(fitFan({ ...base, faceDown: 5, faceUp: 40, avail: 300 }).up).toBe(16);
  });
});
