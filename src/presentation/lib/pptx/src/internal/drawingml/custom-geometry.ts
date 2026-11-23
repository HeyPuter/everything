// Read-only parser + guide-formula evaluator for `<a:custGeom>`
// (ECMA-376 §20.1.9 — Custom Geometry).
//
// A custom geometry is a list of paths, each a sequence of pen commands
// (`moveTo` / `lnTo` / `arcTo` / `quadBezTo` / `cubicBezTo` / `close`)
// whose coordinates are written as either literal numbers or *guide
// references*. Guides are named values computed from formulas in
// `<a:avLst>` / `<a:gdLst>`, plus a set of implicit built-ins derived
// from the shape extents. This module evaluates those formulas so the
// returned geometry carries only fully-resolved numbers — no guide names
// survive into the output.
//
// Allowed imports: internal/xml.

import {
  NS,
  type QName,
  type XmlElement,
  getAttrValue,
  isElement,
  qname,
} from "../xml/index.ts";

/** A point in the path's own coordinate space, fully evaluated. */
export interface GeomPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * `ST_PathFillMode` (ECMA-376 §20.1.10.38). `none` means the path is
 * stroke-only; every other value fills. Lighten/darken variants modify only
 * the fill paint, independently of strokes. Default `norm`.
 */
export type PathFillMode =
  "none" | "norm" | "lighten" | "lightenLess" | "darken" | "darkenLess";

/**
 * One pen command. Discriminated on `kind` so renderers can `switch`
 * exhaustively. All coordinates / radii are in the owning path's
 * coordinate space; angles are in 60000ths of a degree (ECMA-376's unit
 * for `<a:arcTo>` `stAng` / `swAng`).
 */
export type GeomCommand =
  | { readonly kind: "moveTo"; readonly pt: GeomPoint }
  | { readonly kind: "lnTo"; readonly pt: GeomPoint }
  | {
      readonly kind: "arcTo";
      readonly wR: number;
      readonly hR: number;
      readonly stAng: number;
      readonly swAng: number;
    }
  | {
      readonly kind: "quadBezTo";
      readonly pts: readonly [GeomPoint, GeomPoint];
    }
  | {
      readonly kind: "cubicBezTo";
      readonly pts: readonly [GeomPoint, GeomPoint, GeomPoint];
    }
  | { readonly kind: "close" };

export interface GeomPath {
  /** Path coordinate-space width (`<a:path w>`), or `null` when omitted. */
  readonly w: number | null;
  /** Path coordinate-space height (`<a:path h>`), or `null` when omitted. */
  readonly h: number | null;
  readonly fill: PathFillMode;
  readonly stroke: boolean;
  readonly commands: readonly GeomCommand[];
}

export interface CustomGeometry {
  readonly paths: readonly GeomPath[];
  /**
   * `<a:rect>` edges in the shape's EMU coordinate system, independent of
   * individual path grids (ECMA-376 §20.1.9.22). Absent means shape bounds;
   * null denotes an authored rectangle whose coordinates could not resolve.
   * An invalid text rectangle must not invalidate otherwise drawable paths.
   */
  readonly textRect?: GeomTextRect | null;
}

export interface GeomTextRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/**
 * Thrown internally when a formula references a guide name that was never
 * defined, or when an unknown `fmla` operator appears. Both are malformed
 * input rather than bugs, so the public reader catches *only this class*
 * and reports it as "geometry could not be evaluated" (returns `null`),
 * while letting any genuine programming error propagate.
 */
class GeomEvalError extends Error {}

const ATTR_NAME = qname("", "name", "");
const ATTR_FMLA = qname("", "fmla", "");
const ATTR_X = qname("", "x", "");
const ATTR_Y = qname("", "y", "");
const ATTR_W = qname("", "w", "");
const ATTR_H = qname("", "h", "");
const ATTR_WR = qname("", "wR", "");
const ATTR_HR = qname("", "hR", "");
const ATTR_ST_ANG = qname("", "stAng", "");
const ATTR_SW_ANG = qname("", "swAng", "");
const ATTR_FILL = qname("", "fill", "");
const ATTR_STROKE = qname("", "stroke", "");

const NAME_AV_LST = qname("a", "avLst", NS.dml);
const NAME_GD_LST = qname("a", "gdLst", NS.dml);
const NAME_PATH_LST = qname("a", "pathLst", NS.dml);
const NAME_RECT = qname("a", "rect", NS.dml);

