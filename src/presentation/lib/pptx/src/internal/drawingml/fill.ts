// Solid-fill mutation for shapes and slide backgrounds.
//
// The spec places the fill element after geometry (`prstGeom`/`custGeom`)
// and before the line (`a:ln`) on a shape's `<p:spPr>`. We re-insert
// rather than append so re-applying a fill stays clean across calls.
//
// `setSolidFill(host, color)` accepts the host element that wraps the
// fill (`p:spPr` for shapes, `p:bgPr` for backgrounds). It removes any
// previous fill choice (`noFill`/`solidFill`/`gradFill`/`blipFill`/
// `pattFill`/`grpFill`) before inserting the new `solidFill`.

import { oneOf } from "../bounds.ts";
import { NS, type XmlElement, attr, elem, qname } from "../xml/index.ts";
import { buildColorElement } from "./color.ts";

const NAME_SOLID_FILL = qname("a", "solidFill", NS.dml);
const NAME_NO_FILL = qname("a", "noFill", NS.dml);
const NAME_GRAD_FILL = qname("a", "gradFill", NS.dml);
const NAME_GS_LST = qname("a", "gsLst", NS.dml);
const NAME_GS = qname("a", "gs", NS.dml);
const NAME_LIN = qname("a", "lin", NS.dml);
const NAME_PATH = qname("a", "path", NS.dml);
const NAME_FILL_TO_RECT = qname("a", "fillToRect", NS.dml);
const ATTR_PATH = qname("", "path", "");
const ATTR_POS = qname("", "pos", "");
const ATTR_ANG = qname("", "ang", "");
const ATTR_SCALED = qname("", "scaled", "");
const ATTR_FLIP = qname("", "flip", "");
const ATTR_ROT_WITH_SHAPE = qname("", "rotWithShape", "");

const FILL_CHOICE_LOCAL_NAMES = new Set([
  "noFill",
  "solidFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
]);

const removeAnyFill = (host: XmlElement): void => {
  host.children = host.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        FILL_CHOICE_LOCAL_NAMES.has(c.name.localName)
      ),
  );
};

/**
 * Returns the index where the fill should be inserted on `host` per the
 * schema's child-element sequence. For `<p:spPr>` that's right after the
 * geometry element; for `<p:bgPr>` it's the start.
 *
 * The schema is more nuanced (xfrm → geometry → fill → ln → effects →
 * scene3d → sp3d → extLst) but readers tolerate any of those slots
 * being absent, and we only care about staying ahead of `a:ln`.
 */
