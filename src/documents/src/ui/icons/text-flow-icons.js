/**
 * Text flow: line numbers and hyphenation.
 * Original drawings on the 20-unit grid, built from the shared helpers in command-icons.js.
 */
export function textFlowIcons({ p, r, ci, t, lines, page, sheet, badge }) {
  return {
    // Hyphenation: text lines where a word (the heavier stroke) breaks at the margin with a blue hyphen and continues below.
    hyphenation: lines(3.5, 4.5, 12.5, 1, 0, 'o ln') + p('M3.5 9.5h4M9.5 9.5h2.6', 'o thick') + p('M13.6 9.5h2.4', 'b thick') + p('M3.5 14.5h4.5', 'o thick') + p('M10 14.5h6', 'o ln') + p('M17.5 2.5v15', 'o dash ln'),
  };
}
