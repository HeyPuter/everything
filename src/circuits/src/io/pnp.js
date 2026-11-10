// Pick-and-place (component placement) file for assembly.

import { defOf, schDocs, csvRows, naturalCompare } from './common.js';
import { norm360 } from '../core/geom.js';

/**
 * Ids (uid) of the schematic parts marked "do not populate". The bill of
 * materials leaves those out, so the placement file must not place them.
 */
export function unpopulated(project) {
  const out = new Set();
  for (const doc of schDocs(project)) {
    for (const o of doc.objects || []) if (o.t === 'part' && o.dnp && o.uid) out.add(o.uid);
  }
  return out;
}

/**
 * CSV with Designator, Value, Footprint, X, Y (mm from the board origin), Rotation, Side.
 * skip: uids of components to leave out (see unpopulated).
 */
export function pickAndPlace(boardDoc, library, { skip } = {}) {
  const origin = boardDoc.board?.origin || { x: 0, y: 0 };
  const comps = (boardDoc.objects || []).filter((o) => o.t === 'comp' && !skip?.has(o.uid));
  comps.sort((a, b) => naturalCompare(a.designator, b.designator));
  const rows = [['Designator', 'Value', 'Footprint', 'X(mm)', 'Y(mm)', 'Rotation', 'Side']];
  for (const c of comps) {
    const def = defOf(library, c.comp);
    rows.push([
      c.designator,
      c.value ?? def?.value ?? '',
      def?.footprint?.name || '',
      ((c.x - origin.x) / 1e6).toFixed(4),
      ((c.y - origin.y) / 1e6).toFixed(4),
      norm360(c.rot || 0).toFixed(2).replace(/\.?0+$/, '') || '0',
      c.side === 'bottom' ? 'Bottom' : 'Top',
    ]);
  }
  return csvRows(rows);
}
