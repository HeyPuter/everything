/**
 * Text flow: line numbers and hyphenation.
 * Original drawings on the 20-unit grid, built from the shared helpers in command-icons.js.
 */
export function textFlowIcons({ p, r, ci, t, lines, page, sheet, badge }) {
  return {
    // Line numbers: a page with its text margin dashed, small blue numbers in the margin beside each line.
    lineNumbers: sheet(2.5, 2.5, 15, 15) + p('M7.5 2.5v15', 'b dash') + ['1', '2', '3'].map((n, i) => t(5, 7 + i * 4, n, 3.6, { weight: 700, c: 'txb' })).join('') + lines(9.5, 5.6, 6, 3, 4, 'o'),
  };
}
