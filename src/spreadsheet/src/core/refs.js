/**
 * Cell references inside formulas: parsing them out of text, writing them
 * back, and the two rewrites the app needs — shifting (copy/paste, fill)
 * and adjusting for inserted or deleted rows and columns.
 *
 * Ref shape:
 *   { sheet: string|null, sheetEnd?: string, kind: 'cell'|'range'|'cols'|'rows',
 *     r1, c1, r2, c2, absR1, absC1, absR2, absC2 }
 * sheetEnd is set for a 3D span (Sheet1:Sheet3!A1: the same cells on every
 * sheet from `sheet` to `sheetEnd` in tab order).
 * Whole-column refs (A:A) use r1 = 0, r2 = MAX_ROW; whole-row refs (1:1)
 * use c1 = 0, c2 = MAX_COL. Both are "anchored" on that axis and never
 * shift along it.
 */

import { colIndex, colName, rangeName } from './cell.js';
import { tokenize } from './formula/tokenizer.js';
import { freeNameTokens } from './formula/names.js';

export const MAX_ROW = 1048575;
export const MAX_COL = 16383;

/** Sheet names match without regard to case, and whichever way their accented letters are composed (é typed whole, or as e plus a combining mark). */
export const sheetKey = (name) => String(name ?? '').normalize('NFC').toLowerCase();

/** Whether two sheet names name the same sheet; null names nothing. Every rewrite that matches a sheet compares this way, as sheetByName finds one. */
export function sameSheetName(a, b) {
  if (a == null || b == null) return false;
  return a === b || sheetKey(a) === sheetKey(b);
}

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;
const ROW_RE = /^(\$?)(\d{1,7})$/;

function endpoint(text) {
  let m = CELL_RE.exec(text);
  if (m) {
    return { kind: 'cell', c: colIndex(m[2]), r: parseInt(m[4], 10) - 1, absC: m[1] === '$', absR: m[3] === '$' };
  }
  m = COL_RE.exec(text);
  if (m) return { kind: 'col', c: colIndex(m[2]), absC: m[1] === '$' };
  m = ROW_RE.exec(text);
  if (m) return { kind: 'row', r: parseInt(m[2], 10) - 1, absR: m[1] === '$' };
  return null;
}

/** Parse the body of a reference token ("A1", "$A$1:B2", "A:A", "2:3"). */
export function parseRefText(text, sheet = null, sheetEnd = null) {
  const ref = parseRefBody(text, sheet);
  // Every reference kind must stay inside the file-format grid, including
  // whole rows/columns and normalized ranges with a reversed endpoint.
  if (ref && (ref.r1 < 0 || ref.c1 < 0 || ref.r2 > MAX_ROW || ref.c2 > MAX_COL)) return null;
  // A 3D span (Sheet1:Sheet3!A1) carries the sheet the span ends on.
  if (ref && sheetEnd && sheet) ref.sheetEnd = sheetEnd;
  return ref;
}

const RC_AXIS = String.raw`(?:\d+|\[[+-]?\d+\])?`;
const RC_CELL = new RegExp(`^R(${RC_AXIS})C(${RC_AXIS})$`, 'i');
const RC_ROW = new RegExp(`^R(${RC_AXIS})$`, 'i');
const RC_COL = new RegExp(`^C(${RC_AXIS})$`, 'i');

