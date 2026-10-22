import { expect, it } from 'vitest';
import { stylesheet, parseRules, declarations } from './helpers/css.js';
import { heightForLines } from '../src/core/textfit.js';

// A row fitted to wrapped text is 1.3 lines of its size a line (heightForLines). The grid draws wrapped lines at
// that pitch, so whatever vertical padding a wrapped cell keeps comes out of the last line: Arial's 4px above and
// 3px below cut the descenders of two wrapped lines of 10 point Arial off at the foot of their 36px row, the
// rows every LibreOffice or Google Sheets file opens with.

/** A cell's padding-top and padding-bottom for its classes, from the grid's plain `.cell.x.y` rules in cascade order. */
function verticalPadding(css, classes) {
  const own = new Set(['cell', ...classes]);
  const hits = [];
  parseRules(css).forEach((rule, i) => {
    if (rule.media.length) return;
    for (const selector of rule.selectors) {
      if (!/^\.cell(\.[a-z-]+)*$/.test(selector)) continue;
      const names = selector.slice(1).split('.');
      if (names.every((name) => own.has(name))) hits.push({ specificity: names.length, i, d: declarations(rule.body) });
    }
  });
  hits.sort((a, b) => a.specificity - b.specificity || a.i - b.i);
  const px = (v) => (/^0(px)?$/.test(v) ? 0 : Number(/^([\d.]+)px$/.exec(v)?.[1] ?? NaN));
  let top = 0, bottom = 0, lineHeight = null;
  for (const { d } of hits) {
    if (d.padding) {
      const parts = d.padding.replace(/var\([^)]*\)/g, 'v').trim().split(/\s+/);
      top = px(parts[0]);
      bottom = px(parts[parts.length >= 3 ? 2 : 0]);
    }
    if (d['padding-top']) top = px(d['padding-top']);
    if (d['padding-bottom']) bottom = px(d['padding-bottom']);
    if (d['line-height']) lineHeight = Number(d['line-height']);
  }
  return { top, bottom, lineHeight };
}

it('fits wrapped lines in any font into the rows fitted for them', () => {
  const css = stylesheet('grid.css');
  for (const font of [[], ['calibri']]) {
    for (const valign of [[], ['vt'], ['vm'], ['vb']]) {
      const { top, bottom, lineHeight } = verticalPadding(css, ['wrap', ...font, ...valign]);
      const what = ['wrap', ...font, ...valign].join('.');
      expect(lineHeight, what).toBe(1.3);
      // 10 point Arial (a LibreOffice file), 11 point (Excel's), 12 and 14 point. The grid line drawn over a row's last
      // pixel takes from the last line's leading (0.15 of its size), not its letters.
      for (const size of [40 / 3, 44 / 3, 16, 56 / 3]) {
        for (let lines = 1; lines <= 6; lines++) {
          expect(top + bottom + lines * lineHeight * size, `${what} ${lines} lines at ${size}px`).toBeLessThanOrEqual(heightForLines(lines, size) + 0.5);
        }
      }
    }
  }
});
