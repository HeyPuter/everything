// Resolves library definitions placed on a sheet or board into world-space
// geometry. Renderers, hit testing, connectivity, design rule checks and the
// exporters all read placed geometry through these functions so they agree.

import { makeTransform, apply, applyAngle, norm360 } from '../core/geom.js';
import { flipLayer, copperLayers } from './layers.js';

/** Transform for a schematic part: mirror, rotate (quarter turns), translate. */
export const partTransform = (part) => makeTransform(part.x, part.y, part.rot || 0, !!part.mirror);

/** Transform for a board component. Bottom-side parts are mirrored. */
export const compTransform = (comp) => makeTransform(comp.x, comp.y, comp.rot || 0, comp.side === 'bottom');

/**
 * Transforms a graphic primitive. Returns a new primitive in world space.
 * mapLayer adjusts the layer (used to flip footprint layers to the bottom).
 */
export function transformGraphic(g, t, mapLayer = (l) => l) {
  const layer = g.layer !== undefined ? mapLayer(g.layer) : undefined;
  switch (g.t) {
    case 'line': {
      const [x1, y1] = apply(t, g.x1, g.y1), [x2, y2] = apply(t, g.x2, g.y2);
      return { ...g, x1, y1, x2, y2, layer };
    }
    case 'polyline': case 'poly': {
      const pts = new Array(g.pts.length);
      for (let i = 0; i < g.pts.length; i += 2) {
        const [x, y] = apply(t, g.pts[i], g.pts[i + 1]);
        pts[i] = x; pts[i + 1] = y;
      }
      return { ...g, pts, layer };
    }
    case 'rect': {
      // Rectangles stay axis aligned under quarter turns; otherwise become polygons.
      const c = [[g.x1, g.y1], [g.x2, g.y1], [g.x2, g.y2], [g.x1, g.y2]].map(([x, y]) => apply(t, x, y));
      if (t.rot % 90 === 0) {
        const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
        return { ...g, x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys), layer };
      }
      return { t: 'poly', pts: c.flat(), w: g.w, fill: g.fill, layer };
    }
    case 'circle': {
      const [cx, cy] = apply(t, g.cx, g.cy);
      return { ...g, cx, cy, layer };
    }
    case 'arc': {
      const [cx, cy] = apply(t, g.cx, g.cy);
      // Mirroring reverses the sweep direction; keep sweep positive (CCW).
      let a0 = applyAngle(t, g.a0);
      if (t.mirror) a0 = norm360(a0 - g.sweep);
      return { ...g, cx, cy, a0, layer };
    }
    case 'text': {
      const [x, y] = apply(t, g.x, g.y);
      return { ...g, x, y, rot: norm360((g.rot || 0) + t.rot), mirror: t.mirror ? !g.mirror : !!g.mirror, layer };
    }
    default:
      return { ...g, layer };
  }
}

/**
 * Places a symbol. Returns world-space pins (with the end point, the body
 * end and the direction pointing into the body) and graphics.
 */
export function placeSymbol(def, part) {
  const t = partTransform(part);
  const sym = def?.symbol || { pins: [], graphics: [] };
  const pins = sym.pins.map((p) => {
    const [x, y] = apply(t, p.x, p.y);
    const rot = applyAngle(t, p.rot);
    const r = rot * Math.PI / 180;
    const bx = Math.round(x + Math.cos(r) * p.length), by = Math.round(y + Math.sin(r) * p.length);
    return { ...p, x: Math.round(x), y: Math.round(y), bx, by, rot };
  });
  const graphics = sym.graphics.map((g) => transformGraphic(g, t));
  return { t, pins, graphics };
}

/** Copper and mask layers a pad occupies on a board with copperCount layers. */
export function padLayers(side, copperCount = 2) {
  if (side === 'thru') return { copper: copperLayers(copperCount), mask: ['topSolder', 'bottomSolder'], paste: [] };
  if (side === 'bottom') return { copper: ['bottom'], mask: ['bottomSolder'], paste: ['bottomPaste'] };
  return { copper: ['top'], mask: ['topSolder'], paste: ['topPaste'] };
}