// 60000ths-of-a-degree is OOXML's angular unit. A full turn is
// 360 × 60000 = 21_600_000; the `cdN` built-in guides are that constant
// divided by N.
const FULL_TURN_60K = 21_600_000;
const toRadians = (sixtyThousandthsDeg: number): number =>
  (sixtyThousandthsDeg / 60_000) * (Math.PI / 180);

const NUMERIC_TOKEN = /^-?\d+(?:\.\d+)?$/;

/**
 * Implicit guides every formula may reference, derived from the shape
 * extents (`w`, `h` in EMU). `ss` is the short side, `ls` the long side.
 * The `cdN` / `NcdN` entries are constant angles in 60000ths of a degree.
 */
const builtinGuides = (w: number, h: number): Map<string, number> => {
  const ss = Math.min(w, h);
  const cd4 = FULL_TURN_60K / 4;
  const cd8 = FULL_TURN_60K / 8;
  return new Map<string, number>([
    ["w", w],
    ["h", h],
    ["ss", ss],
    ["ls", Math.max(w, h)],
    ["hc", w / 2],
    ["vc", h / 2],
    ["t", 0],
    ["l", 0],
    ["b", h],
    ["r", w],
    ["wd2", w / 2],
    ["wd3", w / 3],
    ["wd4", w / 4],
    ["wd5", w / 5],
    ["wd6", w / 6],
    ["wd8", w / 8],
    ["wd10", w / 10],
    // The right-triangle preset uses wd12. LibreOffice's DrawingML importer
    // also recognizes this built-in (omitted from the ECMA guide table).
    ["wd12", w / 12],
    // Used by the canonical ribbon definitions and Apache POI's BuiltInGuide,
    // although omitted from the guide table in ECMA-376 Part 1 §20.1.10.56.
    ["wd32", w / 32],
    ["hd2", h / 2],
    ["hd3", h / 3],
    ["hd4", h / 4],
    ["hd5", h / 5],
    ["hd6", h / 6],
    ["hd8", h / 8],
    ["hd10", h / 10],
    ["ssd2", ss / 2],
    ["ssd4", ss / 4],
    ["ssd6", ss / 6],
    ["ssd8", ss / 8],
    ["ssd16", ss / 16],
    ["ssd32", ss / 32],
    ["cd2", FULL_TURN_60K / 2],
    ["cd4", cd4],
    ["cd6", FULL_TURN_60K / 6],
    ["cd8", cd8],
    ["3cd4", 3 * cd4],
    ["3cd8", 3 * cd8],
    ["5cd8", 5 * cd8],
    ["7cd8", 7 * cd8],
  ]);
};

/** Resolves a single token to a number — literal or a defined guide. */
const resolveToken = (token: string, guides: Map<string, number>): number => {
  const v = NUMERIC_TOKEN.test(token)
    ? Number.parseFloat(token)
    : guides.get(token);
  if (v === undefined)
    throw new GeomEvalError(`unresolved guide reference: ${token}`);
  if (!Number.isFinite(v))
    throw new GeomEvalError(`nonfinite geometry value: ${token}`);
  return v;
};

/**
 * Evaluates one `fmla` string against the guides resolved so far,
 * implementing the operators in ECMA-376 §20.1.9.11. Division by zero
 * yields `0` (the spec's defined result, so a `/0` formula degrades to a
 * point at the origin rather than `NaN`/`Infinity`).
 */
const evalFormula = (fmla: string, guides: Map<string, number>): number => {
  const parts = fmla.trim().split(/\s+/);
  const op = parts[0];
  const a = (i: number): number => resolveToken(parts[i + 1] ?? "", guides);
  const div = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  switch (op) {
    case "val":
      return a(0);
    case "*/":
      return div(a(0) * a(1), a(2));
    case "+-":
      return a(0) + a(1) - a(2);
    case "+/":
      return div(a(0) + a(1), a(2));
    case "?:":
      return a(0) > 0 ? a(1) : a(2);
    case "abs":
      return Math.abs(a(0));
    case "sqrt":
      return Math.sqrt(a(0));
    case "max":
      return Math.max(a(0), a(1));
    case "min":
      return Math.min(a(0), a(1));
    case "mod":
      // Magnitude of the 3-vector (a, b, c).
      return Math.sqrt(a(0) * a(0) + a(1) * a(1) + a(2) * a(2));
    case "pin": {
      // Clamp the middle value into [lo, hi].
      const lo = a(0);
      const v = a(1);
      const hi = a(2);
      return v < lo ? lo : v > hi ? hi : v;
    }
    case "sin":
      return a(0) * Math.sin(toRadians(a(1)));
    case "cos":
      return a(0) * Math.cos(toRadians(a(1)));
    case "tan":
      return a(0) * Math.tan(toRadians(a(1)));
    case "at2":
      // arctan(y / x) in 60000ths of a degree (a0 = x, a1 = y).
      return ((Math.atan2(a(1), a(0)) * 180) / Math.PI) * 60_000;
    case "cat2":
      // a0 · cos(arctan(a2 / a1)).
      return a(0) * Math.cos(Math.atan2(a(2), a(1)));
    case "sat2":
      // a0 · sin(arctan(a2 / a1)).
      return a(0) * Math.sin(Math.atan2(a(2), a(1)));
    default:
      throw new GeomEvalError(`unknown fmla operator: ${op}`);
  }
};

