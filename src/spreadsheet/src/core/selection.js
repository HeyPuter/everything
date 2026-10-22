/**
 * Selection state and keyboard navigation, kept free of the DOM so the
 * rules (where Tab goes, how Shift extends, what Ctrl+Arrow jumps to) can
 * be tested on their own.
 *
 * sel = { active: {r,c}, anchor: {r,c}, focus: {r,c}, range?, scope? }
 * Header selections retain their whole-line scope independently of the current
 * grid dimensions; a finite range reaching the same edge is still finite.
 * The selected range is anchor..focus; `active` is the cell that edits and
 * that the name box shows. A plain click puts all three on one cell. When
 * that box cuts through merged cells the grid stores the box grown to
 * cover them as `range`, while anchor and focus keep the cells the user
 * meant, so the next Shift+Arrow or Shift+click extends from those.
 */

import { normalizeRange } from './cell.js';

export function single(r, c) {
  const p = { r, c };
  return { active: { ...p }, anchor: { ...p }, focus: { ...p } };
}

export function fromRange(range, active) {
  const n = normalizeRange(range);
  const a = active || { r: n.r1, c: n.c1 };
  return { active: { ...a }, anchor: { r: n.r1, c: n.c1 }, focus: { r: n.r2, c: n.c2 }, ...(range.scope ? { scope: range.scope } : {}) };
}

export function selRange(sel, withScope = false) {
  const range = normalizeRange(sel.range || { r1: sel.anchor.r, c1: sel.anchor.c, r2: sel.focus.r, c2: sel.focus.c });
  return withScope && sel.scope ? { ...range, scope: sel.scope } : range;
}

