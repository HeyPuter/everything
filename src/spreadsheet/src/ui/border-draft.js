/** Bound dialog inspection even for whole-line selections; untouched mixed edges stay untouched.
 * Each edge: [kind, message key of its name, style flag]. */
export const BORDER_EDGES = [
  ['top', 'borderDraft.top', 'bt'], ['bottom', 'borderDraft.bottom', 'bb'], ['left', 'borderDraft.left', 'bl'], ['right', 'borderDraft.right', 'br'],
  ['horizontal', 'borderDraft.insideHorizontal', 'bb'], ['vertical', 'borderDraft.insideVertical', 'br'],
];
export const penSignature = pen => pen && `${pen.style || 'thin'}:${pen.color || ''}`;

export function readBorderEdges(wb, sheetId, range) {
  const { r1, r2, c1, c2 } = range, rows = r2 - r1 + 1, cols = c2 - c1 + 1;
  const singleMerge = wb.mergesIn?.(sheetId, range)?.some(m => ['r1', 'r2', 'c1', 'c2'].every(key => m[key] === range[key]));
  const read = (r, c, side) => {
    const st = wb.styleAt?.(sheetId, r, c) || {};
    if (!st[side]) return null;
    const edge = st[`${side}Border`] || st;
    return { style: edge.bs || 'thin', color: edge.bc || null };
  };
  return new Map(BORDER_EDGES.map(([kind]) => {
    const noCap = ['top', 'bottom'].includes(kind) && ['columns', 'sheet'].includes(range.scope)
      || ['left', 'right'].includes(kind) && ['rows', 'sheet'].includes(range.scope)
      || singleMerge && ['horizontal', 'vertical'].includes(kind);
    const count = ['top', 'bottom'].includes(kind) ? cols : ['left', 'right'].includes(kind) ? rows
      : kind === 'horizontal' ? (rows - 1) * cols : (cols - 1) * rows;
    if (!count || noCap) return [kind, { on: false, pen: null, disabled: true }];
    if (count > 128) return [kind, { on: 'mixed', pen: null, disabled: false }];
    const segments = [];
    if (kind === 'top' || kind === 'bottom') for (let c = c1; c <= c2; c++) segments.push([read(kind === 'top' ? r1 : r2, c, kind === 'top' ? 'bt' : 'bb')]);
    else if (kind === 'left' || kind === 'right') for (let r = r1; r <= r2; r++) segments.push([read(r, kind === 'left' ? c1 : c2, kind === 'left' ? 'bl' : 'br')]);
    else if (kind === 'horizontal') for (let r = r1; r < r2; r++) for (let c = c1; c <= c2; c++) segments.push([read(r, c, 'bb'), read(r + 1, c, 'bt')]);
    else for (let r = r1; r <= r2; r++) for (let c = c1; c < c2; c++) segments.push([read(r, c, 'br'), read(r, c + 1, 'bl')]);
    const pens = segments.flat().filter(Boolean), allOn = segments.every(s => s.some(Boolean));
    const samePen = pens.every(p => penSignature(p) === penSignature(pens[0]));
    return [kind, { on: !pens.length ? false : allOn && samePen ? true : 'mixed', pen: samePen ? pens[0] || null : null, disabled: false }];
  }));
}
