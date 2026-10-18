import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// The legends of box & whisker, stock, surface, funnel, treemap and sunburst charts ran their entries
// into each other ("Costs & fee■Profit"): text without a font of its own was measured in the canvas's
// fallback face ("12px null"), narrower than the interface font the chart is drawn in. It is now
// measured in that font.
it('measures a legend without a font of its own in the font the chart is drawn in', () => {
  const fonts = [];
  const context = { font: '', measureText(text) { fonts.push(this.font); return { width: [...String(text)].length * (/system-ui/.test(this.font) ? 8 : 5) }; } };
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return context; } });
  try {
    const wb = new Workbook(), id = wb.activeSheetId;
    [['Month', 'Revenue total', 'Costs & fees', 'Profit'], ['Jan', 1200, 300, 900], ['Feb', 800, 450, 350], ['Mar', 1500, 200, 1300]]
      .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
    for (const type of ['boxWhisker', 'stock', 'surface']) {
      const chart = normalizeChart({ type, range: { r1: 0, c1: 0, r2: 3, c2: 3 }, anchor: { r: 5, c: 0 } });
      fonts.length = 0;
      const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 360, 260)).window.document;
      expect(fonts.some(font => /null/.test(font))).toBe(false);
      const legend = doc.querySelector('[data-el="legend"]');
      const texts = [...legend.querySelectorAll('text')];
      expect(texts.length).toBeGreaterThan(1);
      // Each label ends before the next entry's key (at least 8px wide) begins.
      texts.slice(0, -1).forEach((t, i) => {
        const end = +t.getAttribute('x') + [...t.textContent].length * 8, next = texts[i + 1];
        if (+next.getAttribute('y') === +t.getAttribute('y')) expect(+next.getAttribute('x') - 8, `${type}: ${t.textContent}`).toBeGreaterThanOrEqual(end);
      });
    }
  } finally { vi.unstubAllGlobals(); }
});
