import { isVolatile } from './formula/evaluator.js';

/** OOXML CT_CalcPr defaults; iteration is opt-in, never inferred from a cycle. */
export function normalizeIteration(value) {
  if (!value || ![true, 1, '1', 'true'].includes(value.iterate)) return null;
  const number = v => typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
  const count = number(value.iterateCount), delta = number(value.iterateDelta);
  return {
    iterate: true,
    // The documented calculation limit is 32,767 iterations.
    // https://support.microsoft.com/en-us/excel/excel-specifications-and-limits
    iterateCount: Number.isInteger(count) && count > 0 && count <= 32767 ? count : 100,
    iterateDelta: Number.isFinite(delta) && delta >= 0 ? delta : .001,
  };
}

const equal = (a, b, delta) => typeof a === 'number' && typeof b === 'number'
  ? a === b || Math.abs(a - b) < delta
  : a === b || (a?.error != null && a.error === b?.error);

/**
 * Iteration notes each range a formula reads as a whole, as `reader` reads it, instead of each of its cells: a
 * running total down twenty thousand rows reads two hundred million cells but only twenty thousand ranges, and
 * its ranges can then be shared between the formulas as they are when nothing iterates.
 */
export function noteRangeRead(state, sheetId, key, ref, reader) {
  let range = state.ranges.get(key);
  if (!range) state.ranges.set(key, range = { sheetId, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2, readers: new Set() });
  if (!range.readers.has(reader)) { range.readers.add(reader); state.edges++; }
}

/** The cells `members` and everything reading them, directly or through a range, settle on. */
function dependentsOf(state, members) {
  const keys = new Set(members);
  const queue = [...members];
  // A range whose readers are in already need not be looked at again.
  let ranges = [...state.ranges.values()];
  while (queue.length) {
    const key = queue.pop();
    for (const dependent of state.dependents.get(key) || []) if (!keys.has(dependent)) { keys.add(dependent); queue.push(dependent); }
    if (!ranges.length) continue;
    const bar = key.indexOf('|'), comma = key.indexOf(',', bar);
    const sheetId = key.slice(0, bar), r = Number(key.slice(bar + 1, comma)), c = Number(key.slice(comma + 1));
    let kept = 0;
    for (const range of ranges) {
      if (range.sheetId === sheetId && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) {
        for (const reader of range.readers) if (!keys.has(reader)) { keys.add(reader); queue.push(reader); }
      } else ranges[kept++] = range;
    }
    ranges.length = kept;
  }
  return keys;
}

function volatileFormula(wb, cell) {
  try { return isVolatile(wb._cellAst(cell)); } catch (e) { if (e instanceof RangeError) return false; throw e; }
}

/** A name defined as =RAND() or =TODAY() makes every formula using it volatile, though none of them names the function. */
function volatileName(wb) {
  return wb.names.some(n => !wb.parseNamedRef(n.ref) && isVolatile(wb._astOrNull(n.ref)));
}

/**
 * Circular references are discovered first, then iterated sheet by sheet.
 * Read order in the grid must not choose the initial guesses or iteration order.
 * https://learn.microsoft.com/en-us/office/vba/excel/concepts/excel-performance/excel-tips-for-optimizing-performance-obstructions
 * Cached results are starting guesses, not substitutes for recalculation.
 */
export function calculateIteratively(wb) {
  const entries = [];
  for (const sheet of wb.sheets) {
    const cells = [];
    for (const [address, cell] of sheet.cells) if (cell.f != null) {
      const [r, c] = address.split(',').map(Number);
      cells.push({ sheet, r, c, cell, key: `${sheet.id}|${address}` });
    }
    cells.sort((a, b) => a.r - b.r || a.c - b.c);
    for (const cell of cells) entries.push(cell);
  }
  // dependents: cell → the formulas that read it on its own; ranges: each range read → its bounds and readers.
  // edges counts both, so that the cells a pass must invalidate are worked out again only when they grew.
  const state = { members: new Set(), dependents: new Map(), ranges: new Map(), edges: 0, discovery: true, entries: new Map(entries.map(e => [e.key, e])) };
  wb._iteration = state;
  const clearRanges = () => {
    wb._rangeCache.clear();
    wb._rangeRuns.clear();
    wb._rangeCacheCells = 0;
  };
  try {
    wb._cache.clear();
    clearRanges();
    wb._spills.clear();
    for (const e of entries) wb._compute(e.sheet, e.r, e.c);
    if (!state.members.size) return;
    state.discovery = false;
    const seed = e => e.cell.v ?? 0;
    for (const key of state.members) wb._cache.set(key, seed(state.entries.get(key)));
    // Ordinary formulas independent of a cycle keep their discovery result. A volatile formula is worked out again on
    // every pass, with whatever reads it; the rest of the book is not, where one TODAY() anywhere used to recalculate
    // every formula of it on every pass. A volatile name, which any formula may use unseen, and dynamic spills, whose
    // state every pass clears, still require a workbook-wide pass.
    const volatileCells = entries.filter(e => volatileFormula(wb, e.cell)).map(e => e.key);
    const all = volatileName(wb) || [...wb._spills.values()].some(s => s.anchors.size);
    let known = null, knownEdges = -1, knownMembers = -1;
    const affected = () => {
      if (all) return new Set(entries.map(e => e.key));
      if (known && knownEdges === state.edges && knownMembers === state.members.size) return known;
      knownEdges = state.edges;
      knownMembers = state.members.size;
      return (known = dependentsOf(state, [...state.members, ...volatileCells]));
    };
    for (let pass = 0; pass < wb.iteration.iterateCount; pass++) {
      const previous = new Map([...state.members].map(key => [key, wb._cache.get(key)]));
      // Dependents must see this pass's circular results, including range and
      // spill caches. Ordinary books never enter this calculation path.
      const dirty = affected();
      for (const key of dirty) if (!state.members.has(key)) wb._cache.delete(key);
      clearRanges();
      wb._spills.clear();
      for (const e of entries) if (state.members.has(e.key)) {
        state.current = e.key;
        state.prior = wb._cache.get(e.key) ?? seed(e);
        wb._cache.delete(e.key);
        clearRanges();
        wb._compute(e.sheet, e.r, e.c);
        state.current = null;
      }
      // A dependent may have been visited while a later circular cell still
      // held its previous value. Publish dependents only after the whole pass.
      for (const key of affected()) if (!state.members.has(key)) wb._cache.delete(key);
      clearRanges();
      for (const e of entries) wb._compute(e.sheet, e.r, e.c);
      let settled = previous.size === state.members.size;
      for (const key of state.members) if (!equal(previous.get(key), wb._cache.get(key), wb.iteration.iterateDelta)) settled = false;
      if (settled) break;
    }
  } finally {
    // A currently acyclic IF may read itself after an input change. Preserve
    // its last result too, so a latch starts with that result, not an old file
    // cache. Formula caches travel through drafts, edits and rich clipboard.
    for (const e of entries) if (wb._cache.has(e.key)) e.cell.v = wb._cache.get(e.key);
    wb._iteration = null;
    wb._iterationReady = true;
    wb._announceGrown();
  }
}
