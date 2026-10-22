import { copyPivotRuleBindings } from './native-pivot-rule-bindings.js';
/** Live conditional formats travel beside clipboard cells, in source priority order. */
import { duplicateSourceFormula, duplicateSourceAreas } from './conditional-duplicates.js';
import { shiftFormula } from './refs.js';
import { cloneStyle } from './style-values.js';
import { conditionalFormulaFields, mapConditionalFormulas, conditionalPredicateField, rebaseConditionalPredicate } from './conditional-scale.js';
import { intersection, clearRangeRecordsAtCells, compactRangeRecords, removeRangeRecords, rangesCoveringCells } from './range-records.js';
import { sameConditionalRule } from './conditional-groups.js';

const sameRange = (a, b) => ['r1', 'c1', 'r2', 'c2'].every(k => a[k] === b[k]);
const statistical = new Set(['dup', 'unique', 'top', 'bottom', 'scale', 'databar', 'icons']);
const copyRule = rule => ({ ...rule, range: { ...rule.range }, style: cloneStyle(rule.style) });

function nativeDuplicateDomains(rules, sheetName) {
  const groups = new Map(), native = new Set();
  for (const rule of rules) if (['dup', 'unique'].includes(rule.type) && rule.duplicateRange) {
    const key = JSON.stringify([rule.type, rule.duplicateRange, rule.style, rule.stopIfTrue]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  const covers = (areas, coverage) => areas.every(range => {
    let remaining = [{ range }];
    for (const g of coverage) { remaining = removeRangeRecords(remaining, g); if (!remaining.length) return true; }
    return false;
  });
  for (const group of groups.values()) {
    const areas = duplicateSourceAreas(group[0].duplicateRange);
    if (!areas?.length || areas.some(g => g.sheet && g.sheet.toLowerCase() !== sheetName?.toLowerCase())) continue;
    const targets = group.map(rule => rule.range);
    if (covers(areas, targets) && covers(targets, areas)) for (const rule of group) native.add(rule);
  }
  return native;
}

export function copyConditionalFormats(rules, rows, cols, sheetName) {
  const native = nativeDuplicateDomains(rules, sheetName);
  const extent = (lines, lo, hi) => {
    const first = lines.findIndex(n => n >= lo && n <= hi);
    if (first < 0) return null;
    let last = first;
    while (last + 1 < lines.length && lines[last + 1] >= lo && lines[last + 1] <= hi) last++;
    return [first, last];
  };
  return rules.flatMap(rule => {
    const rr = extent(rows, rule.range.r1, rule.range.r2), cc = extent(cols, rule.range.c1, rule.range.c2);
    return rr && cc ? [{ ...(native.has(rule) ? { nativeDuplicates: true } : {}), rule: copyRule(rule), range: { r1: rr[0], c1: cc[0], r2: rr[1], c2: cc[1] }, source: { r: rows[rr[0]], c: cols[cc[0]] } }] : [];
  });
}

export function mapPastedConditionalFormats(copied, h, w, r0, c0, repeat, transpose = false, pivotRuleCopies = null) {
  if (!Array.isArray(copied)) return null;
  const out = [], groups = new Map();
  // One statistical domain covers the entire repeated paste. When a
  // rule fills a copied dimension, join adjacent tiles before materializing
  // them. Fixed threshold formulas must agree; bands restart in each tile.
  for (const [itemIndex, item] of copied.entries()) {
    const g = item.range;
    const join = (axis, size, count) => {
      if (item.rule.pivotRuleIds?.length || transpose || item.rule.type === 'bands' || g[axis === 'r' ? 'r1' : 'c1'] !== 0
        || g[axis === 'r' ? 'r2' : 'c2'] !== size - 1) return false;
      const dr = axis === 'r' ? (count - 1) * size : 0, dc = axis === 'c' ? (count - 1) * size : 0;
      return conditionalFormulaFields(item.rule).every(key => {
        if (['statisticsRange', 'bandOrigin'].includes(key)) return true;
        const formula = item.rule[key];
        if (key !== conditionalPredicateField(item.rule)) return shiftFormula(formula, dr, dc) === formula;
        const first = shiftFormula(formula, r0 + g.r1 - item.rule.range.r1, c0 + g.c1 - item.rule.range.c1);
        // A reference can recover only after moving in both axes, so checking
        // each axis's end independently is insufficient for an invalid corner.
        if (/#REF!/i.test(first)) return false;
        return shiftFormula(first, dr, dc) === shiftFormula(formula, r0 + g.r1 - item.rule.range.r1 + dr, c0 + g.c1 - item.rule.range.c1 + dc);
      });
    };
    const joinRows = join('r', h, repeat.rows), joinCols = join('c', w, repeat.cols);
    for (let ry = 0; ry < (joinRows ? 1 : repeat.rows); ry++) for (let rx = 0; rx < (joinCols ? 1 : repeat.cols); rx++) {
      const r = r0 + ry * h, c = c0 + rx * w;
      const range = transpose ? { r1: r + g.c1, c1: c + g.r1, r2: r + g.c2, c2: c + g.r2 }
        : { r1: r + g.r1, c1: c + g.c1, r2: r + g.r2 + (joinRows ? (repeat.rows - 1) * h : 0), c2: c + g.c2 + (joinCols ? (repeat.cols - 1) * w : 0) };
      const rule = mapConditionalFormulas(item.rule, (formula, key) => {
        // Predicate formulas are relative to the rule's corner. Threshold
        // formulas have a fixed sheet anchor and shift only by the copied move.
        const anchor = key === conditionalPredicateField(item.rule) ? { r: item.rule.range.r1, c: item.rule.range.c1 } : item.source;
        return shiftFormula(formula, range.r1 - anchor.r, range.c1 - anchor.c);
      });
      const moved = { ...copyPivotRuleBindings(copyRule(rule), pivotRuleCopies?.(ry, rx)), range };
      delete moved.statisticsRange; delete moved.bandOrigin;
      out.push(moved);
      if (statistical.has(item.rule.type)) {
        const { id, range: originalRange, ...settings } = item.rule;
        const key = JSON.stringify([item.rule.statisticsRange || item.nativeDuplicates ? settings : itemIndex, item.nativeDuplicates]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ rule: moved, native: item.nativeDuplicates === true });
      }
    }
  }
  for (const group of groups.values()) {
    const ranges = compactRangeRecords(group.map(({ rule }) => ({ range: rule.range })), () => 0).map(item => item.range);
    const source = duplicateSourceFormula(ranges);
    for (const { rule, native } of group) {
      if (group.length > 1 || native) rule.statisticsRange = source;
      if (native) rule.duplicateRange = source;
    }
  }
  return out;
}

function scoped(rule, ranges, removed = null, native = false, sheetName = null) {
  if (rule.type === 'bands') return { ...rule, bandOrigin: rule.bandOrigin || duplicateSourceFormula([rule.range]) };
  if (removed && rule.statisticsRange) {
    const source = (duplicateSourceAreas(rule.statisticsRange) || []).map(range => ({ range }));
    const local = [], foreign = [];
    for (const item of source) {
      if (item.range.sheet && item.range.sheet.toLowerCase() !== sheetName?.toLowerCase()) foreign.push(item);
      else { const { sheet, ...range } = item.range; local.push({ range }); }
    }
    ranges = [...compactRangeRecords(clearRangeRecordsAtCells(local, removed), () => 0), ...foreign].map(item => item.range);
  }
  const source = duplicateSourceFormula(ranges);
  return statistical.has(rule.type) ? { ...rule, statisticsRange: source, ...(native ? { duplicateRange: source } : {}) } : rule;
}

function piece(rule, range, id) {
  return { ...copyRule(rebaseConditionalPredicate(rule, range.r1 - rule.range.r1, range.c1 - rule.range.c1)), id, range };
}

/** Replace only cells actually accepted by a paste; preserve outside formulas' anchors. */
export function replaceConditionalFormats(saved, incoming, cells, newId, sheetName) {
  if (incoming === null || !cells.length || !saved.length && !incoming.length) return saved;
  const native = nativeDuplicateDomains(saved, sheetName);
  const records = saved.map((rule, index) => ({ range: rule.range, rule, index }));
  const coverage = incoming.length ? rangesCoveringCells(cells) : [];
  // A rule pasted over cells the same rule already covers (the format painter run inside a ranked column, formats
  // pasted within one colour scale) leaves them to that rule, rather than cutting them out of it as a rule of
  // their own that ranks only its own values.
  const kept = [], pastedOver = new Map(), keptAt = new Map();
  // The pasted rules by the bands of 16 rows they reach (a tall one is looked at for every rule), so a paste of
  // thousands of rules over thousands does not compare every pair.
  const bands = new Map(), tall = [], seen = new Int32Array(incoming.length).fill(-1);
  incoming.forEach((rule, i) => {
    const from = rule.range.r1 >> 4, to = rule.range.r2 >> 4;
    if (to - from > 64) { tall.push(i); return; }
    for (let b = from; b <= to; b++) { if (!bands.has(b)) bands.set(b, []); bands.get(b).push(i); }
  });
  if (incoming.length) for (const [index, rule] of saved.entries()) {
    let cuts = [], copies = 0;
    const g = rule.range, near = [...tall];
    if (g.r2 - g.r1 > 1 << 16) near.push(...incoming.keys());
    else for (let b = g.r1 >> 4; b <= g.r2 >> 4; b++) for (const i of bands.get(b) || []) if (seen[i] !== index) { seen[i] = index; near.push(i); }
    for (const i of near) {
      const pasted = incoming[i], p = pasted.range;
      if (pasted.type !== rule.type || p.r1 > g.r2 || p.r2 < g.r1 || p.c1 > g.c2 || p.c2 < g.c1 || !sameConditionalRule(rule, pasted)) continue;
      const area = intersection(g, p);
      const over = coverage.map(({ range }) => intersection(area, range)).filter(Boolean);
      if (!over.length) continue;
      copies++;
      cuts.push(...over);
      if (!pastedOver.has(i)) pastedOver.set(i, []);
      pastedOver.get(i).push(...over);
    }
    // Cells two copies of the rule were pasted over stay with it once.
    if (copies > 1) cuts = cuts.reduce((list, cut) => [...removeRangeRecords(list, cut), { range: cut }], []).map(item => item.range);
    for (const range of cuts) kept.push({ range, rule, index });
    // Pieces of one rule share a statistical domain: every piece keeps the cells any of them kept.
    const key = `domain:${rule.statisticsRange}`;
    if (cuts.length && rule.statisticsRange) keptAt.set(key, [...(keptAt.get(key) || []), ...cuts]);
  }
  const remaining = [...clearRangeRecordsAtCells(records, cells), ...kept];
  const pieces = compactRangeRecords(remaining, r => r.index).sort((a, b) => a.index - b.index);
  const domains = new Map();
  for (const item of pieces) {
    if (!domains.has(item.index)) domains.set(item.index, []);
    domains.get(item.index).push(item.range);
  }
  const left = pieces.map(({ rule, range, index }) => {
    const same = sameRange(rule.range, range);
    // The cells a rule kept are still among the values it ranks (only an explicit domain reads them).
    const own = rule.statisticsRange && keptAt.get(`domain:${rule.statisticsRange}`);
    const removed = own ? cells.filter(({ r, c }) => !own.some(g => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2)) : cells;
    const updated = !same || rule.statisticsRange || native.has(rule) ? scoped(native.has(rule) ? { ...rule, statisticsRange: rule.duplicateRange } : rule, domains.get(index), removed, native.has(rule), sheetName) : rule;
    const unchanged = updated.statisticsRange === rule.statisticsRange
      || native.has(rule) && !rule.statisticsRange && updated.duplicateRange === rule.duplicateRange;
    return same && unchanged ? rule : piece(updated, range, same ? rule.id : newId());
  });
  if (!incoming.length) return left.length === saved.length && left.every((rule, i) => rule === saved[i]) ? saved : left;
  const added = incoming.flatMap((rule, i) => {
    // The cells left to the rule they already had are no longer this copy's.
    const within = area => (pastedOver.get(i) || []).reduce((list, cut) => removeRangeRecords(list, cut),
      coverage.flatMap(({ range }) => { const cut = intersection(area, range); return cut ? [{ range: cut }] : []; })).map(item => item.range);
    const ranges = within(rule.range);
    const source = rule.statisticsRange && duplicateSourceAreas(rule.statisticsRange);
    const domain = source ? source.flatMap(within) : ranges;
    const shared = statistical.has(rule.type) && (domain.length > 1 || source) ? { ...rule, statisticsRange: duplicateSourceFormula(domain),
      ...(rule.statisticsRange && rule.duplicateRange === rule.statisticsRange ? { duplicateRange: duplicateSourceFormula(domain) } : {}) } : rule;
    const withBandOrigin = rule.type === 'bands' && ranges.some(g => !sameRange(g, rule.range)) ? scoped(shared, ranges) : shared;
    return ranges.map(range => piece(withBandOrigin, range, newId()));
  });
  // The pasted rules take priority over pre-existing rules.
  if (!added.length && left.length === saved.length && left.every((rule, i) => rule === saved[i])) return saved;
  return [...added, ...left];
}
