// Piano roll geometry: the surface layout (keyboard column, ruler, note grid,
// event lane, scrollbars), key rows, and the spoken descriptions of positions
// and lengths. Pure functions over plain numbers, shared by the renderer, the
// pointer handling and the tests.

import { ticksPerBar, ticksPerBeat, STEP } from '../model/time.js';
import { keyName } from '../lib/util.js';

export const NUM_KEYS = 128;
export const MIN_KEY_H = 5;
export const MAX_KEY_H = 40;

/**
 * Regions of the surface in CSS px.
 *   [ corner | ruler      | . ]
 *   [ keys   | grid       | v ]   v = vertical scrollbar
 *   [ .      | h scroll   | . ]
 *   [ split  (lane resize)    ]
 *   [ label  | event lane | . ]
 */
export function computeLayout({ w, h, phone = false, coarse = false, lane = true, laneH = 72 }) {
  const keysW = phone ? 46 : 60;
  const rulerH = coarse ? 28 : 24;
  const sb = coarse ? 12 : 10;
  const split = lane ? 5 : 0;
  const lh = lane ? Math.max(32, Math.min(laneH, Math.floor(h * 0.3))) : 0;
  const gridX = keysW;
  const gridY = rulerH;
  const gridW = Math.max(1, w - keysW - sb);
  const gridH = Math.max(1, h - rulerH - sb - split - lh);
  return {
    w,
    h,
    keysW,
    rulerH,
    sb,
    gridX,
    gridY,
    gridW,
    gridH,
    hsbY: gridY + gridH,
    vsbX: gridX + gridW,
    splitY: gridY + gridH + sb,
    split,
    laneY: gridY + gridH + sb + split,
    laneH: lh,
    lane,
  };
}

/** Which region a point is in. */
export function regionAt(L, x, y) {
  if (y < L.rulerH) return x < L.keysW ? 'corner' : x < L.vsbX ? 'ruler' : 'corner';
  if (y < L.hsbY) return x < L.keysW ? 'keys' : x < L.vsbX ? 'grid' : 'vscroll';
  if (y < L.splitY) return x >= L.gridX && x < L.vsbX ? 'hscroll' : 'corner';
  if (L.lane && y < L.laneY) return 'split';
  if (L.lane) return x < L.keysW ? 'laneLabel' : x < L.vsbX ? 'lane' : 'corner';
  return 'corner';
}

/** Top y of a key row (key 127 at the top) for a key height and vertical scroll. */
export function rowY(L, key, keyH, scrollY) {
  return L.gridY + (NUM_KEYS - 1 - key) * keyH - scrollY;
}

/** The key whose row contains y (clamped to 0..127). */
export function keyAtY(L, y, keyH, scrollY) {
  const k = NUM_KEYS - 1 - Math.floor((y - L.gridY + scrollY) / keyH);
  return k < 0 ? 0 : k > 127 ? 127 : k;
}

export function maxScrollY(L, keyH) {
  return Math.max(0, NUM_KEYS * keyH - L.gridH);
}

/** Scroll offset that centers `key` in the grid. */
export function centerScrollY(L, key, keyH) {
  const y = (NUM_KEYS - 1 - key) * keyH + keyH / 2 - L.gridH / 2;
  return Math.max(0, Math.min(maxScrollY(L, keyH), y));
}

// ------------------------------------------------------------------ descriptions

/** "bar 2 beat 3" (plus "step 2" and ticks when off the beat). Used in announcements. */
export function describePos(ticks, sig = [4, 4]) {
  const t = Math.max(0, Math.round(ticks));
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  const b = Math.floor(t / bar);
  const inBar = t - b * bar;
  const bt = Math.floor(inBar / beat);
  const inBeat = inBar - bt * beat;
  let s = `bar ${b + 1} beat ${bt + 1}`;
  if (inBeat) {
    const st = Math.floor(inBeat / STEP);
    const tk = inBeat - st * STEP;
    s += ` step ${st + 1}`;
    if (tk) s += ` tick ${tk}`;
  }
  return s;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "1 step long", "2 beats long", "1 bar long", "half a step long", "10 ticks long". */
export function describeLen(ticks, sig = [4, 4]) {
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  if (ticks >= bar && ticks % bar === 0) return `${plural(ticks / bar, 'bar')} long`;
  if (ticks >= beat && ticks % beat === 0) return `${plural(ticks / beat, 'beat')} long`;
  if (ticks % STEP === 0) return `${plural(ticks / STEP, 'step')} long`;
  if (ticks === STEP / 2) return 'half a step long';
  return `${plural(ticks, 'tick')} long`;
}

/** "C5 added at bar 2 beat 3, 1 step long" style description of a note. */
export function describeNote(n, sig) {
  return `${keyName(n.key)} at ${describePos(n.pos, sig)}, ${describeLen(n.len, sig)}`;
}