/** An R1C1 text reference, with relative coordinates based on the formula cell. */
export function parseR1C1Ref(text, cell) {
  let body = text.trim(), sheet = null;
  const bang = body.lastIndexOf('!');
  if (bang >= 0) {
    // Reuse the formula tokenizer's sheet quoting and name validation.
    let tokens;
    try { tokens = tokenize(`${body.slice(0, bang + 1)}A1`); } catch { return null; }
    if (tokens.length !== 1 || tokens[0].type !== 'ref' || !tokens[0].sheet || tokens[0].sheetEnd) return null;
    sheet = tokens[0].sheet;
    body = body.slice(bang + 1);
  }
  const axis = (raw, origin, max, column = false) => {
    const relative = !raw || raw.startsWith('[');
    const n = relative ? origin + Number(raw ? raw.slice(1, -1) : 0) : Number(raw) - 1;
    if (!Number.isInteger(n) || n < 0 || n > max) return null;
    return `${relative ? '' : '$'}${column ? colName(n) : n + 1}`;
  };
  const endpoint = (part) => {
    let m = RC_CELL.exec(part);
    if (m) {
      const row = axis(m[1], cell.r, MAX_ROW), col = axis(m[2], cell.c, MAX_COL, true);
      return row === null || col === null ? null : { kind: 'cell', text: col + row };
    }
    m = RC_ROW.exec(part);
    if (m) { const row = axis(m[1], cell.r, MAX_ROW); return row === null ? null : { kind: 'row', text: row }; }
    m = RC_COL.exec(part);
    if (m) { const col = axis(m[1], cell.c, MAX_COL, true); return col === null ? null : { kind: 'col', text: col }; }
    return null;
  };
  const parts = body.split(':');
  if (parts.length > 2) return null;
  const first = endpoint(parts[0]), last = parts.length === 2 ? endpoint(parts[1]) : first;
  if (!first || !last || first.kind !== last.kind) return null;
  const refText = parts.length === 1 && first.kind === 'cell' ? first.text : `${first.text}:${last.text}`;
  return parseRefText(refText, sheet);
}

function parseRefBody(text, sheet) {
  const parts = text.split(':');
  if (parts.length > 2) return null;
  const a = endpoint(parts[0]);
  if (!a) return null;
  if (parts.length === 1) {
    if (a.kind !== 'cell' || a.r < 0 || a.c < 0) return null;
    return { sheet, kind: 'cell', r1: a.r, c1: a.c, r2: a.r, c2: a.c, absR1: a.absR, absC1: a.absC, absR2: a.absR, absC2: a.absC };
  }
  const b = endpoint(parts[1]);
  if (!b || a.kind !== b.kind) return null;
  if (a.kind === 'cell') {
    const ref = {
      sheet, kind: 'range',
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c),
      absR1: a.r <= b.r ? a.absR : b.absR, absC1: a.c <= b.c ? a.absC : b.absC,
      absR2: a.r <= b.r ? b.absR : a.absR, absC2: a.c <= b.c ? b.absC : a.absC,
    };
    if (ref.r1 < 0 || ref.c1 < 0) return null;
    return ref;
  }
  if (a.kind === 'col') {
    return {
      sheet, kind: 'cols', r1: 0, r2: MAX_ROW,
      c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c),
      absC1: a.c <= b.c ? a.absC : b.absC, absC2: a.c <= b.c ? b.absC : a.absC, absR1: true, absR2: true,
    };
  }
  return {
    sheet, kind: 'rows', c1: 0, c2: MAX_COL,
    r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r),
    absR1: a.r <= b.r ? a.absR : b.absR, absR2: a.r <= b.r ? b.absR : a.absR, absC1: true, absC2: true,
  };
}

/** A name quoted although it is made of letters and digits: it would read as a cell or R1C1 reference or a boolean. */
const readsAsOther = (name) => /^[A-Za-z]{1,3}\d{1,7}$/.test(name) || RC_CELL.test(name) || RC_ROW.test(name) || RC_COL.test(name) || /^(?:TRUE|FALSE)$/i.test(name);