const fillInsertionIndex = (host: XmlElement): number => {
  for (let i = 0; i < host.children.length; i++) {
    const c = host.children[i];
    if (c?.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    if (c.name.localName === "ln") return i;
    if (c.name.localName === "effectLst" || c.name.localName === "effectDag")
      return i;
    if (c.name.localName === "scene3d" || c.name.localName === "sp3d") return i;
    if (c.name.localName === "extLst") return i;
  }
  return host.children.length;
};

/** Sets `<a:solidFill>` on `host`, removing any previous fill choice. */
export const setSolidFill = (host: XmlElement, color: string): void => {
  removeAnyFill(host);
  const fill = elem(NAME_SOLID_FILL, { children: [buildColorElement(color)] });
  host.children.splice(fillInsertionIndex(host), 0, fill);
};

/** Sets `<a:noFill>` on `host`, removing any previous fill choice. */
export const setNoFill = (host: XmlElement): void => {
  removeAnyFill(host);
  host.children.splice(fillInsertionIndex(host), 0, elem(NAME_NO_FILL));
};

/**
 * Removes any fill choice from `host` entirely. The shape then inherits
 * its fill from the layout / master placeholder it descends from.
 */
export const clearFill = (host: XmlElement): void => {
  removeAnyFill(host);
};

/** One stop in a linear gradient. */
export interface GradientStop {
  /** Position on the gradient axis, 0-1. */
  readonly offset: number;
  /** `#RRGGBB`, bare `RRGGBB`, or a scheme color token. */
  readonly color: string;
  /** Stop opacity, from 0 (transparent) to 1 (opaque). Defaults to 1. */
  readonly opacity?: number;
}

export interface GradientFillOptions {
  /** Two or more color stops along the axis. */
  readonly stops: ReadonlyArray<GradientStop>;
  /**
   * Gradient axis angle, in degrees. ECMA-376 measures clockwise from
   * the right (3 o'clock); `0` is a left-to-right gradient, `90` is
   * top-to-bottom, `180` right-to-left, `270` bottom-to-top. Defaults
   * to `90` (top → bottom). Only meaningful for linear gradients.
   */
  readonly angleDeg?: number;
  /** Scale the linear gradient with the shape's aspect ratio. Defaults to false. */
  readonly scaled?: boolean;
  /**
   * Gradient tile insets relative to the paint bounds (DrawingML tileRect).
   * Positive values inset an edge; negative values extend it. Missing edges
   * are zero. Linear shading is reflected outside this tile.
   */
  readonly tileRect?: {
    readonly left?: number;
    readonly top?: number;
    readonly right?: number;
    readonly bottom?: number;
  };
  /**
   * Non-linear gradient path. `circle` paints concentric circles,
   * `rect` paints nested rectangles, `shape` follows the shape's
   * outline. Absent / `'linear'` → linear gradient using `angleDeg`.
   * Mirrors ECMA-376 §20.1.8.33 `<a:path path="…"/>`.
   */
  readonly path?: "linear" | "circle" | "rect" | "shape";
  /**
   * Focus rectangle for non-linear gradients, as fractions of the shape
   * inset from each edge (so `{left: 0.3, right: 0.7}` puts the focus at
   * 30% across). When omitted, defaults to a single point at the
   * rectangle's center. Mirrors `<a:fillToRect>`.
   */
  readonly focus?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

/** Every `ST_PresetPatternVal` token (ECMA-376 dml-main.xsd). */
export const PATTERN_PRESETS = [
  "pct5",
  "pct10",
  "pct20",
  "pct25",
  "pct30",
  "pct40",
  "pct50",
  "pct60",
  "pct70",
  "pct75",
  "pct80",
  "pct90",
  "horz",
  "vert",
  "ltHorz",
  "ltVert",
  "dkHorz",
  "dkVert",
  "narHorz",
  "narVert",
  "dashHorz",
  "dashVert",
  "cross",
  "dnDiag",
  "upDiag",
  "ltDnDiag",
  "ltUpDiag",
  "dkDnDiag",
  "dkUpDiag",
  "wdDnDiag",
  "wdUpDiag",
  "dashDnDiag",
  "dashUpDiag",
  "diagCross",
  "smCheck",
  "lgCheck",
  "smGrid",
  "lgGrid",
  "dotGrid",
  "smConfetti",
  "lgConfetti",
  "horzBrick",
  "diagBrick",
  "solidDmnd",
  "openDmnd",
  "dotDmnd",
  "plaid",
  "sphere",
  "weave",
  "divot",
  "shingle",
  "wave",
  "trellis",
  "zigZag",
] as const;

/** One of ECMA-376's `ST_PresetPatternVal` tokens (`pct50`, `dkUpDiag`, ...). */
export type PatternPreset = (typeof PATTERN_PRESETS)[number];

export interface PatternFillOptions {
  /** Preset pattern token, e.g. `'pct50'`, `'dkUpDiag'`, `'wave'`. */
  readonly preset: PatternPreset;
  /** Foreground (pattern stroke) color. `#RRGGBB`, bare `RRGGBB`, or scheme token. */
  readonly foreground: string;
  /** Background (fill behind the pattern) color. */
  readonly background: string;
}

const NAME_PATT_FILL = qname("a", "pattFill", NS.dml);
const NAME_FG_CLR = qname("a", "fgClr", NS.dml);
const NAME_BG_CLR = qname("a", "bgClr", NS.dml);
const ATTR_PRST = qname("", "prst", "");

/**
 * Sets `<a:pattFill>` on `host` with the given preset + colors.
 * Replaces any previous fill choice.
 */
export const setPatternFill = (
  host: XmlElement,
  options: PatternFillOptions,
): void => {
  removeAnyFill(host);
  // `preset` is typed but authoring input is a boundary — reject an out-of-enum
  // token rather than emitting a schema-invalid `prst`.
  const preset = oneOf(
    options.preset,
    PATTERN_PRESETS,
    "setShapePatternFill: preset",
  );
  const pattFill = elem(NAME_PATT_FILL, {
    attrs: [attr(ATTR_PRST, preset)],
    children: [
      elem(NAME_FG_CLR, { children: [buildColorElement(options.foreground)] }),
      elem(NAME_BG_CLR, { children: [buildColorElement(options.background)] }),
    ],
  });
  host.children.splice(fillInsertionIndex(host), 0, pattFill);
};

/** Sets `<a:gradFill>` on `host`, replacing any previous fill choice. */
export const setGradientFill = (
  host: XmlElement,
  options: GradientFillOptions,
): void => {
  if (options.stops.length < 2) {
    throw new Error("gradient fill requires at least two stops");
  }

  const stops = options.stops.map((s) => {
    if (!Number.isFinite(s.offset) || s.offset < 0 || s.offset > 1) {
      throw new RangeError(
        `gradient stop offset must be in [0, 1], got ${s.offset}`,
      );
    }
    const color = buildColorElement(s.color);
    if (s.opacity !== undefined) {
      if (!Number.isFinite(s.opacity) || s.opacity < 0 || s.opacity > 1)
        throw new RangeError("gradient stop opacity must be in [0, 1]");
      color.children.push(
        elem(qname("a", "alpha", NS.dml), {
          attrs: [
            attr(qname("", "val", ""), String(Math.round(s.opacity * 100000))),
          ],
        }),
      );
    }
    const posST = String(Math.round(s.offset * 100000));
    return elem(NAME_GS, {
      attrs: [attr(ATTR_POS, posST)],
      children: [color],
    });
  });

  // The gradient direction is a choice: `<a:lin>` for a linear gradient (using
  // angleDeg) or `<a:path path="circle|rect|shape">` for a non-linear one. When
  // a path is requested we honor the documented `focus` fillToRect; emitting
  // <a:lin> regardless (the prior behavior) silently downgraded radial/shape
  // gradients to linear.
  const pct = (n: number): string => String(Math.round(n * 100000));
  const directionEl =
    options.path === undefined || options.path === "linear"
      ? ((): XmlElement => {
          const angleDeg = options.angleDeg ?? 90;
          // ECMA-376 ST_PositiveFixedAngle: 60000 units per degree, range
          // [0, 21600000). Normalize negatives via modulo.
          const norm = ((angleDeg % 360) + 360) % 360;
          return elem(NAME_LIN, {
            attrs: [
              attr(ATTR_ANG, String(Math.round(norm * 60000))),
              attr(ATTR_SCALED, options.scaled ? "1" : "0"),
            ],
          });
        })()
      : elem(NAME_PATH, {
          attrs: [attr(ATTR_PATH, options.path)],
          children:
            options.focus === undefined
              ? []
              : [
                  elem(NAME_FILL_TO_RECT, {
                    attrs: [
                      attr(qname("", "l", ""), pct(options.focus.left)),
                      attr(qname("", "t", ""), pct(options.focus.top)),
                      attr(qname("", "r", ""), pct(options.focus.right)),
                      attr(qname("", "b", ""), pct(options.focus.bottom)),
                    ],
                  }),
                ],
        });

  const grad = elem(NAME_GRAD_FILL, {
    attrs: [attr(ATTR_FLIP, "none"), attr(ATTR_ROT_WITH_SHAPE, "1")],
    children: [elem(NAME_GS_LST, { children: stops }), directionEl],
  });
  if (options.tileRect) {
    const attrs = (
      [
        ["l", options.tileRect.left],
        ["t", options.tileRect.top],
        ["r", options.tileRect.right],
        ["b", options.tileRect.bottom],
      ] as const
    ).flatMap(([name, value]) => {
      if (value === undefined) return [];
      if (!Number.isFinite(value))
        throw new RangeError("gradient tile insets must be finite");
      return [attr(qname("", name, ""), pct(value))];
    });
    grad.children.push(elem(qname("a", "tileRect", NS.dml), { attrs }));
  }
  // Validate and construct the replacement before changing the existing fill.
  removeAnyFill(host);
  host.children.splice(fillInsertionIndex(host), 0, grad);
};
