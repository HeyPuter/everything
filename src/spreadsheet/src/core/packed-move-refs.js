import { isAbsoluteRef, mapFormulaRefs, sameSheetName } from './refs.js';

/** Visible-row/column cuts are translations of contiguous runs. Index endpoints
 * instead of scanning every run for every formula in a fragmented selection. */
export function packedMoveReferences(source, target, rows, cols, r0, c0) {
  const rr = new Map(rows.map((r, i) => [r, i])), cc = new Map(cols.map((c, i) => [c, i]));
  const across = !sameSheetName(source, target);
  const moved = ref => {
    if (ref.sheetEnd || ['rows', 'cols'].includes(ref.kind)) return null;
    const r = rr.get(ref.r1), c = cc.get(ref.c1);
    if (r == null || c == null || rr.get(ref.r2) - r !== ref.r2 - ref.r1 || cc.get(ref.c2) - c !== ref.c2 - ref.c1) return null;
    return { ...ref, r1: r0 + r, r2: r0 + r + ref.r2 - ref.r1, c1: c0 + c, c2: c0 + c + ref.c2 - ref.c1 };
  };
  // The cells the block lands on are gone: a reference wholly inside them that the cut does not carry shows #REF!.
  const landedOn = (ref, sheet) => sameSheetName(sheet, target) && !ref.sheetEnd && !['rows', 'cols'].includes(ref.kind)
    && ref.r1 >= r0 && ref.r2 < r0 + rows.length && ref.c1 >= c0 && ref.c2 < c0 + cols.length;
  return {
    destinationCell: (r, c) => rr.has(r) && cc.has(c) ? { r: r0 + rr.get(r), c: c0 + cc.get(c) } : null,
    sourceCell: (r, c) => rr.has(r) && cc.has(c),
    targetCell: (r, c) => r >= r0 && r < r0 + rows.length && c >= c0 && c < c0 + cols.length,
    // A relative defined name's offsets stay put: only its wholly absolute references follow the cut.
    follow: (formula, owner, relativeName = false) => mapFormulaRefs(formula, ref => {
      if (relativeName && !isAbsoluteRef(ref)) return ref;
      const next = sameSheetName(ref.sheet ?? owner, source) && moved(ref);
      if (next) return { ...next, ...(ref.sheet != null || across ? { sheet: target } : {}) };
      return landedOn(ref, ref.sheet ?? owner) ? null : ref;
    }),
    carry: formula => mapFormulaRefs(formula, ref => {
      const next = sameSheetName(ref.sheet ?? source, source) && moved(ref);
      if (next) return { ...next, ...(ref.sheet != null ? { sheet: target } : {}) };
      if (landedOn(ref, ref.sheet ?? source)) return null;
      return across && ref.sheet == null ? { ...ref, sheet: source } : ref;
    }),
  };
}
