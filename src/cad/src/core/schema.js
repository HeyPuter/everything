/**
 * Drawing data model.
 *
 * Every entity is a plain, JSON-serializable object. Coordinates are world
 * units (doubles). Angles are radians, counter-clockwise from +X.
 *
 * Common fields on every entity:
 *   id         number   unique within its container (model space or a block)
 *   type       string   one of ENTITY_TYPES
 *   layer      string   layer name (layer "0" always exists)
 *   color      number|string
 *                       256 = ByLayer, 0 = ByBlock, 1..255 = indexed color,
 *                       '#rrggbb' = true color
 *   linetype   string   'ByLayer' | 'ByBlock' | a linetype name
 *   lineweight number   LW_BYLAYER (-1) | LW_BYBLOCK (-2) | LW_DEFAULT (-3)
 *                       | hundredths of a millimetre (0, 5, 9, 13, ... 211)
 *   ltscale    number   per-entity linetype scale (default 1)
 *   orderGroup number   set by DRAWORDER on the objects it moved together; groups
 *                       are drawn strictly in order (see drawBands in display.js)
 *
 * Type-specific fields:
 *
 *   line      x1, y1, x2, y2
 *   xline     x, y, dx, dy             infinite both ways; (dx, dy) is a unit vector
 *   ray       x, y, dx, dy             infinite from (x, y) along (dx, dy)
 *   circle    cx, cy, r
 *   arc       cx, cy, r, start, end    counter-clockwise from start to end
 *   ellipse   cx, cy, mx, my, ratio, start, end
 *                                      (mx, my) is the major-axis vector from the
 *                                      centre; ratio = minor / major (0 < ratio <= 1);
 *                                      start/end are parametric angles (0 and 2*PI
 *                                      for a full ellipse)
 *   polyline  pts: number[]            flat [x0, y0, b0, x1, y1, b1, ...], where bi is
 *                                      the bulge of the segment that starts at vertex i
 *                                      (tan(sweep / 4), positive = counter-clockwise)
 *             closed: boolean
 *             width: number            constant width, 0 = hairline
 *   spline    degree: number (usually 3)
 *             ctrl: number[]           flat [x0, y0, x1, y1, ...] control points
 *             knots: number[]          clamped knot vector, length = ctrl/2 + degree + 1
 *             fit: number[]            flat fit points the spline was built from ([] if none)
 *             closed: boolean
 *   point     x, y
 *   text      x, y, h, rot, value, style, halign, valign, widthFactor, oblique
 *             halign: 'left' | 'center' | 'right'
 *             valign: 'baseline' | 'bottom' | 'middle' | 'top'
 *   mtext     x, y, h, rot, value, style, width, attach, lineSpacing
 *             value uses '\n' for paragraph breaks; width 0 = no wrapping
 *             attach: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'
 *   dimension dimType: 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter' | 'ordinate'
 *             x1, y1, x2, y2           first and second definition points
 *                                      linear/aligned: extension line origins
 *                                      radius/diameter: centre and point on curve
 *                                      angular: see x3..y4
 *                                      ordinate: feature point and leader end
 *             x3, y3, x4, y4           angular only: vertex (x3, y3) and the two rays go
 *                                      from the vertex through (x1, y1) and (x2, y2);
 *                                      (x4, y4) is unused (0)
 *             lx, ly                   dimension line location (a point it passes through)
 *             rot                      linear only: dimension line angle (0 = horizontal)
 *             text                     override; '' = measured value, '<>' inside the
 *                                      string is replaced with the measured value
 *             style                    dimension style name
 *             ordAxis                  ordinate only: 'x' | 'y'
 *   leader    pts: number[]            flat [x0, y0, x1, y1, ...]; arrow at the first point
 *             text, h, style           annotation placed at the last point ('' = none)
 *   hatch     loops: number[][]        each loop is flat [x, y, bulge, ...], implicitly closed
 *             pattern: string          'SOLID' or a pattern name from hatch-patterns.js
 *             scale, angle             pattern scale and rotation
 *             families?                imported pattern the library lacks: its lines
 *                                      at scale 1 and angle 0 (format of patterns.js)
 *             mirror?                  true: the pattern is drawn reflected across its
 *                                      X axis, then rotated (a mirrored hatch)
 *   insert    name, x, y, sx, sy, rot  block reference
 *
 * Containers:
 *
 *   Drawing {
 *     version: 1,
 *     header: {
 *       units: 'unitless' | 'in' | 'ft' | 'mm' | 'cm' | 'm',
 *       linearFormat: 'decimal' | 'architectural' | 'engineering' | 'fractional' | 'scientific',
 *       linearPrecision: number (0..8),
 *       angularFormat: 'deg' | 'dms' | 'rad' | 'grad',
 *       angularPrecision: number,
 *       ltscale: number,
 *       clayer, ccolor, cltype, clweight,   current layer and properties for new objects
 *       textStyle, dimStyle,                current styles
 *       textHeight: number,                 default text height
 *       pdmode, pdsize,                     point display
 *       nextId: number,
 *     },
 *     layers:    Layer[]      { name, color (1..255 | '#rrggbb'), linetype, lineweight,
 *                              on, frozen, locked, plot, transparency (0..90), description }
 *     linetypes: Linetype[]   { name, description, pattern: number[] }  (see linetypes.js)
 *     textStyles: TextStyle[] { name, font: 'sans' | 'mono', height (0 = variable),
 *                              widthFactor, oblique }
 *     dimStyles: DimStyle[]   see dimstyle.js
 *     blocks:    Block[]      { name, bx, by, entities: Entity[], description }
 *     entities:  Entity[]     model space, in draw order
 *   }
 */