export function quoteSheet(name) {
  // Letters of any script, digits, underscores and periods need no quotes: Übersicht!A1 — unless
  // the name would read as a cell or R1C1 reference or a boolean, which is quoted: 'A1'!A2, 'R1C1'!A1, 'TRUE'!A1.
  return /^[\p{L}_][\p{L}\p{M}\p{N}_.]*$/u.test(name) && !readsAsOther(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * A selected range as Excel names it to people: whole columns C:C (B:D), whole rows 3:5, any other range A1:B2.
 * The whole sheet keeps its cells, A1:XFD1048576.
 */
export function selectionName(range) {
  const cols = range.r1 === 0 && range.r2 >= MAX_ROW, rows = range.c1 === 0 && range.c2 >= MAX_COL;
  return cols === rows ? rangeName(range) : refToText({ kind: cols ? 'cols' : 'rows', ...range });
}

export function refToText(ref) {
  let prefix = '';
  // A deleted sheet is written #REF!A1, the error's own ! standing for the separator.
  if (ref.sheet === '#REF!' && !ref.sheetEnd) prefix = '#REF!';
  else if (ref.sheet) {
    const first = quoteSheet(ref.sheet), last = ref.sheetEnd ? quoteSheet(ref.sheetEnd) : null;
    const sheets = !last ? first : first === ref.sheet && last === ref.sheetEnd
      ? `${first}:${last}` : quoteSheet(`${ref.sheet}:${ref.sheetEnd}`);
    prefix = `${sheets}!`;
  }
  const $ = (b) => (b ? '$' : '');
  // A trim reference keeps its periods: A1.:B9, A1:.B9, A:.A.
  const colon = `${ref.trim & 1 ? '.' : ''}:${ref.trim & 2 ? '.' : ''}`;
  if (ref.kind === 'cols') return `${prefix}${$(ref.absC1)}${colName(ref.c1)}${colon}${$(ref.absC2)}${colName(ref.c2)}`;
  if (ref.kind === 'rows') return `${prefix}${$(ref.absR1)}${ref.r1 + 1}${colon}${$(ref.absR2)}${ref.r2 + 1}`;
  const a = `${$(ref.absC1)}${colName(ref.c1)}${$(ref.absR1)}${ref.r1 + 1}`;
  if (ref.kind === 'cell') return `${prefix}${a}${ref.spill ? '#' : ''}`;
  const b = `${$(ref.absC2)}${colName(ref.c2)}${$(ref.absR2)}${ref.r2 + 1}`;
  return `${prefix}${a}${colon}${b}`;
}

/**
 * Move relative parts of a ref by (dr, dc), as when a formula is copied to
 * another cell. Returns null when a coordinate would leave the sheet.
 */
export function shiftRef(ref, dr, dc) {
  const out = { ...ref };
  if (ref.kind !== 'cols') {
    if (!ref.absR1) out.r1 += dr;
    if (!ref.absR2) out.r2 += dr;
  }
  if (ref.kind !== 'rows') {
    if (!ref.absC1) out.c1 += dc;
    if (!ref.absC2) out.c2 += dc;
  }
  // Either end of a range may have moved (only its relative ends do): every coordinate must stay on the grid.
  if ([out.r1, out.r2].some((r) => r < 0 || r > MAX_ROW) || [out.c1, out.c2].some((c) => c < 0 || c > MAX_COL)) return null;
  return out;
}

/**
 * Rewrite a ref after `count` rows/cols were inserted before index `at`.
 * A range whose end sits at or past the insertion point grows.
 */
export function adjustRefForInsert(ref, axis, at, count) {
  const out = { ...ref };
  if (axis === 'row' && ref.kind !== 'cols') {
    if (ref.r1 >= at) out.r1 += count;
    if (ref.r2 >= at) out.r2 += count;
    // A range reaching the last row stays anchored there; a ref pushed wholly off the grid is lost.
    if (out.r1 > MAX_ROW) return null;
    if (out.r2 > MAX_ROW) out.r2 = MAX_ROW;
  } else if (axis === 'col' && ref.kind !== 'rows') {
    if (ref.c1 >= at) out.c1 += count;
    if (ref.c2 >= at) out.c2 += count;
    if (out.c1 > MAX_COL) return null;
    if (out.c2 > MAX_COL) out.c2 = MAX_COL;
  }
  return out;
}

/**
 * The renumbering that inserting lines at several places at once brings about: points = [{ at, n }], n lines
 * inserted before line `at`, every `at` in the numbering before any of them went in. `move(i)` is the new
 * index of line i: it moves down by every line inserted at or above it, as under one insertion after
 * another from the bottom up. A lookup is a binary search over the points.
 */
export function insertMap(points) {
  const sorted = points.map((p) => ({ at: p.at, n: p.n })).sort((a, b) => a.at - b.at);
  const above = []; // lines inserted at the points before each one
  let count = 0;
  for (const p of sorted) { above.push(count); count += p.n; }
  // One place (every ordinary insert) needs no search: keep its per-line lookup as cheap as a comparison.
  const one = sorted.length === 1 ? sorted[0] : null;
  return {
    points: sorted,
    count,
    // Where the lines inserted at the k-th point (in sorted order) begin.
    start: (k) => sorted[k].at + above[k],
    move: one ? (i) => (typeof i === 'number' && i >= one.at ? i + one.n : i) : (i) => {
      if (typeof i !== 'number') return i;
      let lo = 0, hi = sorted.length - 1, found = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid].at <= i) { found = mid; lo = mid + 1; } else hi = mid - 1; }
      return found < 0 ? i : i + above[found] + sorted[found].n;
    },
  };
}

