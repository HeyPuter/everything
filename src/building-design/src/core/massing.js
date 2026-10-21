/**
 * Conceptual masses: a footprint extruded to a height. Levels that cross a
 * mass give its gross floor area and the levels that model-by-face tools
 * build on.
 *
 *   mass { name, levelId, boundary, holes, baseOffset, height }
 */
import { signedArea } from './geom.js';

/** Levels whose elevation falls within a mass (bottom included, top excluded). */
export function massLevels(doc, m) {
  const base = (doc.get(m.levelId)?.elevation ?? 0) + (+m.baseOffset || 0);
  const top = base + (+m.height || 10000);
  return doc.levels().filter((l) => l.elevation >= base - 1 && l.elevation < top - 1);
}

/** Gross floor area: the footprint at each level that crosses the mass. */
export function massFloorArea(doc, m) {
  return Math.abs(signedArea(m.boundary || [])) * massLevels(doc, m).length;
}