/**
 * Places a footprint on the board. Pads come back in world space with their
 * net (from comp.padNets), copper layers, and an absolute rotation.
 */
export function placeFootprint(def, comp, copperCount = 2) {
  const fp = def?.footprint;
  if (!fp) return { t: compTransform(comp), pads: [], graphics: [], courtyard: null, body: null };
  const t = compTransform(comp);
  const bottom = comp.side === 'bottom';
  const mapLayer = bottom ? flipLayer : (l) => l;
  const pads = fp.pads.map((p, index) => {
    const [x, y] = apply(t, p.x, p.y);
    const side = p.side === 'thru' ? 'thru' : bottom ? (p.side === 'top' ? 'bottom' : 'top') : p.side;
    const prot = p.rot || 0;
    const rot = norm360((bottom ? -prot : prot) + (comp.rot || 0));
    return {
      ...p, index, x: Math.round(x), y: Math.round(y), rot, side,
      net: comp.padNets?.[p.num] || '',
      layers: padLayers(side, copperCount),
      compId: comp.id,
    };
  });
  const graphics = (fp.graphics || []).map((g) => {
    const out = transformGraphic(g, t, mapLayer);
    // Mirrored text turns the other way, like pads: rotate(c) * mirror * rotate(g)
    // is rotate(c - g) * mirror.
    if (bottom && g.t === 'text') out.rot = norm360((comp.rot || 0) - (g.rot || 0));
    return out;
  });
  let courtyard = null;
  if (fp.courtyard) {
    const c = fp.courtyard;
    courtyard = [[c.x1, c.y1], [c.x2, c.y1], [c.x2, c.y2], [c.x1, c.y2]].flatMap(([x, y]) => apply(t, x, y));
  }
  return { t, pads, graphics, courtyard, body: fp.body || null };
}

/**
 * Text anchor for a part field. Fields are stored relative to the part origin
 * in sheet orientation so they never render upside down.
 */
export function fieldPosition(part, name, def) {
  const f = part.fields?.[name];
  // A stored position keeps the alignment it was stored with: the default
  // left/bottom unless the field records its own (see fieldAlign).
  if (f) return { x: part.x + f.dx, y: part.y + f.dy, hidden: !!f.hidden, align: f.align };
  const sym = def?.symbol;
  const local = name === 'designator' ? sym?.designatorPos : sym?.valuePos;
  if (!local) return { x: part.x, y: part.y, hidden: false };
  const t = makeTransform(0, 0, part.rot || 0, !!part.mirror);
  // Rotate the default anchor with the part but keep it near the body.
  const [dx, dy] = apply(t, local.x, local.y);
  return { x: part.x + Math.round(dx), y: part.y + Math.round(dy), hidden: false, align: fieldAlign(part, dx) };
}

/**
 * Alignment of a default-placed field. Code that turns a default field into
 * a stored one must store this alignment with it (field.align) so the text
 * does not move. Field text stays horizontal and reads from its anchor up
 * and to the right, which suits a symbol's own orientation. Turned a quarter turn, an anchor on
 * the left would run the text back across the body, so the text ends there;
 * turned a half turn, the anchor is below the body, so the text hangs from
 * it. Otherwise the default left/bottom alignment (undefined) applies.
 */
function fieldAlign(part, dx) {
  const r = norm360(part.rot || 0);
  if ((r === 90 || r === 270) && dx < 0) return { h: 'right', v: 'bottom' };
  if (r === 180) return { h: 'left', v: 'top' };
  return undefined;
}

/** Maps a symbol pin number to the footprint pad number. */
export const padForPin = (def, pinNum) => def?.pinMap?.[pinNum] ?? pinNum;