/** adjustRefForInsert for the lines of an insertMap, inserted all at once. */
export function adjustRefForInsertedLines(ref, axis, lines) {
  const out = { ...ref };
  if (axis === 'row' && ref.kind !== 'cols') {
    out.r1 = lines.move(ref.r1);
    out.r2 = lines.move(ref.r2);
    if (out.r1 > MAX_ROW) return null;
    if (out.r2 > MAX_ROW) out.r2 = MAX_ROW;
  } else if (axis === 'col' && ref.kind !== 'rows') {
    out.c1 = lines.move(ref.c1);
    out.c2 = lines.move(ref.c2);
    if (out.c1 > MAX_COL) return null;
    if (out.c2 > MAX_COL) out.c2 = MAX_COL;
  }
  return out;
}

/**
 * The renumbering that deleting several stretches of lines brings about, worked
 * out once for all of them: runs = [{ from, to }] in any order, touching or
 * overlapping ones taken together. `before(i)` counts the deleted lines under
 * line i, `deleted(i)` says whether i goes, `move(i)` is its new index (null
 * when it goes) and `next(i)` the first line at or after i that stays. Deleting
 * the shown rows of a filtered list is thousands of runs, so a lookup is a
 * binary search over the runs rather than a walk along them.
 */
export function deleteMap(runs) {
  const sorted = runs.filter((r) => r.to >= r.from).map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push(r);
  }
  const under = []; // deleted lines above each run
  let count = 0;
  for (const r of merged) { under.push(count); count += r.to - r.from + 1; }
  // The last run starting at or before line i, or -1.
  const runAt = (i) => {
    let lo = 0;
    let hi = merged.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid].from <= i) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };
  const before = (i) => {
    const k = runAt(i - 1);
    return k < 0 ? 0 : under[k] + Math.min(merged[k].to, i - 1) - merged[k].from + 1;
  };
  const deleted = (i) => { const k = runAt(i); return k >= 0 && merged[k].to >= i; };
  return {
    runs: merged,
    count,
    before,
    deleted,
    move: (i) => (deleted(i) ? null : i - before(i)),
    next: (i) => { const k = runAt(i); return k >= 0 && merged[k].to >= i ? merged[k].to + 1 : i; },
  };
}

/**
 * Rewrite a ref after `count` rows/cols starting at `at` were deleted.
 * Returns null when the ref lay entirely inside the deleted band (#REF!).
 * A range overlapping the band shrinks by the overlap.
 */
export function adjustRefForDelete(ref, axis, at, count) {
  return adjustRefForDeletedLines(ref, axis, deleteMap([{ from: at, to: at + count - 1 }]));
}

/**
 * Rewrite a ref after the lines of a deleteMap were deleted: a range loses the
 * lines deleted inside it, and one deleted whole is lost (null, for #REF!).
 */
export function adjustRefForDeletedLines(ref, axis, lines) {
  const out = { ...ref };
  const lo = axis === 'row' ? 'r1' : 'c1';
  const hi = axis === 'row' ? 'r2' : 'c2';
  if ((axis === 'row' && ref.kind === 'cols') || (axis === 'col' && ref.kind === 'rows')) return out;
  // A start inside a deleted run collapses onto the line that now sits where the run began; an end
  // inside one stops at the last line kept before it.
  out[lo] = ref[lo] - lines.before(ref[lo]);
  out[hi] = ref[hi] - lines.before(ref[hi] + 1);
  if (out[hi] < out[lo]) return null;
  return out;
}

/**
 * Rewrite every reference in a formula body (text after "="). `fn` receives
 * the parsed ref and returns a replacement ref, an array of refs for a
 * union, or null to turn it into #REF!. Other tokens pass through untouched, so spacing
 * and casing elsewhere in the formula are preserved. An optional nameFn
 * rewrites sheet-qualified defined names, for sheet renaming.
 */
export function mapFormulaRefs(formula, fn, nameFn) {
  let tokens;
  try {
    tokens = tokenize(formula);
  } catch {
    return formula; // not parseable: leave the text as the user wrote it
  }
  let out = '';
  let last = 0;
  for (const t of tokens) {
    if (t.type !== 'ref') {
      if (nameFn && t.type === 'name' && t.sheet) {
        const next = nameFn(t);
        if (next != null) { out += formula.slice(last, t.start) + next; last = t.end; }
      }
      continue;
    }
    const ref = parseRefText(t.text, t.sheet, t.sheetEnd);
    if (!ref) continue;
    if (t.spill) ref.spill = true;
    if (t.trim) ref.trim = t.trim;
    const next = fn(ref, t);
    out += formula.slice(last, t.start);
    out += Array.isArray(next) ? `(${next.map(refToText).join(',')})` : next ? refToText(next) : '#REF!';
    last = t.end;
  }
  return out + formula.slice(last);
}