const firstDmlChild = (parent: XmlElement, name: QName): XmlElement | null => {
  for (const c of parent.children) {
    if (
      isElement(c) &&
      c.name.namespaceURI === name.namespaceURI &&
      c.name.localName === name.localName
    )
      return c;
  }
  return null;
};

const dmlChildren = (parent: XmlElement, localName: string): XmlElement[] => {
  const out: XmlElement[] = [];
  for (const c of parent.children) {
    if (
      isElement(c) &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === localName
    )
      out.push(c);
  }
  return out;
};

/**
 * Evaluates `<a:gd>` children of `parent` in document order, writing each
 * result into `guides`. Later guides may reference earlier ones (and may
 * shadow built-ins), so order is load-bearing.
 */
const evalGuideList = (
  parent: XmlElement | null,
  guides: Map<string, number>,
): void => {
  if (parent === null) return;
  for (const c of dmlChildren(parent, "gd")) {
    const name = getAttrValue(c, ATTR_NAME);
    const fmla = getAttrValue(c, ATTR_FMLA);
    if (name === null || fmla === null) continue;
    guides.set(name, evalFormula(fmla, guides));
  }
};

const resolvePt = (pt: XmlElement, guides: Map<string, number>): GeomPoint => ({
  x: resolveToken(getAttrValue(pt, ATTR_X) ?? "0", guides),
  y: resolveToken(getAttrValue(pt, ATTR_Y) ?? "0", guides),
});

const parsePoint = (el: XmlElement, guides: Map<string, number>): GeomPoint => {
  const pt = firstDmlChild(el, qname("a", "pt", NS.dml));
  if (pt === null)
    throw new GeomEvalError(`<a:${el.name.localName}> missing <a:pt>`);
  return resolvePt(pt, guides);
};

const parseIntOrNull = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

const FILL_MODES: ReadonlySet<PathFillMode> = new Set([
  "none",
  "norm",
  "lighten",
  "lightenLess",
  "darken",
  "darkenLess",
]);

// Widening to ReadonlySet<string> is safe (every PathFillMode is a string);
// this lets the guard narrow an arbitrary attribute value to the union.
const isPathFillMode = (s: string): s is PathFillMode =>
  (FILL_MODES as ReadonlySet<string>).has(s);

const parsePath = (
  pathEl: XmlElement,
  guides: Map<string, number>,
): GeomPath => {
  const w = parseIntOrNull(getAttrValue(pathEl, ATTR_W));
  const h = parseIntOrNull(getAttrValue(pathEl, ATTR_H));
  const fillRaw = getAttrValue(pathEl, ATTR_FILL);
  const fill: PathFillMode =
    fillRaw !== null && isPathFillMode(fillRaw) ? fillRaw : "norm";
  const strokeRaw = getAttrValue(pathEl, ATTR_STROKE);
  // `stroke` defaults to true; only an explicit "0"/"false" turns it off.
  const stroke = !(strokeRaw === "0" || strokeRaw === "false");

  const commands: GeomCommand[] = [];
  for (const c of pathEl.children) {
    if (!isElement(c) || c.name.namespaceURI !== NS.dml) continue;
    switch (c.name.localName) {
      case "moveTo":
        commands.push({ kind: "moveTo", pt: parsePoint(c, guides) });
        break;
      case "lnTo":
        commands.push({ kind: "lnTo", pt: parsePoint(c, guides) });
        break;
      case "close":
        commands.push({ kind: "close" });
        break;
      case "arcTo":
        commands.push({
          kind: "arcTo",
          wR: resolveToken(getAttrValue(c, ATTR_WR) ?? "0", guides),
          hR: resolveToken(getAttrValue(c, ATTR_HR) ?? "0", guides),
          stAng: resolveToken(getAttrValue(c, ATTR_ST_ANG) ?? "0", guides),
          swAng: resolveToken(getAttrValue(c, ATTR_SW_ANG) ?? "0", guides),
        });
        break;
      case "quadBezTo": {
        const pts = dmlChildren(c, "pt");
        if (pts.length < 2)
          throw new GeomEvalError("<a:quadBezTo> needs 2 points");
        commands.push({
          kind: "quadBezTo",
          pts: [resolvePt(pts[0]!, guides), resolvePt(pts[1]!, guides)],
        });
        break;
      }
      case "cubicBezTo": {
        const pts = dmlChildren(c, "pt");
        if (pts.length < 3)
          throw new GeomEvalError("<a:cubicBezTo> needs 3 points");
        commands.push({
          kind: "cubicBezTo",
          pts: [
            resolvePt(pts[0]!, guides),
            resolvePt(pts[1]!, guides),
            resolvePt(pts[2]!, guides),
          ],
        });
        break;
      }
      // `<a:path>` only ever contains the six command elements above
      // (ECMA-376 §20.1.9.15); anything else is foreign and ignored.
    }
  }
  return { w, h, fill, stroke, commands };
};

