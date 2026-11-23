// Connector attachments: which shapes a connector's ends are glued to
// (`<a:stCxn>` / `<a:endCxn>`, ECMA-376 §19.3.1.13), and where on a shape
// those connection sites are.

import {
  type GeomPoint,
  parseConnectionSites,
} from "../../internal/drawingml/custom-geometry.ts";
import { presetConnectionSites } from "../../internal/drawingml/preset-geometry.ts";
import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import {
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitSlideData, refreshSlideData } from "./_helpers.ts";

/** One glued end: the shape's id and the index of its connection site. */
export interface ConnectorEnd {
  readonly id: number;
  readonly site: number;
}

export interface ConnectorConnections {
  readonly start: ConnectorEnd | null;
  readonly end: ConnectorEnd | null;
}

const glued = (
  props: XmlElement | null,
  local: string,
): ConnectorEnd | null => {
  const el = props && firstChildElement(props, qname("a", local, NS.dml));
  if (!el) return null;
  const id = Number(getAttrValue(el, qname("", "id", "")));
  const site = Number(getAttrValue(el, qname("", "idx", "")) ?? "0");
  return Number.isInteger(id) && Number.isInteger(site) && site >= 0
    ? { id, site }
    : null;
};

const connectorProps = (shape: SlideShapeData): XmlElement | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "connector") return null;
  const nv = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "nvCxnSpPr", NS.pml),
  );
  return nv && firstChildElement(nv, qname("p", "cNvCxnSpPr", NS.pml));
};

/** The shapes a connector's start and end are glued to, if any. */
export const getConnectorConnections = (
  shape: SlideShapeData,
): ConnectorConnections => {
  const props = connectorProps(shape);
  return { start: glued(props, "stCxn"), end: glued(props, "endCxn") };
};

/**
 * Glues a connector's ends to shapes, or frees them (`null`). An end left
 * out of `connections` keeps what it has. Does nothing to a shape that is
 * not a connector.
 */
export const setConnectorConnections = (
  shape: SlideShapeData,
  connections: Partial<ConnectorConnections>,
): void => {
  const props = connectorProps(shape);
  if (!props) return;
  for (const [key, local] of [
    ["start", "stCxn"],
    ["end", "endCxn"],
  ] as const) {
    if (!(key in connections)) continue;
    const next = connections[key];
    const name = qname("a", local, NS.dml);
    const kept = props.children.filter(
      (c) =>
        c.kind !== "element" ||
        c.name.namespaceURI !== NS.dml ||
        c.name.localName !== local,
    );
    const glue = next
      ? [
          elem(name, {
            attrs: [
              attr(qname("", "id", ""), String(next.id)),
              attr(qname("", "idx", ""), String(next.site)),
            ],
          }),
        ]
      : [];
    // stCxn precedes endCxn, after any locks (CT_NonVisualConnectorProperties).
    const at =
      local === "stCxn"
        ? kept.findIndex(
            (c) =>
              c.kind === "element" &&
              c.name.namespaceURI === NS.dml &&
              c.name.localName !== "cxnSpLocks",
          )
        : kept.findIndex(
            (c) =>
              c.kind === "element" &&
              c.name.namespaceURI === NS.dml &&
              c.name.localName === "extLst",
          );
    props.children =
      at < 0
        ? [...kept, ...glue]
        : [...kept.slice(0, at), ...glue, ...kept.slice(at)];
  }
  commitSlideData(shape[SHAPE_SLIDE]);
  refreshSlideData(shape[SHAPE_SLIDE]);
};

/**
 * The connection sites of a shape drawn `w` × `h` EMU, by site index, in
 * its own unturned, unmirrored box (origin at its top left corner). Empty
 * when it has none (a picture or a table without a geometry, say), `null`
 * when its geometry cannot be evaluated.
 */
export const getShapeConnectionSites = (
  shape: SlideShapeData,
  w: number,
  h: number,
): ReadonlyArray<GeomPoint> | null => {
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  if (!spPr) return [];
  const custom = firstChildElement(spPr, qname("a", "custGeom", NS.dml));
  if (custom) return parseConnectionSites(custom, w, h);
  const preset = firstChildElement(spPr, qname("a", "prstGeom", NS.dml));
  const name = preset && getAttrValue(preset, qname("", "prst", ""));
  if (!preset || !name) return [];
  return presetConnectionSites(
    name,
    w,
    h,
    firstChildElement(preset, qname("a", "avLst", NS.dml)),
  );
};
