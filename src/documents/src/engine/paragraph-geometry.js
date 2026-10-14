import { TAB_LEADERS } from './tab-leaders.js';
/** Paragraph distances are integer twips (1/1440 inch). A negative firstLine is hanging. */
export const INDENT_KEYS = ['indentLeft', 'indentRight', 'firstLine'];
// A bar tab (§17.18.84 ST_TabJc bar) draws a vertical line and is not a stop for tab characters.
export const TAB_ALIGNMENTS = ['left', 'center', 'right', 'decimal', 'bar'];
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validateIndent(value) {
  if (!Number.isInteger(value) || Math.abs(value) > 31680) throw new Error('Indents must be valid measurements between −22 and 22 inches.');
  return value;
}

export function normalizeTabStops(tabs) {
  if (!Array.isArray(tabs) || tabs.length > 64) throw new Error('Use up to 64 custom tab stops per paragraph.');
  const positions = new Set();
  return tabs.map(tab => {
    if (!tab || !Number.isInteger(tab.position) || Math.abs(tab.position) > 31680) throw new Error('Tab positions must be valid measurements between −22 and 22 inches.');
    if (!TAB_ALIGNMENTS.includes(tab.alignment)) throw new Error('Choose a left, center, right, decimal or bar tab stop.');
    if (tab.leader !== undefined && !Object.hasOwn(TAB_LEADERS, tab.leader)) throw new Error('Choose a supported tab leader.');
    if (positions.has(tab.position)) throw new Error('Each tab stop needs a different position.');
    positions.add(tab.position);
    return { position: tab.position, alignment: tab.alignment, ...(tab.leader && tab.leader !== 'none' ? { leader: tab.leader } : {}), ...(tab.numberingOnly ? { numberingOnly: true } : {}) };
  }).sort((a, b) => a.position - b.position);
}

/** The text margin anchors tabs, including when an indent extends into that margin. */
export function paragraphEdges(format, page, first) {
  const left = page.left + (format.indentLeft + (first ? format.firstLine : 0)) / 15;
  const right = page.width - page.right - format.indentRight / 15;
  // An exhausted cell keeps its indented origin and consumes one item per
  // line, even for tiny glyphs. Do not invent a positive minimum writing width.
  // Physical cell clipping remains independent from these paragraph margins.
  if (page.tableDepth) return { left, right: Math.max(left, right) };
  // Twip-derived cell coordinates can subtract to just below the exact 1px
  // minimum. Tolerate arithmetic roundoff, not a narrower writing region.
  // Signed indents can extend the writing area beyond the paper. Lines wrap
  // against those declared edges; the page surface clips the resulting ink.
  if (right - left < 1 - 1e-6) throw new Error('These indents leave no writing space. Adjust the indents or margins.');
  return { left, right };
}
