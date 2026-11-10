// Right-to-left paragraphs (ECMA-376 Part 1 §17.3.1.6 bidi).
//
// The stored paragraph properties are relative to the reading direction: `indentLeft` (w:ind left/start)
// is the indent at the leading edge, tab positions are measured from that edge, and `left` alignment
// (w:jc left/start) is the leading edge. In a right-to-left paragraph the leading edge is the right one.
//
// Layout therefore measures such a paragraph on the mirror image of its text area. In these "flow"
// coordinates the paragraph is an ordinary left-to-right one, so indents, hanging labels, tab fields,
// alignment and justification need no second implementation. A finished line is reflected back across
// the axis (x' = axis - x); text inside each tab field is ordered by the bidirectional algorithm from a
// right-to-left base and is not reflected.

/** The mirror image of a page, column or cell text area. `rtlAxis` reflects flow x to physical x. */
export const mirroredPage = page => ({ ...page, left: page.right, right: page.left, rtlAxis: page.width });

export const mirroredInterval = (interval, axis) => ({ ...interval, left: axis - interval.right, right: axis - interval.left });

/** Text regions beside floating objects, found in physical coordinates, in reading order from the right. */
export const mirroredRow = (row, axis) => ({ ...row, intervals: row.intervals.map(i => mirroredInterval(i, axis)).reverse() });

/**
 * Reflect a list label measured in flow coordinates. Its tab suffix was already built reflected. The
 * label is generated text in a right-to-left context: "1." reads ".1" and brackets keep their sense.
 * `labelDirection` asks the painter for that native ordering; the label's advance is unchanged.
 */
export function mirrorMarker(marker, axis) {
  marker.x = axis - marker.x - marker.width;
  marker.labelDirection = 'rtl';
  return marker;
}

/**
 * The stored alignment for a button that names a physical side, and back: in a right-to-left paragraph
 * the stored `left` is the right side. Centered, justified and distributed text read the same either way.
 */
export const physicalAlignment = (alignment, rtl) => rtl && alignment === 'left' ? 'right' : rtl && alignment === 'right' ? 'left' : alignment;
