import { nativeFillOverridesNormal, nativeFillPatch } from './native-fill.js';
import { compactRangeRecords, intersection } from './range-records.js';
import { parseKey } from './cell.js';
import { tableRows } from './tables.js';

/** Freeze only the table layer. Conditional rules remain live and direct fills
 * keep their existing precedence. Rectangles cover blank cells without storing
 * a cell for every position of a large, mostly empty table. */
export function tableConversionStyle(wb, sheet, table) {
  if (table.style === 'none') return { regions: [], cells: [] };
  const g = table.range, rows = tableRows(table);
  const rowCuts = new Set([g.r1, g.r1 + 1, g.r2, g.r2 + 1, rows.dataStart, rows.dataEnd, rows.dataEnd + 1]);
  const colCuts = new Set([g.c1, g.c1 + 1, g.c2, g.c2 + 1]);
  const cutLine = (cuts, line) => { cuts.add(line); cuts.add(line + 1); };
  for (const r of sheet.rowStyles.keys()) if (r >= g.r1 && r <= g.r2) cutLine(rowCuts, r);
  for (const c of sheet.colStyles.keys()) if (c >= g.c1 && c <= g.c2) cutLine(colCuts, c);
  for (const record of sheet.styleResets) {
    const hit = intersection(g, record.range);
    if (!hit) continue;
    rowCuts.add(hit.r1); rowCuts.add(hit.r2 + 1);
    colCuts.add(hit.c1); colCuts.add(hit.c2 + 1);
  }
  const hidden = [...new Set([...sheet.hiddenRows, ...sheet.filterHidden])]
    .filter(r => r >= rows.dataStart && r <= rows.dataEnd).sort((a, b) => a - b);
  const hiddenSet = new Set(hidden);
  const ordinal = r => {
    if (hiddenSet.has(r) || r < rows.dataStart || r > rows.dataEnd) return -1;
    let lo = 0, hi = hidden.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (hidden[mid] < r) lo = mid + 1; else hi = mid; }
    return r - rows.dataStart - lo;
  };
  if (table.banded) {
    const first = table.customStyle?.firstRowStripe?.stripeSize || 1;
    const second = table.customStyle?.secondRowStripe?.stripeSize || 1;
    let previous = null, visible = 0;
    for (let r = rows.dataStart; r <= rows.dataEnd; r++) {
      const stripe = hiddenSet.has(r) ? -1 : visible++ % (first + second) < first ? 1 : 2;
      if (stripe !== previous) rowCuts.add(r);
      previous = stripe;
    }
  }
  const patchAt = (r, c, own) => {
    const { coat, ...patch } = wb._tableStyleAt(sheet, r, c, own, ordinal(r)) || {};
    if (patch.bg !== undefined && nativeFillOverridesNormal(own, wb.nativeNormalFill)) delete patch.bg;
    return nativeFillPatch(patch);
  };
  const sorted = (cuts, lo, hi) => [...cuts].filter(n => n >= lo && n <= hi + 1).sort((a, b) => a - b);
  const rr = sorted(rowCuts, g.r1, g.r2), cc = sorted(colCuts, g.c1, g.c2);
  const regions = [];
  for (let i = 0; i < rr.length - 1; i++) for (let j = 0; j < cc.length - 1; j++) {
    const r = rr[i], c = cc[j], values = patchAt(r, c, wb._lineStyle(sheet, r, c) || null);
    if (Object.keys(values).length) regions.push({ range: { r1: r, r2: rr[i + 1] - 1, c1: c, c2: cc[j + 1] - 1 }, values });
  }
  const cells = [];
  for (const [key, cell] of sheet.cells) {
    const { r, c } = parseKey(key);
    if (r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) continue;
    const patch = patchAt(r, c, wb.styleAt(sheet.id, r, c));
    if (!Object.keys(patch).length) continue;
    // A key the patch takes away (nativeFill: null) is left out, as applyStyle leaves it out, unless it resets the line's.
    const style = { ...cell.s, ...patch }, line = wb._lineStyle(sheet, r, c);
    for (const k of Object.keys(style)) if (style[k] === null && line?.[k] == null) delete style[k];
    cells.push({ r, c, style });
  }
  return { regions: compactRangeRecords(regions, record => JSON.stringify(record.values)), cells };
}
