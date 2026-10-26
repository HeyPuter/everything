import { placeColumnFlow } from './column-layout.js';
import { pageBounds } from './page-bounds.js';
import { paginateColumnWidths } from './unequal-columns.js';

// Balance without changing the source model. Unequal-width trials resolve
// measurements against each trial's column boundaries. Full-height pagination
// establishes which keep constraints can be honored by the shorter region.
export function paginateColumnRegion(blocks, page, paginate, maxPages, startY, previousAfter = 0, balance = false) {
  const count = page.columns?.count || 1;
  const bounds = index => pageBounds(page, index);
  // Text above on the same page: keep and widow rules move a paragraph on rather than starting it here.
  const shared = startY > bounds(0).top + 1e-6;
  const regionPage = (last = -1, height = 0) => ({ ...page, ...(shared ? { startsOccupied: true } : {}),
    // Required empty boundaries extend the last column after balancing its content.
    // Preserve the physical-page limit rather than the shorter trial limit.
    ...(last >= 0 ? { balanceBoundaryBottom: bounds(last).bottom } : {}),
    boundsBase: { top: page.top, bottom: page.bottom, height: page.height }, boundsOrigin: 0,
    pageBounds: index => {
      const b = bounds(index), top = index === 0 ? Math.max(b.top, startY) : b.top;
      return { top, bottom: index === last ? Math.min(b.bottom, top + height) : b.bottom };
    },
  });
  const run = geometry => paginateColumnWidths(blocks, geometry, paginate, maxPages * count, startY, previousAfter);
  let result = run(regionPage());
  if (!balance || count === 1) return placeColumnFlow(result, page);
  const last = Math.ceil(result.pageCount / count) - 1;
  const top = last === 0 ? Math.max(bounds(last).top, startY) : bounds(last).top;
  const natural = new Map(result.lines.map(line => [line.start, line.page]));
  const keep = [];
  let chain = [];
  for (const block of blocks) {
    const lines = block.lines?.filter(line => !line.virtual) || [];
    if (block.format.keepLines && lines.length) keep.push(lines.map(line => line.start));
    if (chain.length || block.format.keepNext) chain.push(...lines.map(line => line.start));
    if (!block.format.keepNext || lines.some(line => ['page', 'column'].includes(line.hardBreak))) {
      if (chain.length) keep.push(chain);
      chain = [];
    }
  }
  if (chain.length) keep.push(chain);
  const constrained = keep.filter(group => group.every(start => natural.get(start) === natural.get(group[0])));
  // Widow and orphan control holds in balanced columns too: a shorter region must not leave one line of
  // a paragraph alone in a column where the full-height layout kept at least two together.
  const controlled = blocks.filter(block => block.format?.widowControl).map(block => (block.lines || []).filter(line => !line.virtual).map(line => line.start)).filter(group => group.length > 1);
  const alone = positions => controlled.map(group => {
    const counts = new Map();
    for (const start of group) counts.set(positions.get(start), (counts.get(positions.get(start)) || 0) + 1);
    return [...counts.values()].filter(n => n === 1).length;
  });
  const naturalAlone = alone(natural);
  const fits = (trial, height) => {
    if (Math.ceil(trial.pageCount / count) > last + 1) return false;
    const positions = new Map(trial.lines.map(line => [line.start, line.page]));
    if (constrained.some(group => group.some(start => positions.get(start) !== positions.get(group[0])))) return false;
    if (alone(positions).some((n, i) => n > naturalAlone[i])) return false;
    // A paginator may retain an oversized first line or clipped table cell.
    // Such overflow must not make an artificially short balancing trial pass.
    return trial.lines.every(line => line.virtual || line.continuousBoundaryLine || Math.floor(line.page / count) !== last ||
      Math.min(line.y + line.height, line.cellClip?.bottom ?? Infinity) <= top + height + 1e-6) &&
      trial.cells.every(cell => Math.floor(cell.page / count) !== last || cell.y + cell.height <= top + height + 1e-6);
  };
  let low = 1, high = Math.ceil((bounds(last).bottom - top) * 15);
  let best = result, bestHeight = high / 15;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), height = middle / 15;
    let trial;
    try { trial = run(regionPage(last, height)); }
    catch (error) {
      if (!error.message.startsWith('This preview supports up to ')) throw error;
    }
    if (trial && fits(trial, height)) { best = trial; bestHeight = height; high = middle - 1; }
    else low = middle + 1;
  }
  result = placeColumnFlow(best, page);
  return { ...result, endY: Math.max(top + bestHeight, best.endY) };
}
