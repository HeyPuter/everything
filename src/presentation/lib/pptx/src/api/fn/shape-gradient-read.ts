import { resolveDrawingColor, resolveDrawingOpacity } from "./shape-color.ts";
import { type PresentationTheme } from "./theme.ts";
import { getEffectiveColorMap } from "./color-map.ts";
import { getShapeGradientSource } from "./shape-fill-inheritance.ts";

// Detailed gradient-fill reader.

import { type GradientFillOptions } from "../../internal/drawingml/index.ts";

import {
  NS,
  type XmlElement,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import {
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  type SlideShapeData,
} from "../_internal-symbols.ts";
// ---------------------------------------------------------------------------
// Detailed gradient-fill reader. Companion to `getShapeFill`, which
// only reports the discriminated `kind`. Returns the full stop list +
// angle when the shape carries a `<a:gradFill>` of its own, or
// `null` for solid / pattern / image / none / inherited fills.
//
// Useful for renderers (preview generators, PDF exporters) that need
// to reproduce the gradient instead of substituting a placeholder.

export const NAME_A_GRAD_FILL = qname("a", "gradFill", NS.dml);
export const NAME_A_GS_LST = qname("a", "gsLst", NS.dml);
export const NAME_A_LIN = qname("a", "lin", NS.dml);

export const readColorFromContainer = (parent: XmlElement): string | null => {
  for (const c of parent.children) {
    if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    if (c.name.localName === "srgbClr") {
      const val = getAttrValue(c, qname("", "val", ""));
      if (val !== null) return `#${val.toUpperCase()}`;
    }
    if (c.name.localName === "schemeClr") {
      const val = getAttrValue(c, qname("", "val", ""));
      if (val !== null) return `scheme:${val}`;
    }
  }
  return null;
};

export interface GradientColorContext {
  readonly theme: PresentationTheme | null;
  readonly clrMap?: Readonly<Record<string, string>> | null;
}

/** Shared by shape and background readers; leaves the authored XML untouched. */
export const readGradientStops = (
  gradFill: XmlElement,
  context?: GradientColorContext,
): GradientFillOptions["stops"] => {
  const gsLst = firstChildElement(gradFill, NAME_A_GS_LST);
  if (!gsLst) return [];
  const stops: Array<{ offset: number; color: string; opacity?: number }> = [];
  for (const stop of gsLst.children) {
    if (
      stop.kind !== "element" ||
      stop.name.namespaceURI !== NS.dml ||
      stop.name.localName !== "gs"
    )
      continue;
    const posRaw = getAttrValue(stop, qname("", "pos", ""));
    if (posRaw === null) continue;
    const pos = Number(posRaw.endsWith("%") ? posRaw.slice(0, -1) : posRaw);
    if (!posRaw.trim() || !Number.isFinite(pos)) continue;
    let color = readColorFromContainer(stop);
    let opacity = 1;
    for (const node of stop.children) {
      if (node.kind !== "element" || node.name.namespaceURI !== NS.dml)
        continue;
      const resolved = resolveDrawingColor(
        node,
        context && node.name.localName === "schemeClr" ? context.theme : null,
        context?.clrMap,
      );
      if (resolved !== null && (context || color === null)) color = resolved;
      if (resolved !== null || node.name.localName === "schemeClr") {
        opacity = resolveDrawingOpacity(node);
        break;
      }
    }
    if (color !== null)
      stops.push({
        offset: pos / (posRaw.endsWith("%") ? 100 : 100000),
        color,
        ...(opacity !== 1 ? { opacity } : {}),
      });
  }
  return stops;
};

/** Nonzero tile insets; empty/default rectangles retain the ordinary fill view. */
export const readGradientTile = (
  gradFill: XmlElement,
): Pick<GradientFillOptions, "tileRect"> => {
  const tileElement = firstChildElement(
    gradFill,
    qname("a", "tileRect", NS.dml),
  );
  const tileRect = Object.fromEntries(
    (
      [
        ["l", "left"],
        ["t", "top"],
        ["r", "right"],
        ["b", "bottom"],
      ] as const
    ).flatMap(([name, key]) => {
      const raw = tileElement
        ? getAttrValue(tileElement, qname("", name, ""))
        : null;
      if (raw === null || !raw.trim()) return [];
      const percent = raw.endsWith("%"),
        value = Number(percent ? raw.slice(0, -1) : raw);
      return Number.isFinite(value) && value !== 0
        ? [[key, value / (percent ? 100 : 100000)]]
        : [];
    }),
  );
  return Object.keys(tileRect).length ? { tileRect } : {};
};

// Parses one `<a:gradFill>` element into the stop list + direction.
// Shared by the shape-own reader and the placeholder-cascade reader.
export const parseGradFill = (
  gradFill: XmlElement,
  context?: GradientColorContext,
): GradientFillOptions | null => {
  const stops = readGradientStops(gradFill, context);
  if (stops.length === 0) return null;
  const tile = readGradientTile(gradFill);
  // ECMA-376 §20.1.8.33: gradFill has either <a:lin> (linear) or <a:path>
  // (radial / rectangular / shape-following) as a child to describe the
  // direction. We surface both so renderers can faithfully reproduce
  // non-linear gradients.
  let angleDeg = 0;
  const lin = firstChildElement(gradFill, NAME_A_LIN);
  if (lin) {
    const angRaw = getAttrValue(lin, qname("", "ang", ""));
    if (angRaw !== null) {
      const ang = Number.parseInt(angRaw, 10);
      if (Number.isFinite(ang)) angleDeg = ang / 60_000;
    }
  }
  const pathEl = firstChildElement(gradFill, qname("a", "path", NS.dml));
  if (pathEl) {
    const p = getAttrValue(pathEl, qname("", "path", ""));
    const pathVal: "circle" | "rect" | "shape" | null =
      p === "circle" || p === "rect" || p === "shape" ? p : null;
    if (pathVal) {
      let focus: GradientFillOptions["focus"];
      const fillToRect = firstChildElement(
        pathEl,
        qname("a", "fillToRect", NS.dml),
      );
      if (fillToRect) {
        const pct = (name: string): number | undefined => {
          const v = getAttrValue(fillToRect, qname("", name, ""));
          if (v === null) return undefined;
          let n = Number.parseFloat(v);
          if (!Number.isFinite(n)) return undefined;
          if (Math.abs(n) > 1) n = n / 100000;
          return n;
        };
        const l = pct("l") ?? 0.5;
        const t = pct("t") ?? 0.5;
        const r = pct("r") ?? 0.5;
        const b = pct("b") ?? 0.5;
        focus = { left: l, top: t, right: r, bottom: b };
      }
      return {
        stops,
        angleDeg,
        path: pathVal,
        ...(focus ? { focus } : {}),
        ...tile,
      };
    }
  }
  const rotWithShape = getAttrValue(gradFill, qname("", "rotWithShape", ""));
  return {
    stops,
    angleDeg,
    ...tile,
    ...(rotWithShape === "0" || rotWithShape === "false"
      ? { fixedToPage: true as const }
      : {}),
    ...(["1", "true"].includes(
      lin ? (getAttrValue(lin, qname("", "scaled", "")) ?? "") : "",
    )
      ? { scaled: true }
      : {}),
  };
};

/**
 * Returns the full gradient definition (`stops` + `angleDeg`) when the
 * shape's `<p:spPr>` carries an `<a:gradFill>`. Returns `null` for any
 * other fill kind, including `inherit` — the function does not walk the
 * layout / master cascade. Use `getShapeGradientFillEffective` for that.
 */
export const getShapeGradientFill = (
  shape: SlideShapeData,
): GradientFillOptions | null => {
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  if (!spPr) return null;
  const gradFill = firstChildElement(spPr, NAME_A_GRAD_FILL);
  if (!gradFill) return null;
  return parseGradFill(gradFill);
};

/** Returns the effective gradient after merging literal, style and placeholder
 * properties. A nearer non-gradient fill blocks gradient inheritance. */
export const getShapeGradientFillEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  colorMap?: Readonly<Record<string, string>> | null,
): GradientFillOptions | null => {
  const source = getShapeGradientSource(shape, colorMap);
  if (!source) return null;
  let effectiveMap = colorMap;
  return parseGradFill(source.element, {
    get theme() {
      return source.theme;
    },
    get clrMap() {
      return (effectiveMap ??= getEffectiveColorMap(shape[SHAPE_SLIDE]));
    },
  });
};
