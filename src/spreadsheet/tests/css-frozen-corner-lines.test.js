import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// With rows and columns both frozen, the frozen corner is drawn over the ends of the two bands, and it
// drew no line of its own: the freeze lines began past the corner, leaving a gap under and beside the
// top-left frozen cells. The corner now draws both lines along its edges, as the bands do.
it('draws the freeze lines along the frozen corner, as along the bands', () => {
  const css = stylesheet('grid.css');
  const rowLine = declared(css, '.frz-rows::after', false);
  const colLine = declared(css, '.frz-cols::after', false);
  const bottom = declared(css, '.frz-corner::after', false);
  const right = declared(css, '.frz-corner::before', false);
  for (const key of ['content', 'position', 'bottom', 'height', 'background', 'opacity']) expect(bottom[key], key).toBe(rowLine[key]);
  for (const key of ['content', 'position', 'right', 'width', 'background', 'opacity']) expect(right[key], key).toBe(colLine[key]);
  // The line drawn before the corner's cells still shows over a filled frozen cell.
  expect(Number(right['z-index'])).toBeGreaterThan(0);
  // A split window has no frozen boundary; the corner's lines go with the bands'.
  const split = stylesheet('split-panes.css');
  for (const sel of ['.grid.split-panes .frz-corner::after', '.grid.split-panes .frz-corner::before']) expect(declared(split, sel, false).display, sel).toBe('none');
  // Forced colours draw them in CanvasText too.
  for (const sel of ['.frz-corner::after', '.frz-corner::before']) expect(declared(css, sel, 'forced-colors').background, sel).toBe('CanvasText');
});
