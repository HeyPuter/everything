/**
 * Cell style presets: one click gives a heading, a total row, an input cell, or a good/bad/neutral flag a
 * consistent look. Each preset is a style patch (see Workbook.applyStyle)
 * plus optional border strokes.
 */

// Sizes are in pixels, as cell styles store them: Title, Heading and Subheading are Excel's Title, Heading 1 and
// Heading 2 at 18, 15 and 13 points, so each stands above the 11-point text of a new spreadsheet. (At 20, 15 and
// 13 pixels, sized for a 13-pixel body, Heading came out 11.25 points and Subheading 9.75, smaller than the text.)
const pt = (points) => points * 4 / 3;

export const CELL_STYLES = [
  { key: 'normal', label: 'Normal', patch: { bold: null, italic: null, underline: null, strike: null, color: null, bg: null, size: null, bt: null, bb: null, bl: null, br: null, bc: null, bs: null }, borders: [{ kind: 'none' }] },
  { key: 'title', label: 'Title', patch: { bold: true, size: pt(18), color: null, bg: null } },
  { key: 'heading', label: 'Heading', patch: { bold: true, size: pt(15), color: '#1f3b73' }, borders: [{ kind: 'bottom', style: 'medium', color: '#4a8dff' }] },
  { key: 'subheading', label: 'Subheading', patch: { bold: true, size: pt(13), color: '#1f3b73' }, borders: [{ kind: 'bottom', style: 'thin', color: '#8fb8ff' }] },
  { key: 'total', label: 'Total', patch: { bold: true }, borders: [{ kind: 'top', style: 'thin', color: '#4a8dff' }, { kind: 'bottom', style: 'double', color: '#4a8dff' }] },
  { key: 'input', label: 'Input', patch: { color: '#1a5fd0', bg: '#fff9db' }, borders: [{ kind: 'outer', style: 'thin', color: '#c3c2b7' }] },
  { key: 'calc', label: 'Calculation', patch: { bold: true, color: '#9a4d00', bg: '#f2f1ee' }, borders: [{ kind: 'outer', style: 'thin', color: '#c3c2b7' }] },
  { key: 'good', label: 'Good', patch: { color: '#0b6b3a', bg: '#d8f3dc' } },
  { key: 'bad', label: 'Bad', patch: { color: '#9c1c1c', bg: '#ffd6d6' } },
  { key: 'neutral', label: 'Neutral', patch: { color: '#8a5a00', bg: '#fff1c2' } },
  { key: 'note', label: 'Note', patch: { bg: '#fff2cc' }, borders: [{ kind: 'outer', style: 'thin', color: '#bfbfbf' }] },
  { key: 'warning', label: 'Warning text', patch: { color: '#c22a2a' } },
];

export function cellStyle(key) {
  return CELL_STYLES.find((s) => s.key === key) || null;
}