export function isSingle(sel) {
  return sel.anchor.r === sel.focus.r && sel.anchor.c === sel.focus.c;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Move the active cell by (dr, dc), collapsing the range. */
export function move(sel, dr, dc, bounds) {
  const r = clamp(sel.active.r + dr, 0, bounds.rows - 1);
  const c = clamp(sel.active.c + dc, 0, bounds.cols - 1);
  return single(r, c);
}

/** Shift+Arrow: grow or shrink the range from the anchor. */
export function extend(sel, dr, dc, bounds) {
  const focus = {
    r: clamp(sel.focus.r + dr, 0, bounds.rows - 1),
    c: clamp(sel.focus.c + dc, 0, bounds.cols - 1),
  };
  return extendedScope(sel, { active: { ...sel.active }, anchor: { ...sel.anchor }, focus });
}

/** Extend to a clicked cell (Shift+click, drag). */
export function extendTo(sel, r, c) {
  return extendedScope(sel, { active: { ...sel.active }, anchor: { ...sel.anchor }, focus: { r, c } });
}

// Extending along selected columns/rows retains the full other axis. A
// gesture that shortens that axis instead becomes a finite cell selection.
function extendedScope(previous, next) {
  const before = selRange(previous), after = selRange(next);
  const columns = ['columns', 'sheet'].includes(previous.scope) && before.r1 === after.r1 && before.r2 === after.r2;
  const rows = ['rows', 'sheet'].includes(previous.scope) && before.c1 === after.c1 && before.c2 === after.c2;
  if (columns || rows) next.scope = columns && rows ? 'sheet' : columns ? 'columns' : 'rows';
  return next;
}

/**
 * Ctrl+Arrow: jump to the edge of the current block of data, like every
 * spreadsheet does. From a filled cell, run to the last filled cell before
 * a gap; from an empty one, to the next filled cell (or the sheet edge).
 */
export function jump(sel, dr, dc, bounds, hasValue, isVisible = () => true, nextFilled = null, pastHidden = null) {
  let { r, c } = sel.active;
  const maxR = bounds.rows - 1;
  const maxC = bounds.cols - 1;
  const inside = (rr, cc) => rr >= 0 && rr <= maxR && cc >= 0 && cc <= maxC;
  // How far to step from a hidden line along the way, and back from one: past its whole run when `pastHidden`
  // (given) knows it, since rows hidden to the sheet's end are a million of them; one line otherwise.
  const over = (rr, cc, back) => (pastHidden ? Math.max(1, pastHidden(rr, cc, back ? -dr : dr, back ? -dc : dc)) : 1);
  const step = (rr, cc) => {
    rr += dr;
    cc += dc;
    while (inside(rr, cc) && !isVisible(rr, cc)) { const k = over(rr, cc, false); rr += k * dr; cc += k * dc; }
    return { r: rr, c: cc };
  };

  let next = step(r, c);
  if (!inside(next.r, next.c)) return single(r, c);

  if (hasValue(r, c) && hasValue(next.r, next.c)) {
    // Inside a block: run until the cell after the next is empty.
    while (inside(next.r, next.c) && hasValue(next.r, next.c)) {
      ({ r, c } = next);
      next = step(r, c);
    }
    return single(r, c);
  }
  // Empty (or at the block's edge): skip empties to the next filled cell. A sheet is a million rows
  // deep, so after a few steps `nextFilled` (when given) leaps over the empty stretch: it names the next
  // cell along the way that may hold something, or null when nothing lies ahead.
  let steps = 0;
  while (inside(next.r, next.c) && !hasValue(next.r, next.c)) {
    ({ r, c } = next);
    if (nextFilled && ++steps > 32) {
      steps = 0;
      const ahead = nextFilled(r, c, dr, dc);
      if (!ahead) {
        // Nothing beyond: the sheet's last shown line.
        let er = dr > 0 ? maxR : dr < 0 ? 0 : r, ec = dc > 0 ? maxC : dc < 0 ? 0 : c;
        while ((er !== r || ec !== c) && !isVisible(er, ec)) { const k = Math.min(over(er, ec, true), Math.abs(er - r) + Math.abs(ec - c)); er -= k * dr; ec -= k * dc; }
        return single(er, ec);
      }
      // Stand just before it; the step lands on it, or past it over hidden lines.
      if (ahead.r - dr !== r || ahead.c - dc !== c) { r = ahead.r - dr; c = ahead.c - dc; }
    }
    next = step(r, c);
  }
  if (!inside(next.r, next.c)) {
    while (!isVisible(r, c) && (r !== sel.active.r || c !== sel.active.c)) { r -= dr; c -= dc; }
    return single(r, c);
  }
  return single(next.r, next.c);
}

/**
 * Enter and Tab inside a multi-cell selection walk the range instead of
 * leaving it; on a single cell they behave like plain arrows.
 */
export function advance(sel, dir, bounds) {
  if (isSingle(sel)) return move(sel, dir === 'down' ? 1 : 0, dir === 'right' ? 1 : 0, bounds);
  const range = selRange(sel);
  let { r, c } = sel.active;
  if (dir === 'down') {
    r++;
    if (r > range.r2) { r = range.r1; c = c + 1 > range.c2 ? range.c1 : c + 1; }
  } else {
    c++;
    if (c > range.c2) { c = range.c1; r = r + 1 > range.r2 ? range.r1 : r + 1; }
  }
  return walked(sel, r, c);
}

/** The same selection with its active cell moved: the range walked stays as it was. */
function walked(sel, r, c) {
  const out = { active: { r, c }, anchor: { ...sel.anchor }, focus: { ...sel.focus } };
  if (sel.range) out.range = { ...sel.range };
  if (sel.scope) out.scope = sel.scope;
  return out;
}

export function retreat(sel, dir, bounds) {
  if (isSingle(sel)) return move(sel, dir === 'down' ? -1 : 0, dir === 'right' ? -1 : 0, bounds);
  const range = selRange(sel);
  let { r, c } = sel.active;
  if (dir === 'down') {
    r--;
    if (r < range.r1) { r = range.r2; c = c - 1 < range.c1 ? range.c2 : c - 1; }
  } else {
    c--;
    if (c < range.c1) { c = range.c2; r = r - 1 < range.r1 ? range.r2 : r - 1; }
  }
  return walked(sel, r, c);
}

export function selectAll(bounds) {
  return fromRange({ r1: 0, c1: 0, r2: bounds.rows - 1, c2: bounds.cols - 1, scope: 'sheet' }, { r: 0, c: 0 });
}

export function selectRows(r1, r2, bounds) {
  return fromRange({ r1, c1: 0, r2, c2: bounds.cols - 1, scope: 'rows' }, { r: Math.min(r1, r2), c: 0 });
}

export function selectCols(c1, c2, bounds) {
  return fromRange({ r1: 0, c1, r2: bounds.rows - 1, c2, scope: 'columns' }, { r: 0, c: Math.min(c1, c2) });
}