/** Copy/paste and fill: shift every relative reference in the formula. */
export function shiftFormula(formula, dr, dc) {
  if (!dr && !dc) return formula;
  return mapFormulaRefs(formula, (ref) => shiftRef(ref, dr, dc));
}

/** XLSX names store relative offsets from A1, wrapping negative offsets at the grid edge. */
export function resolveRelativeName(formula, r, c) {
  if (!r && !c) return formula;
  return mapFormulaRefs(formula, (ref) => {
    const out = { ...ref };
    for (const end of [1, 2]) {
      if (ref.kind !== 'cols' && !ref[`absR${end}`]) out[`r${end}`] = (ref[`r${end}`] + r) % (MAX_ROW + 1);
      if (ref.kind !== 'rows' && !ref[`absC${end}`]) out[`c${end}`] = (ref[`c${end}`] + c) % (MAX_COL + 1);
    }
    return out;
  });
}

/**
 * Structural edit on sheet `sheetName`, seen from a formula that lives on
 * `ownerSheet`. Unqualified refs point at the owner's sheet, so they only
 * change when the edited sheet is the owner. A deletion of several stretches
 * at once passes their deleteMap as `lines`, built once for every formula; an
 * insertion at several places at once passes its insertMap.
 */
export function adjustFormula(formula, { ownerSheet, sheetName, axis, at, count, remove, sheetsBetween, lines = null, relativeName = false }) {
  // Nothing in a formula on another sheet can move unless it names a sheet, and naming one needs a "!"
  // (a 3D span, Sheet1:Sheet3!A1, and a qualified name, Sheet1!Total, both have it). Skipping the
  // tokenizer for the rest is what keeps an insert on one sheet off every formula in the book.
  if (!formula.includes('!') && !sameSheetName(ownerSheet, sheetName)) return formula;
  const deleted = remove ? lines || deleteMap([{ from: at, to: at + count - 1 }]) : null;
  return mapFormulaRefs(formula, (ref) => {
    if (ref.sheet?.startsWith('[')) return ref;
    const same = (name) => sameSheetName(name, sheetName);
    if (ref.sheetEnd) {
      // A 3D span follows an edit on any sheet it covers.
      const covered = sheetsBetween?.(ref.sheet, ref.sheetEnd) || [ref.sheet, ref.sheetEnd];
      if (!covered.some(same)) return ref;
    } else if (!same(ref.sheet ?? ownerSheet)) return ref;
    const edit = (r) => (remove ? adjustRefForDeletedLines(r, axis, deleted) : lines ? adjustRefForInsertedLines(r, axis, lines) : adjustRefForInsert(r, axis, at, count));
    return relativeName ? mapRelativeNameRef(ref, axis, edit) : edit(ref);
  });
}

/** Does the ref name the same cells wherever it is used (every coordinate it has absolute)? */
export function isAbsoluteRef(ref) {
  const rows = ref.kind === 'cols' || (ref.absR1 && ref.absR2);
  const cols = ref.kind === 'rows' || (ref.absC1 && ref.absC2);
  return !!(rows && cols);
}

/**
 * A relative defined name's relative coordinates are offsets from the cell that uses it (stored, as .xlsx
 * stores them, from A1), not addresses: no structural edit moves them. `edit` rewrites the ref as an edit
 * along `axis` would, judged by its absolute coordinates alone: a relative end along the axis is stretched
 * to the sheet's edge for it and put back after. With `block`, for an edit only some cells of each line
 * feel (Insert or Delete cells, a cut), a relative coordinate on either axis leaves the ref alone, since
 * which cells it names depends on where it is used.
 */
