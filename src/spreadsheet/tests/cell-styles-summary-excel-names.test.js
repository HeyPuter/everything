import { expect, it } from 'vitest';
import { normalizeCellStyles, partSummary } from '../src/core/custom-cell-styles.js';

// A named cell style from an Excel file may centre across the selection or edge its cells with a hairline or a
// medium dash-dot line, and the Style dialog described those by their stored words: "CenterContinuous horizontally",
// "Bottom mediumDashDot". It now uses the names Format Cells shows.
const style = (fields) => normalizeCellStyles([{ name: 'Title', parts: { number: false, alignment: true, font: false, border: true, fill: false, protection: false }, ...fields }])[0];

it('names Center Across Selection and Excel\'s other lines as Format Cells does', () => {
  const def = style({ style: { align: 'centerContinuous' }, borders: [{ side: 'bottom', style: 'mediumDashDot', color: '#4a8dff' }, { side: 'top', style: 'hair' }] });
  expect(partSummary(def, 'alignment')).toBe('Center across selection horizontally, middle vertically');
  expect(partSummary(def, 'border')).toBe('Bottom medium dash-dot #4a8dff; Top hair');
  expect(partSummary(style({ style: { align: 'distributed' }, borders: [{ side: 'left', style: 'double' }] }), 'alignment')).toBe('Distributed horizontally, middle vertically');
  expect(partSummary(style({ style: {}, borders: [{ side: 'left', style: 'double' }] }), 'border')).toBe('Left double');
});
