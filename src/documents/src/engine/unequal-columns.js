import { sectionColumnIntervals } from './section-columns.js';
import { columnFlowPage } from './column-layout.js';

// Resolve widths against actual pagination, including paragraph continuations.
// Measurements remain separate from placement: the owning layout supplies the
// remeasurement callback, and each trial owns its immutable measured blocks.
export function paginateColumnWidths(blocks, geometry, paginate, maxPages, startY, previousAfter) {
  const flow = columnFlowPage(geometry);
  if (!geometry.columns || !blocks.remeasure) return paginate(blocks, flow, maxPages, startY, previousAfter);
  const widths = sectionColumnIntervals(geometry.columns, geometry.left * 15,
    (geometry.width - geometry.left - geometry.right) * 15).map(c => (c.right-c.left)/15);
  if (widths.every(w => Math.abs(w-widths[0]) < 1e-6)) return paginate(blocks, flow, maxPages, startY, previousAfter);
  let measured = blocks, fitting = null;
  const signatures = new Set();
  const measuredWidth = l => l.columnMeasureWidth ?? widths[0], columnWidth = l => widths[l.page % widths.length];
  // Each attempt lays out the whole section again. Wrapping settles with fewer lines in the wrong width each
  // time (a long flow a few pages per attempt); a paragraph whose lines move between a narrow and a wide
  // column as they are rewrapped can alternate for ever, so attempts stop once they stop helping.
  let fewest = Infinity, stalled = 0;
  for (let attempt = 0; attempt < maxPages * 2 + 8 && stalled < STALLED_ATTEMPTS; attempt++) {
    const result = paginate(measured, flow, maxPages, startY, previousAfter);
    const lines = result.lines.filter(l => !l.cellId);
    const wrong = lines.filter(l => Math.abs(measuredWidth(l) - columnWidth(l)) >= 1e-6).length;
    if (!wrong) return result;
    if (wrong < fewest) { fewest = wrong; stalled = 0; } else stalled++;
    // A layout whose lines all fit their columns (some wrapped narrower than they could be) is a fallback.
    if (lines.every(l => measuredWidth(l) <= columnWidth(l) + 1e-6)) fitting = result;
    const boundaries = lines.map(l => ({ start: l.start, width: columnWidth(l) }));
    const signature = JSON.stringify(boundaries);
    if (signatures.has(signature)) break;
    signatures.add(signature);
    const widthAt = offset => {
      let lo=0, hi=boundaries.length;
      while(lo<hi) { const mid=(lo+hi)>>>1; if(boundaries[mid].start<=offset)lo=mid+1;else hi=mid; }
      return boundaries[Math.max(0,lo-1)]?.width ?? widths[0];
    };
    measured = blocks.remeasure(widthAt);
  }
  // No stable wrapping: keep the last layout that fits, or wrap every line to the narrowest column, which
  // fits in any of them, rather than refusing the document's layout.
  if (fitting) return fitting;
  const narrowest = Math.min(...widths);
  return paginate(blocks.remeasure(() => narrowest), flow, maxPages, startY, previousAfter);
}

// Attempts in a row that leave as many lines in the wrong width as before, after which wrapping is taken
// not to settle.
const STALLED_ATTEMPTS = 3;
