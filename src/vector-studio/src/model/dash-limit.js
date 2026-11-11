/**
 * Limits on dash patterns. Outlining a dashed stroke (Outline Stroke, its
 * effect, Flatten Transparency, Interlace) and drawing one on the canvas
 * both slow down without bound as dashes get shorter: a pattern too dense
 * to make out is replaced by one that looks the same.
 */

/**
 * Most work the engine is asked to do for one dashed stroke, in dashes
 * weighted by how many neighbours each overlaps (round and square caps
 * reach w/2 past each end, and the stroker unites the overlaps). Its cost
 * is about 3 us per unit once compiled and can be 20 times that on the
 * first heavy run, and grows faster than linearly in the dash count, so
 * 0.0001 pt dashes on a 100 pt line (500,000 dashes) froze the tab.
 */
export const MAX_DASH_WORK = 100000;
/** Work above which a stroke job is too slow for the main thread (about 15 ms once compiled). */
export const HEAVY_STROKE_WORK = 5000;
/** Most dashes outlined on one stroke (the engine's cost grows faster than linearly beyond). */
export const MAX_DASHES = 10000;

/** Lengths of anchor lists (control polygons), cached: drawing asks for them on every frame. */
const lengths = new WeakMap();

function polygonLength(a, closed) {
  const key = closed ? 'c' : 'o';
  let hit = lengths.get(a);
  if (hit?.[key] !== undefined) return hit[key];
  let len = 0;
  const n = a.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = a[i];
    const q = a[(i + 1) % n];
    len += Math.hypot(p.ox - p.x, p.oy - p.y) + Math.hypot(q.ix - p.ox, q.iy - p.oy) + Math.hypot(q.x - q.ix, q.y - q.iy);
  }
  if (!hit) lengths.set(a, (hit = {}));
  hit[key] = len;
  return len;
}

/** Upper bound of the length of subpaths (their control polygons). */
function lengthBound(subpaths) {
  let len = 0;
  for (const sp of subpaths) len += polygonLength(sp.anchors, sp.closed);
  return len;
}

/** Estimated dashes and engine work (dashes x overlap) for a dash pattern on subpaths. */
function dashLoad(dash, width, cap, subpaths) {
  const period = dash.reduce((s, d) => s + d, 0);
  if (!(period > 0) || !subpaths) return { count: 0, work: 0 };
  const count = (lengthBound(subpaths) * dash.length) / 2 / period;
  // Dashes start every 2 * period / dash.length on average; caps add w to each.
  const overlap = cap ? 1 + (width * dash.length) / (2 * period) : 1;
  return { count, work: count * overlap };
}

/** Engine work units for stroke params on subpaths (to send heavy jobs off the main thread). */
export function strokeWork(params, subpaths) {
  return dashLoad(params.slice(6), params[0], params[2], subpaths).work;
}

/**
 * A dash pattern the engine can outline in reasonable time. Patterns
 * within the limits are kept; when the caps cover every gap (gaps under a
 * tenth of the stroke weight) a too-dense pattern draws as a solid
 * stroke and is outlined as one; otherwise it is scaled up, keeping its
 * dash-to-gap proportions (at that density the difference is far below
 * a pixel).
 */
export function feasibleDash(dash, offset, width, cap, subpaths) {
  const { count, work } = dashLoad(dash, width, cap, subpaths);
  if (work <= MAX_DASH_WORK && count <= MAX_DASHES) return { dash, offset };
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const maxGap = Math.max(...pattern.filter((_, i) => i % 2));
  if (cap && maxGap <= width / 10) return { dash: [], offset: 0 };
  const k = Math.max(work / MAX_DASH_WORK, count / MAX_DASHES);
  return { dash: dash.map((d) => d * k), offset: offset * k };
}