export function mapRelativeNameRef(ref, axis, edit, block = false) {
  if (isAbsoluteRef(ref)) return edit(ref);
  if (block) return ref;
  const dimension = axis === 'row' ? 'r' : 'c', absolute = axis === 'row' ? 'absR' : 'absC';
  const relative = [1, 2].filter(end => !ref[`${absolute}${end}`]);
  if (relative.length === 2) return ref;
  const fixed = { ...ref };
  for (const end of relative) fixed[`${dimension}${end}`] = end === 1 ? 0 : axis === 'row' ? MAX_ROW : MAX_COL;
  const result = edit(fixed);
  if (result) for (const end of relative) result[`${dimension}${end}`] = ref[`${dimension}${end}`];
  return result;
}

/**
 * Excel stores a spill reference A1# as ANCHORARRAY(A1) inside .xlsx files
 * (with the _xlfn. prefix it gives newer functions); these convert both ways.
 */
export function spillRefsToFile(formula) {
  if (!formula.includes('#')) return formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  let out = '';
  let last = 0;
  for (const t of tokens) {
    if (t.type !== 'ref' || !t.spill) continue;
    // The spill ending Sheet2!B1:A1# is spelled without its sheet, which it shares with B1.
    const text = formula.slice(t.start, t.end - 1), sheet = t.sheet && !text.includes('!') ? `${quoteSheet(t.sheet)}!` : '';
    out += `${formula.slice(last, t.start)}_xlfn.ANCHORARRAY(${sheet}${text})`;
    last = t.end;
  }
  return out + formula.slice(last);
}

/** Decode native spills; definedNames contains uppercase workbook names. */
export function spillRefsFromFile(formula, definedNames) {
  if (!/ANCHORARRAY/i.test(formula)) return formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  let out = '', last = 0, freeCalls;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], ref = tokens[i + 2], close = tokens[i + 3];
    if (t.type !== 'name' || t.sheet || !['ANCHORARRAY', '_XLFN.ANCHORARRAY'].includes(t.value)
      || tokens[i + 1]?.type !== 'lparen' || ref?.type !== 'ref' || close?.type !== 'rparen') continue;
    if (t.value === 'ANCHORARRAY') {
      if (definedNames?.has(t.value)) continue;
      freeCalls ??= new Set(freeNameTokens(formula, tokens, { includeCalls: true }).map((t) => t.start));
      if (!freeCalls.has(t.start)) continue;
    }
    out += formula.slice(last, t.start) + formula.slice(ref.start, ref.end) + '#';
    last = close.end;
    i += 3;
  }
  return out + formula.slice(last);
}

/**
 * Rename sheet mentions in a formula (Sheet1!A1 → Budget!A1). `spans: false` leaves the ends of 3D spans
 * (Sheet1:Sheet3!A1) alone: a copy of a sheet takes its own references along, but a span still runs between
 * the sheets it named.
 */
export function renameSheetInFormula(formula, oldName, newName, { spans = true } = {}) {
  // Only a sheet-qualified reference or name mentions the sheet, and both spell it before a "!".
  if (!formula.includes('!')) return formula;
  // Names match as the workbook matches them: without regard to case, and whichever way their
  // accented letters are composed, so a reference that evaluates before the rename is renamed too.
  const same = (name) => sameSheetName(name, oldName);
  return mapFormulaRefs(formula, (ref) => {
    if (ref.sheet?.startsWith('[') && !oldName.startsWith('[')) return ref;
    // A name holding a colon, as a sheet from another program may until the import renames it,
    // reads as a span of two sheets ('A:B'!A2); renamed as a whole, it is one sheet again.
    if (ref.sheetEnd && same(`${ref.sheet}:${ref.sheetEnd}`)) { const { sheetEnd, ...one } = ref; return { ...one, sheet: newName }; }
    if (ref.sheetEnd && !spans) return ref;
    let out = ref;
    if (same(ref.sheet)) out = { ...out, sheet: newName };
    if (same(ref.sheetEnd)) out = { ...out, sheetEnd: newName };
    return out;
  }, (t) => same(t.sheet) ? quoteSheet(newName) + '!' + formula.slice(t.nameStart, t.end) : null);
}

/** Every reference in a formula, for highlighting while editing. */
export function extractRefs(formula) {
  const out = [];
  let tokens;
  try { tokens = tokenize(formula); } catch { return out; }
  for (const t of tokens) {
    if (t.type !== 'ref') continue;
    const ref = parseRefText(t.text, t.sheet, t.sheetEnd);
    if (ref) out.push({ ref: t.spill ? { ...ref, spill: true } : ref, start: t.start, end: t.end });
  }
  return out;
}
