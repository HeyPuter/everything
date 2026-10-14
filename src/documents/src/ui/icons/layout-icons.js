/**
 * Layout tab: margins, orientation, size, columns, breaks and page setup.
 * Original drawings on the 20-unit grid, built from the shared helpers in command-icons.js.
 */
export function layoutIcons({ p, r, t, lines, sheet, settingsBadge }) {
  /** A page with its text area inset by the given margins (in grid units). */
  const margined = (left, right, top, bottom, x = 4.5, y = 2.5, w = 11, h = 15) => sheet(x, y, w, h)
    + r(x + left, y + top, w - left - right, h - top - bottom, 'bw', 0.6) + r(x + left, y + top, w - left - right, h - top - bottom, 'b dash', 0.6);
  /** Text lines filling a column. */
  const text = (x, y, w, n, gap = 2) => lines(x, y, w, n, gap, 'o ln');
  /** A dashed break line across a page with a label. */
  const breakLine = (y, label) => p(`M2.5 ${y}h15`, 'b dash') + (label ? t(10, y - 1.2, label, 3.6, { weight: 600, c: 'txb' }) : '');
  const pageTop = (y = 2.5, h = 6) => p(`M4.5 ${y + h}V${y + 1.2}a1.2 1.2 0 0 1 1.2-1.2h8.6a1.2 1.2 0 0 1 1.2 1.2V${y + h}`, 'of');
  const pageBottom = (y = 11.5, h = 6) => p(`M4.5 ${y}V${y + h - 1.2}a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2V${y}`, 'of');
  const columnBlock = (spec) => sheet(3, 2.5, 14, 15) + spec.map(([x, w]) => text(x, 5, w, 6, 2)).join('');
  return {
    marginsNormal: margined(2, 2, 2, 2) + text(7.5, 6.5, 5, 4, 2),
    marginsNarrow: margined(1, 1, 1, 1) + text(6.5, 5.5, 7, 5, 2),
    marginsModerate: margined(1.5, 1.5, 2, 2) + text(7, 6.5, 6, 4, 2),
    marginsWide: margined(3.5, 3.5, 2, 2) + text(9, 6.5, 2, 4, 2),
    marginsMirrored: sheet(1.5, 3.5, 8.5, 13) + sheet(10, 3.5, 8.5, 13)
      + r(3, 5, 5, 10, 'b dash', 0.6) + r(11.5, 5, 5, 10, 'b dash', 0.6) + text(3.8, 7, 3.4, 3, 2) + text(12.3, 7, 3.4, 3, 2),
    marginsCustom: margined(2.5, 1.5, 2, 3) + text(8, 6.5, 4, 3, 2) + settingsBadge(15.5, 15.5),
    portrait: sheet(5.5, 2.5, 9, 15) + text(7.5, 6, 5, 5, 2),
    landscape: sheet(2.5, 5.5, 15, 9) + text(4.5, 8, 11, 3, 2),
    paperSize: sheet(2.5, 6.5, 8, 11) + r(7.5, 2.5, 10, 13, 'bf glassy', 1.2) + p('M9.5 13.5l6-6M13.5 7.5h2v2M11.5 13.5h-2v-2', 'b'),
    columnsOne: columnBlock([[5, 10]]),
    columnsTwo: columnBlock([[5, 4.2], [10.8, 4.2]]),
    columnsThree: columnBlock([[5, 2.6], [8.7, 2.6], [12.4, 2.6]]),
    columnsLeft: columnBlock([[5, 2.6], [8.7, 6.3]]),
    columnsRight: columnBlock([[5, 6.3], [12.4, 2.6]]),
    columnsDialog: columnBlock([[5, 4.2], [10.8, 4.2]]) + settingsBadge(15.5, 15.5),
    breakPage: pageTop(1.5) + pageBottom(12.5) + p('M2.5 10h15', 'b dash'),
    breakColumn: sheet(3, 2.5, 14, 15) + text(5, 5, 4.2, 3, 2) + text(10.8, 9, 4.2, 4, 2) + p('M7.1 11.5v3.5h3.5', 'b') + p('M9.5 13.8l1.2 1.2-1.2 1.2', 'b'),
    breakTextWrapping: sheet(3, 2.5, 14, 15) + lines(5, 6, 10, 1, 2, 'o ln') + p('M5 9.5h6.5', 'o ln') + p('M13.5 8.5v3h-6.5', 'b') + p('M8.5 10l-1.5 1.5 1.5 1.5', 'b') + lines(5, 14.5, 10, 1, 2, 'o ln'),
    breakNextPage: pageTop(1.5) + pageBottom(12.5) + breakLine(10) + p('M10 12.5v4', 'b') + p('M8.5 15l1.5 1.5 1.5-1.5', 'b'),
    breakContinuous: sheet(3, 2.5, 14, 15) + text(5, 5, 10, 2, 2) + breakLine(9.5) + text(5, 12, 4.2, 3, 2) + text(10.8, 12, 4.2, 3, 2),
    breakEvenPage: pageTop(1.5) + pageBottom(12.5) + breakLine(10) + t(10, 16.6, '2', 4.2, { weight: 700, c: 'txb' }),
    breakOddPage: pageTop(1.5) + pageBottom(12.5) + breakLine(10) + t(10, 16.6, '3', 4.2, { weight: 700, c: 'txb' }),
  };
}
