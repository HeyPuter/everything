/**
 * Where each row (or column) of a sheet starts, in pixels, without an entry per line.
 *
 * A sheet is the file format's full grid, 1,048,576 rows by 16,384 columns, and nearly every line has the
 * sheet's default size. Only the lines that differ — resized, hidden, filtered out — are kept,
 * sorted, as runs of neighbouring lines of one size, with the running sum of how much each run
 * changes the length before the next. A line's place is then its index times the default size plus
 * that sum, found by binary search, and the line at a place is found the same way: reading costs the
 * logarithm of the number of runs, and the rows hidden from under a list to the sheet's end, a
 * million of them, are one run.
 *
 * Two translations sit over the content positions, so the grid can keep drawing in the coordinates
 * it always used:
 * - the origin: frozen panes can begin at a saved line other than the first; that line is placed
 *   at 0 and the lines before it get negative places (they stay in the model, out of sight);
 * - the window: browsers cannot lay out or scroll an element much taller than 16 to 33 million
 *   pixels (Safari and Firefox about 17M, Chrome about 33M), and a million rows of 20px, zoomed to
 *   400%, are 84M. Past `limit` the canvas shows a window of that length, starting at `base`, after
 *   the lines kept in place at the start (a frozen band). The lines between the band and the window,
 *   and those after the window, have no length in it, as hidden lines have none; the grid moves the
 *   window along as the view nears either end of it.
 */

/** The largest canvas extent the grid lays out before it shows the sheet through a moving window. */
export const MAX_CANVAS_EXTENT = 6_000_000;

export class AxisOffsets {
  constructor() {
    this.n = 0; // number of lines
    this.d = 0; // default size of a line
    this.keys = []; // the first line of each run of lines whose size is not the default, ascending
    this.lasts = []; // the last line of each run
    this.sizes = []; // the size of each line of each run
    this.starts = new Float64Array(0); // content position of each run's first line
    this.ends = new Float64Array(0); // content position after each run's last line
    this.origin = 0; // content position placed at 0
    this.win = null; // { keep, base, size }: see the class comment (positions relative to the origin)
    this.explicit = null; // { starts, ends }: a layout given line by line (Page Layout view's pages)
  }

  /**
   * Lay out `n` lines of default size `d`, with `entries` ([index, size] pairs; an index may repeat,
   * the last size wins, and an index outside 0..n-1 is ignored) for the lines that differ, and then
   * the lines of no size: `hidden` is a list of collections of their indexes (sets of hidden rows).
   */
  build(n, d, entries = [], hidden = []) {
    this.explicit = null;
    this.n = Math.max(0, n | 0);
    this.d = Math.max(0, d);
    let count = entries.length;
    for (const lines of hidden) count += lines.size ?? lines.length;
    const keys = [];
    const lasts = [];
    const sizes = [];
    const add = (i, size) => {
      const k = keys.length - 1;
      if (k >= 0 && lasts[k] === i - 1 && sizes[k] === size) lasts[k] = i;
      else { keys.push(i); lasts.push(i); sizes.push(size); }
    };
    const valid = (i) => i >= 0 && i < this.n && Number.isInteger(i);
    if (count > 4096 && count * 16 > this.n) {
      // Many lines differ (rows hidden to the sheet's end): a size per line, read in order, costs less than sorting them.
      const size = new Float64Array(this.n).fill(this.d);
      for (const [i, s] of entries) if (valid(i)) size[i] = s;
      for (const lines of hidden) for (const i of lines) if (valid(i)) size[i] = 0;
      for (let i = 0; i < this.n; i++) if (size[i] !== this.d) add(i, size[i]);
    } else {
      const map = new Map();
      for (const [i, size] of entries) if (valid(i)) map.set(i, size);
      for (const lines of hidden) for (const i of lines) if (valid(i)) map.set(i, 0);
      for (const i of [...map.keys()].filter((i) => map.get(i) !== this.d).sort((a, b) => a - b)) add(i, map.get(i));
    }
    const k = keys.length;
    const starts = new Float64Array(k);
    const ends = new Float64Array(k);
    let delta = 0;
    for (let j = 0; j < k; j++) {
      const lines = lasts[j] - keys[j] + 1;
      starts[j] = keys[j] * this.d + delta;
      ends[j] = starts[j] + lines * sizes[j];
      delta += lines * (sizes[j] - this.d);
    }
    this.keys = keys;
    this.lasts = lasts;
    this.sizes = sizes;
    this.starts = starts;
    this.ends = ends;
    this.endPos = this.n * this.d + delta;
    this.origin = 0;
    this.win = null;
    return this;
  }

  /**
   * Lay the lines out at given places instead: `starts` (n + 1 entries, the last where the lines end) and
   * `ends` (n entries). Page Layout view does, its pages putting margins and a gap between the last line of
   * one page and the first of the next, so a line's end need not be the next one's start. It covers the
   * printed pages only, so a dense list is fine there; no origin or window applies.
   */
  setExplicit(starts, ends) {
    this.explicit = { starts, ends };
    this.n = starts.length - 1;
    this.origin = 0;
    this.win = null;
    return this;
  }

