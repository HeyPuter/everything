import { mapConditionalFormulas, conditionalPredicateField } from './conditional-scale.js';
/** Keep sparse rule expressions attached to their data during whole-line edits. */
import { mapFormulaRefs, shiftFormula, adjustRefForInsert, adjustRefForDeletedLines, deleteMap, sameSheetName, MAX_ROW, MAX_COL } from './refs.js';
import { isRangeSource } from './validation.js';
import { splitRulePieces } from './conditional-groups.js';

/**
 * `lines`, for a deletion: the deleteMap of every run deleted at once (at and count are then ignored), so a rule is
 * rewritten once for a deletion of thousands of scattered rows rather than once per run, which made deleting the
 * rows a filter shows on a sheet of many rules take seconds. One run's map gives what deleting that run gives.
 */
export function adjustLineRules(rules, field, { ownerSheet, sheetName, axis, at, count, remove, lines = null, sheetsBetween, newId, moveTargets = true, referenceFilter = () => true }) {
  const deleted = remove ? lines || deleteMap([{ from: at, to: at + count - 1 }]) : null;
  const runs = remove ? deleted.runs : [];
  const adjustRef = (ref) => (remove ? adjustRefForDeletedLines(ref, axis, deleted) : adjustRefForInsert(ref, axis, at, count));
  // Call `add` with the edges, less `offset`, of the deleted runs that can fall within lines lo..hi + 1: found by a
  // binary search over the sorted runs, so a rule costs the runs near it, not every run of the deletion.
  const runEdges = (lo, hi, offset, add) => {
    let a = 0, b = runs.length;
    while (a < b) { const m = (a + b) >> 1; if (runs[m].to + 1 - offset < lo) a = m + 1; else b = m; }
    for (let i = a; i < runs.length && runs[i].from - offset <= hi + 1; i++) { add(runs[i].from - offset); add(runs[i].to + 1 - offset); }
  };
  const lo = axis === 'row' ? 'r1' : 'c1', hi = axis === 'row' ? 'r2' : 'c2';
  const absLo = axis === 'row' ? 'absR1' : 'absC1', absHi = axis === 'row' ? 'absR2' : 'absC2';
  const same = name => sameSheetName(name, sheetName);
  const moves = moveTargets && same(ownerSheet);
  const affected = ref => referenceFilter(ref) && (ref.sheetEnd ? (sheetsBetween(ref.sheet, ref.sheetEnd) || []).some(same) : same(ref.sheet || ownerSheet));
  const wholeAxis = ref => ref.kind === (axis === 'row' ? 'cols' : 'rows');
  const mapRange = range => {
    if (!moves) return range;
    if (!remove) return adjustRefForInsert(range, axis, at, count);
    const next = adjustRefForDeletedLines(range, axis, deleted);
    // Lines deleted above, the grid fills in blank ones at its end: a rule that reached the last line (A:A) still does.
    const edge = axis === 'row' ? MAX_ROW : MAX_COL;
    return next && range[hi] >= edge ? { ...next, [hi]: edge } : next;
  };
  const requestedField = field;
  return rules.flatMap(rule => {
    const field = requestedField === 'value' ? conditionalPredicateField(rule) || 'value' : requestedField;
    // Statistical sources are fixed sheet formulas, not candidate-relative tests.
    if (requestedField === 'value') rule = mapConditionalFormulas(rule, (formula, key) => key === conditionalPredicateField(rule) ? formula : mapFormulaRefs(formula, ref => {
      if (!affected(ref) || wholeAxis(ref)) return ref;
      return adjustRef(ref);
    }));
    const relative = !!conditionalPredicateField(rule) || (field === 'source' && rule.type === 'list' && rule.relativeSource === true && isRangeSource(rule.source));
    const expression = !!conditionalPredicateField(rule) || (field === 'source' && rule.type === 'list' && isRangeSource(rule.source));
    if (!expression) { const range = mapRange(rule.range); return range ? [{ ...rule, range }] : []; }
    const formula = String(rule[field] ?? ''), origin = rule.range;
    const boundaries = new Set([origin[lo], origin[hi] + 1]);
    const add = n => { if (n > origin[lo] && n <= origin[hi]) boundaries.add(n); };
    if (moves) { if (remove) runEdges(origin[lo], origin[hi], 0, add); else add(at); }
    // A relative endpoint can cross the edit at a different candidate than
    // the rule's own range. Each interval has one consistent transformation.
    if (relative) mapFormulaRefs(formula, ref => {
      if (!affected(ref) || wholeAxis(ref)) return ref;
      for (const [coord, absolute] of [[lo, absLo], [hi, absHi]]) if (!ref[absolute]) {
        const offset = ref[coord] - origin[lo];
        if (remove) runEdges(origin[lo], origin[hi], offset, add); else add(at - offset);
      }
      return ref;
    });
    const points = [...boundaries].sort((a,b) => a-b), parts = [];
    for (let i = 0; i < points.length - 1; i++) {
      const old = { ...origin, [lo]: points[i], [hi]: points[i+1] - 1 };
      const range = mapRange(old); if (!range) continue;
      if (moves && !remove && old[hi] === at - 1 && origin[hi] >= at) range[hi] += count;
      const dr = relative ? old.r1 - origin.r1 : 0, dc = relative ? old.c1 - origin.c1 : 0;
      const source = mapFormulaRefs(shiftFormula(formula, dr, dc), ref => {
        if (!affected(ref) || wholeAxis(ref)) return ref;
        const next = adjustRef(ref);
        if (next && remove && relative) {
          // An endpoint clipped by deletion stays at the deletion boundary
          // throughout this interval instead of moving with the candidate.
          for (const [coord, absolute] of [[lo, absLo], [hi, absHi]]) {
            if (deleted.deleted(ref[coord])) next[absolute] = true;
          }
        }
        return next;
      });
      const prev = parts.at(-1);
      if (prev && prev.range[hi] + 1 === range[lo] && source === (relative ? shiftFormula(prev[field], range.r1 - prev.range.r1, range.c1 - prev.range.c1) : prev[field])) prev.range[hi] = range[hi];
      else parts.push({ ...rule, range: { ...range }, [field]: source });
    }
    return (requestedField === 'value' ? splitRulePieces(rule, parts) : parts).map((part, i) => i ? { ...part, id: newId() } : part);
  });
}

