import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';

// Far from the origin a ruler or grid step is lost in float precision: a loop that adds the step to a
// coordinate never ends and the tab runs out of memory. Each path call is counted; the old loops trip the limit.
function countMoves(ctx, limit) {
  const seen = { moves: 0, runaway: false };
  ctx.moveTo = () => {
    if (++seen.moves > limit) {
      seen.runaway = true;
      throw new Error('runaway loop');
    }
  };
  ctx.fillRect = ctx.moveTo;
  return seen;
}

function hugeDocument(app, size) {
  const ed = app.newDocument({ width: size, height: size });
  ed.view.set({ width: 1000, height: 800, dpr: 1 });
  ed.fitArtboard();
  return ed;
}

describe('a huge artboard', () => {
  it('draws rulers with a bounded number of ticks', async () => {
    const app = bootApp();
    for (const size of [612, 1e20, 1e300]) {
      const ed = hugeDocument(app, size);
      ed.setViewOption('rulers', true);
      const seen = countMoves(document.querySelector('.ruler-top').getContext('2d'), 50000);
      app.rulers.refresh();
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.runaway).toBe(false);
      // Normal documents keep their ticks: one every few pixels across the ruler.
      if (size === 612) expect(seen.moves).toBeGreaterThan(50);
      expect(seen.moves).toBeLessThan(2000);
    }
  });

  it('draws the grid (lines or dots) with a bounded number of marks', () => {
    const app = bootApp();
    for (const style of ['lines', 'dots']) {
      app.prefs.set('gridStyle', style);
      for (const size of [612, 4e19]) {
        const ed = hugeDocument(app, size);
        ed.setViewOption('rulers', false);
        ed.setViewOption('grid', true);
        // Gridlines that don't all land on a major line far out, so the minor pass draws too.
        if (size > 612)
          ed.doc.transact('Grid', () =>
            ed.doc.updateRoot({ grid: { spacing: 10000, subdivisions: 8 } }),
          );
        const view = app.views.get(ed);
        const seen = countMoves(view.art.getContext('2d'), style === 'dots' ? 200000 : 50000);
        view.invalidate();
        view.renderNow();
        expect(seen.runaway).toBe(false);
        if (size === 612) expect(seen.moves).toBeGreaterThan(50);
      }
    }
  });
});