export const ENTITY_TYPES = [
  'line',
  'xline',
  'ray',
  'circle',
  'arc',
  'ellipse',
  'polyline',
  'spline',
  'point',
  'text',
  'mtext',
  'dimension',
  'leader',
  'hatch',
  'insert',
];

export const COLOR_BYBLOCK = 0;
export const COLOR_BYLAYER = 256;
export const LW_BYLAYER = -1;
export const LW_BYBLOCK = -2;
export const LW_DEFAULT = -3;

/** Standard lineweights in hundredths of a millimetre. */
export const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/** The lineweight used for LW_DEFAULT. */
export const DEFAULT_LINEWEIGHT = 25;

export const UNITS = ['unitless', 'in', 'ft', 'mm', 'cm', 'm'];

/** Millimetres per drawing unit, used to scale plots and imports. */
export const UNIT_MM = { unitless: 1, in: 25.4, ft: 304.8, mm: 1, cm: 10, m: 1000 };

export const TWO_PI = Math.PI * 2;

export function defaultHeader() {
  return {
    units: 'mm',
    linearFormat: 'decimal',
    linearPrecision: 4,
    angularFormat: 'deg',
    angularPrecision: 0,
    ltscale: 1,
    clayer: '0',
    ccolor: COLOR_BYLAYER,
    cltype: 'ByLayer',
    clweight: LW_BYLAYER,
    textStyle: 'Standard',
    dimStyle: 'Standard',
    textHeight: 2.5,
    pdmode: 0,
    pdsize: 0,
    nextId: 1,
  };
}

export function defaultLayer(name = '0') {
  return {
    name,
    color: 7,
    linetype: 'Continuous',
    lineweight: LW_DEFAULT,
    on: true,
    frozen: false,
    locked: false,
    plot: true,
    transparency: 0,
    description: '',
  };
}

/**
 * The key of a layer, block or style table entry named `name` in any letter
 * case, or null. Names ignore case in DWG and DXF, so 'Bolt' and 'BOLT' are
 * one name there.
 */
export function tableKey(map, name) {
  if (map.has(name)) return name;
  const k = String(name).toLowerCase();
  for (const n of map.keys()) if (n.toLowerCase() === k) return n;
  return null;
}

/** The first free name base1, base2... in a layer, block or style table, in any letter case. */
export function freeTableName(map, base) {
  let i = 1;
  while (tableKey(map, `${base}${i}`)) i++;
  return `${base}${i}`;
}

/** Fields every new entity gets unless the caller sets them. */
export function baseProps(header) {
  return {
    layer: header?.clayer ?? '0',
    color: header?.ccolor ?? COLOR_BYLAYER,
    linetype: header?.cltype ?? 'ByLayer',
    lineweight: header?.clweight ?? LW_BYLAYER,
    ltscale: 1,
  };
}

/** True when the entity has a finite extent (xlines and rays do not). */
export function isBounded(ent) {
  return ent.type !== 'xline' && ent.type !== 'ray';
}