/**
 * Parses `<a:custGeom>` into a fully-evaluated {@link CustomGeometry}.
 * `shapeW` / `shapeH` are the shape extents in EMU, feeding the implicit
 * built-in guides (`w`, `h`, `ss`, …).
 *
 * Returns `null` when the geometry can't be evaluated because the input is
 * malformed (an unresolved guide reference, an unknown `fmla` operator, or
 * a command missing its points). Callers use that to fall back to a
 * placeholder rather than emit broken output.
 */
export const parseCustomGeometry = (
  custGeom: XmlElement,
  shapeW: number,
  shapeH: number,
  adjustmentOverrides: XmlElement | null = null,
): CustomGeometry | null => {
  try {
    // avLst first, then gdLst — adjust values are inputs the gdLst formulas
    // build on. Both are evaluated against the same map so a gd can read an
    // earlier av, and an av can shadow a built-in.
    const guides = builtinGuides(shapeW, shapeH);
    evalGuideList(firstDmlChild(custGeom, NAME_AV_LST), guides);
    // Presets provide default adjustments. Authored avLst formulas override
    // them before dependent gdLst formulas and paths are evaluated.
    evalGuideList(adjustmentOverrides, guides);
    evalGuideList(firstDmlChild(custGeom, NAME_GD_LST), guides);

    const rect = firstDmlChild(custGeom, NAME_RECT);
    let textRect: GeomTextRect | null | undefined;
    if (rect) {
      try {
        const edge = (name: string): number =>
          resolveToken(getAttrValue(rect, qname("", name, "")) ?? "", guides);
        textRect = { l: edge("l"), t: edge("t"), r: edge("r"), b: edge("b") };
      } catch (err) {
        if (!(err instanceof GeomEvalError)) throw err;
        textRect = null;
      }
    }

    const pathLst = firstDmlChild(custGeom, NAME_PATH_LST);
    const paths: GeomPath[] = [];
    if (pathLst)
      for (const p of dmlChildren(pathLst, "path")) {
        paths.push(parsePath(p, guides));
      }
    return { paths, ...(textRect !== undefined ? { textRect } : {}) };
  } catch (err) {
    if (err instanceof GeomEvalError) return null;
    throw err;
  }
};

/**
 * The connection sites of a geometry (`<a:cxnLst>`, ECMA-376 §20.1.9.9),
 * evaluated for a shape `shapeW` × `shapeH` EMU: where a connector's end
 * attaches, in the shape's own unturned, unmirrored box, by site index.
 * Returns `null` when the geometry cannot be evaluated, and an empty list
 * when it has no sites.
 */
export const parseConnectionSites = (
  geometry: XmlElement,
  shapeW: number,
  shapeH: number,
  adjustmentOverrides: XmlElement | null = null,
): GeomPoint[] | null => {
  try {
    const guides = builtinGuides(shapeW, shapeH);
    evalGuideList(firstDmlChild(geometry, NAME_AV_LST), guides);
    evalGuideList(adjustmentOverrides, guides);
    evalGuideList(firstDmlChild(geometry, NAME_GD_LST), guides);
    const list = firstDmlChild(geometry, qname("a", "cxnLst", NS.dml));
    if (!list) return [];
    return dmlChildren(list, "cxn").map((cxn) => {
      const pos = firstDmlChild(cxn, qname("a", "pos", NS.dml));
      if (!pos) throw new GeomEvalError("<a:cxn> missing <a:pos>");
      return resolvePt(pos, guides);
    });
  } catch (err) {
    if (err instanceof GeomEvalError) return null;
    throw err;
  }
};