  /** The number of runs of non-default lines that begin before line i. */
  _below(i) {
    const keys = this.keys;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Content position (from line 0, before any translation) where line i starts; i is clamped to 0..n. */
  content(i) {
    if (!(i > 0)) return 0;
    if (i >= this.n) return this.endPos;
    const j = this._below(i) - 1;
    if (j < 0) return i * this.d;
    if (i <= this.lasts[j]) return this.starts[j] + (i - this.keys[j]) * this.sizes[j];
    return this.ends[j] + (i - this.lasts[j] - 1) * this.d;
  }

  /** The line holding content position p (never a line of no size); the last line from the end on. */
  contentIndexAt(p) {
    if (this.n <= 0) return 0;
    if (!(p > 0)) p = 0;
    if (p >= this.endPos) return this.n - 1;
    const ends = this.ends;
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= p) lo = mid + 1;
      else hi = mid;
    }
    if (lo < ends.length && this.starts[lo] <= p) return Math.min(this.lasts[lo], this.keys[lo] + Math.floor((p - this.starts[lo]) / this.sizes[lo]));
    const line = lo ? this.lasts[lo - 1] + 1 : 0;
    const start = lo ? ends[lo - 1] : 0;
    const limit = lo < ends.length ? this.keys[lo] - 1 : this.n - 1;
    if (!(this.d > 0)) return lo < ends.length ? this.keys[lo] : this.n - 1;
    return Math.min(limit, line + Math.floor((p - start) / this.d));
  }

  /** Place line `i` at 0: the lines before it get negative places. */
  setOrigin(i) {
    this.origin = this.content(i);
  }

  /** Show positions keep..keep+size of the canvas from `base` on (positions relative to the origin); null shows everything. */
  setWindow(win) {
    this.win = win && win.base > win.keep ? { keep: win.keep, base: win.base, size: win.size } : win ? { keep: win.keep, base: win.keep, size: win.size } : null;
  }

  /** Canvas position of a position relative to the origin. */
  toCanvas(p) {
    const w = this.win;
    if (!w || p <= w.keep) return p;
    if (p <= w.base) return w.keep;
    return Math.min(p - w.base, w.size) + w.keep;
  }

  /** Position relative to the origin of a canvas position (the window's last pixel for one past it). */
  fromCanvas(x) {
    const w = this.win;
    if (!w || x < w.keep) return x;
    return w.base + Math.min(x - w.keep, w.size - 1);
  }

  /** Where line i starts on the canvas (i is clamped to 0..n). */
  at(i) {
    if (this.explicit) return this.explicit.starts[Math.max(0, Math.min(this.n, i | 0))];
    return this.toCanvas(this.content(i) - this.origin);
  }

  /** Where line i ends on the canvas: the next line's start, except in an explicit layout. */
  end(i) {
    if (this.explicit) { const k = Math.max(0, Math.min(this.n - 1, i | 0)); return this.n ? this.explicit.ends[k] : 0; }
    return this.at(i + 1);
  }

  /** The length line i takes on the canvas. */
  size(i) {
    return this.end(i) - this.at(i);
  }

  /** The line at canvas position x: never a line of no size, the last line from the end on, and the origin's line for x < 0. */
  indexAt(x) {
    if (!(x > 0)) x = 0;
    if (this.explicit) {
      // The first line whose next start passes x, as the grid's dense lookup always did.
      const starts = this.explicit.starts;
      let lo = 0, hi = this.n - 1;
      if (hi < 0) return 0;
      if (x >= starts[hi + 1]) return hi;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid + 1] <= x) lo = mid + 1; else hi = mid; }
      return lo;
    }
    return this.contentIndexAt(this.fromCanvas(x) + this.origin);
  }

  /** The canvas length of all the lines. */
  total() {
    return this.at(this.n);
  }

  /** The content length after the origin, as it would be laid out with no window. */
  span() {
    return this.endPos - this.origin;
  }

  /** The run of lines of no size (hidden lines) holding line i, as [first, last], or null when line i has a size. */
  blankRun(i) {
    if (this.explicit || !(i >= 0) || i >= this.n) return null;
    const j = this._below(i + 1) - 1;
    return j >= 0 && i <= this.lasts[j] && this.sizes[j] === 0 ? [this.keys[j], this.lasts[j]] : null;
  }

  /** The non-default lines in a..b, as [index, size] pairs (for callers that walk them rather than every line). */
  overridesIn(a, b) {
    const out = [];
    for (let j = Math.max(0, this._below(a) - 1); j < this.keys.length && this.keys[j] <= b; j++) {
      for (let i = Math.max(a, this.keys[j]); i <= Math.min(b, this.lasts[j]); i++) out.push([i, this.sizes[j]]);
    }
    return out;
  }
}
