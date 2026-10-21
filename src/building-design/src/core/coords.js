/**
 * Project coordinates. The project base point is the project's own origin
 * for reporting (spot coordinates and elevations); the survey point ties
 * the model to site coordinates: northing, easting and elevation at a known
 * point, with true north from the project's north angle.
 *
 *   basePoint { role: 'project' | 'survey', at, elevation, n?, e? }
 */
import { add, sub, rotate, arcPoints } from './geom.js';
import { W, INK, BG } from './plan.js';

export function basePoint(doc, role = 'project') {
  return doc.all('basePoint').find((p) => p.role === role) || null;
}

/**
 * The two points every project has (fixed ids, so copies of a shared
 * project agree on them). Used when a project is opened.
 */
export function defaultBasePoints(doc) {
  const legacy = doc.get('project') || {};
  return [
    { id: 'base-point', kind: 'basePoint', role: 'project', at: legacy.basePoint || [0, 0], elevation: +legacy.baseElevation || 0 },
    { id: 'survey-point', kind: 'basePoint', role: 'survey', at: [0, 0], elevation: 0, n: 0, e: 0 },
  ];
}

/** Unit vectors of true north and true east in model coordinates. */
export function trueAxes(doc) {
  const a = ((+doc.get('project')?.trueNorth || 0) * Math.PI) / 180;
  const north = rotate([0, 1], a);
  return { north, east: [north[1], -north[0]] };
}

/**
 * Coordinates of a model point: { n, e } from the survey point (site
 * coordinates) or from the project base point (model axes).
 */
export function coordinatesAt(doc, p, origin = 'survey') {
  if (origin === 'survey') {
    const s = basePoint(doc, 'survey');
    if (s) {
      const { north, east } = trueAxes(doc);
      const d = sub(p, s.at);
      return { n: (+s.n || 0) + d[0] * north[0] + d[1] * north[1], e: (+s.e || 0) + d[0] * east[0] + d[1] * east[1] };
    }
  }
  const b = basePoint(doc, 'project');
  const at = b?.at || doc.get('project')?.basePoint || [0, 0];
  return { n: p[1] - at[1], e: p[0] - at[0] };
}

/**
 * Reported elevation of a model height. The project base point's elevation
 * is the model height that reads zero; the survey point's is the site
 * elevation of model height zero.
 */
export function elevationFrom(doc, z, origin = 'project') {
  const pt = basePoint(doc, origin === 'survey' ? 'survey' : 'project');
  if (!pt) return z - (+doc.get('project')?.baseElevation || 0);
  return origin === 'survey' ? z + (+pt.elevation || 0) : z - (+pt.elevation || 0);
}

/** Plan symbols: a circle with a cross for the project base point, a triangle for the survey point. */
export function planBasePoint(pc, el, b) {
  if (!pc.view.showBasePoints) return;
  const s = 4 * pc.scale;
  const c = el.at;
  if (el.role === 'survey') {
    const tri = [0, 1, 2].map((i) => add(c, rotate([0, s * 1.15], (i * 2 * Math.PI) / 3)));
    b.fill(tri, [], BG);
    b.poly(tri, true, W.light, 0, [40, 120, 200, 255]);
    b.line(add(c, [-s * 0.5, 0]), add(c, [s * 0.5, 0]), W.thin, 0, [40, 120, 200, 255]);
    b.line(add(c, [0, -s * 0.5]), add(c, [0, s * 0.5]), W.thin, 0, [40, 120, 200, 255]);
  } else {
    const ring = arcPoints(c, s, 0, Math.PI * 2, Math.PI / 24).slice(0, -1);
    b.fill(ring, [], BG);
    b.poly(ring, true, W.light, 0, [200, 80, 40, 255]);
    b.line(add(c, [-s, 0]), add(c, [s, 0]), W.thin, 0, [200, 80, 40, 255]);
    b.line(add(c, [0, -s]), add(c, [0, s]), W.thin, 0, [200, 80, 40, 255]);
  }
  b.text(add(c, [s * 1.4, -s * 1.2]), el.role === 'survey' ? 'Survey Point' : 'Project Base Point', { size: 2 * pc.scale, align: 'left', color: INK(160) });
  b.pick(arcPoints(c, s * 1.2, 0, Math.PI * 2, Math.PI / 8));
}