/** Split on the perpendicular axis before applying an insertion/deletion. */
export function adjustBlockRules(rules, field, options) {
  const { axis, bandStart, bandEnd, sheetName, ownerSheet, newId } = options;
  const lo = axis === 'row' ? 'c1' : 'r1', hi = axis === 'row' ? 'c2' : 'r2';
  const absLo = axis === 'row' ? 'absC1' : 'absR1', absHi = axis === 'row' ? 'absC2' : 'absR2';
  const same = name => sameSheetName(name, sheetName);
  const inside = range => range[lo] >= bandStart && range[hi] <= bandEnd;
  // Match ordinary cell formulas: only bounded references wholly inside the
  // shifted band follow a block edit; spanning ranges retain their addresses.
  const referenceFilter = ref => ref.kind !== 'rows' && ref.kind !== 'cols' && inside(ref)
    && (!ref.sheetEnd || same(ref.sheet));
  const requestedField = field;
  return rules.flatMap(rule => {
    const field = requestedField === 'value' ? conditionalPredicateField(rule) || 'value' : requestedField;
    const relative = !!conditionalPredicateField(rule) || (field === 'source' && rule.type === 'list' && rule.relativeSource === true && isRangeSource(rule.source));
    const origin = rule.range, boundaries = new Set([origin[lo], origin[hi] + 1]);
    const add = n => { if (n > origin[lo] && n <= origin[hi]) boundaries.add(n); };
    if (same(ownerSheet)) { add(bandStart); add(bandEnd + 1); }
    if (relative) mapFormulaRefs(String(rule[field] ?? ''), ref => {
      if (!same(ref.sheet || ownerSheet) || ref.kind === 'rows' || ref.kind === 'cols') return ref;
      for (const [coord, absolute] of [[lo, absLo], [hi, absHi]]) if (!ref[absolute]) {
        const offset = ref[coord] - origin[lo];
        add(bandStart - offset); add(bandEnd + 1 - offset);
      }
      return ref;
    });
    const points = [...boundaries].sort((a,b) => a-b), parts = [];
    for (let i = 0; i < points.length - 1; i++) {
      const range = { ...origin, [lo]: points[i], [hi]: points[i+1] - 1 };
      const stripe = { ...rule, range, ...(relative ? { [field]: shiftFormula(String(rule[field] ?? ''), range.r1-origin.r1, range.c1-origin.c1) } : {}) };
      parts.push(...adjustLineRules([stripe], requestedField, { ...options, moveTargets: inside(range), referenceFilter }));
    }
    return (requestedField === 'value' ? splitRulePieces(rule, parts) : parts).map((part,i) => ({ ...part, id: i ? newId() : rule.id }));
  });
}
