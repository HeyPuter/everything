// Presentation points (ECMA-376 21.4.3): one `dgm:pt type="pres"` for each
// layout node the definition instantiates, tied into a tree by `presParOf`
// connections and to the data they show by `presOf` connections.
//
// Desktop editors lay a diagram out again from its layout definition when
// they open it, and keep a shape's own formatting (fill, outline, geometry,
// size, picture) only from a presentation point that sits in that tree. A
// point that floats free of it is dropped. So when any shape carries its own
// formatting, the whole tree is written, by running the layout definition's
// `forEach` / `layoutNode` structure over the data.
import {
  type XmlElement,
  getAttrValue,
  parseXml,
  qname,
  serializeFragment,
} from "../../../internal/xml/index.ts";
import type { LayoutFamily } from "./layout-def.ts";
import type { Role } from "./paint.ts";

/** A data point of the outline as the tree walk sees it. */
export interface PresDataNode {
  readonly id: string;
  readonly parTrans: string;
  readonly sibTrans: string;
  readonly depth: number;
  readonly children: ReadonlyArray<PresDataNode>;
}

export interface PresPoint {
  readonly id: string;
  /** The data point the layout node was instantiated for. */
  readonly assoc: string;
  /** The layout node's name. */
  readonly name: string;
  readonly styleLbl: string | null;
  styleIdx: number;
  styleCnt: number;
  /** `presLayoutVars` content (the layout node's variables). */
  readonly vars: string;
}

export interface PresConnection {
  readonly type: "presOf" | "presParOf";
  readonly src: string;
  readonly dest: string;
  readonly srcOrd: number;
  readonly destOrd: number;
}

export interface PresTree {
  readonly uniqueId: string;
  readonly points: PresPoint[];
  readonly connections: PresConnection[];
}

const A = (name: string) => qname("", name, "");
const kids = (e: XmlElement): XmlElement[] =>
  e.children.filter((c): c is XmlElement => c.kind === "element");
const local = (e: XmlElement) => e.name.localName;
const att = (e: XmlElement, name: string) => getAttrValue(e, A(name));

interface Context {
  readonly id: string;
  readonly node: PresDataNode | null;
  readonly kind: "doc" | "node" | "sibTrans" | "parTrans";
  readonly siblings: ReadonlyArray<PresDataNode>;
  readonly index: number;
}

const descendants = (node: PresDataNode): string[] =>
  node.children.flatMap((c) => [c.id, ...descendants(c)]);

/**
 * Runs a layout definition over the outline `roots` (the doc point is
 * `docId`) and returns the presentation points and connections a desktop
 * editor would keep for it. `newId` mints model ids.
 */
export const buildPresTree = (
  layoutDefXml: string,
  docId: string,
  roots: ReadonlyArray<PresDataNode>,
  newId: () => string,
): PresTree | null => {
  let def: XmlElement;
  try {
    def = parseXml(layoutDefXml).root;
  } catch {
    return null;
  }
  const rootNode = kids(def).find((e) => local(e) === "layoutNode");
  if (!rootNode) return null;
  const uniqueId = att(def, "uniqueId") ?? "";
  const named = new Map<string, XmlElement>();
  const collect = (e: XmlElement) => {
    for (const c of kids(e)) {
      if (local(c) === "forEach" && att(c, "name") && !att(c, "ref"))
        named.set(att(c, "name")!, c);
      collect(c);
    }
  };
  collect(def);
  // Cycles close the ring: the last item has a transition back to the first.
  const rootAlg = kids(rootNode).find((e) => local(e) === "alg");
  const cyclic = rootAlg ? att(rootAlg, "type") === "cycle" : false;

  const points: PresPoint[] = [];
  const connections: PresConnection[] = [];
  const childCount = new Map<string, number>();

  const varsOf = (ln: XmlElement): string => {
    const list = kids(ln).find((e) => local(e) === "varLst");
    return list
      ? kids(list)
          // The data model declares the diagram namespace on its root.
          .map((v) => serializeFragment(v).replace(/ xmlns:dgm="[^"]*"/g, ""))
          .join("")
      : "";
  };

  const nodeContext = (
    node: PresDataNode,
    siblings: ReadonlyArray<PresDataNode>,
    index: number,
  ): Context => ({ id: node.id, node, kind: "node", siblings, index });

  const layoutNode = (
    ln: XmlElement,
    ctx: Context,
    parent: PresPoint | null,
  ): void => {
    const point: PresPoint = {
      id: newId(),
      assoc: ctx.id,
      name: att(ln, "name") ?? "",
      styleLbl: att(ln, "styleLbl"),
      styleIdx: 0,
      styleCnt: 0,
      vars: varsOf(ln),
    };
    points.push(point);
    if (parent) {
      const n = childCount.get(parent.id) ?? 0;
      childCount.set(parent.id, n + 1);
      connections.push({
        type: "presParOf",
        src: parent.id,
        dest: point.id,
        srcOrd: n,
        destOrd: 0,
      });
    }
    const presOf = kids(ln).find((e) => local(e) === "presOf");
    const axis = presOf ? att(presOf, "axis") : null;
    const shown: string[] = !axis
      ? []
      : axis === "self"
        ? [ctx.id]
        : axis === "desOrSelf"
          ? [
              ctx.id,
              ...(ctx.node && ctx.kind === "node" ? descendants(ctx.node) : []),
            ]
          : axis === "des"
            ? ctx.node && ctx.kind === "node"
              ? descendants(ctx.node)
              : []
            : axis === "ch"
              ? (ctx.node?.children ?? []).map((c) => c.id)
              : [];
    shown.forEach((src, k) =>
      connections.push({
        type: "presOf",
        src,
        dest: point.id,
        srcOrd: 0,
        destOrd: k,
      }),
    );
    for (const child of kids(ln)) structural(child, ctx, point);
  };

  const forEach = (fe: XmlElement, ctx: Context, parent: PresPoint): void => {
    const ref = att(fe, "ref");
    const body = ref ? named.get(ref) : fe;
    if (!body) return;
    const axis = att(body, "axis") ?? "self";
    const ptType = att(body, "ptType") ?? "all";
    let contexts: Context[] = [];
    if (axis === "ch" && (ptType === "node" || ptType === "all")) {
      const list =
        ctx.kind === "doc"
          ? roots
          : ctx.kind === "node"
            ? (ctx.node?.children ?? [])
            : [];
      contexts = list.map((n, i) => nodeContext(n, list, i));
    } else if (axis === "followSib" && ptType === "sibTrans") {
      if (
        ctx.kind === "node" &&
        ctx.node &&
        (cyclic || ctx.index < ctx.siblings.length - 1)
      )
        contexts = [{ ...ctx, id: ctx.node.sibTrans, kind: "sibTrans" }];
    } else if (axis === "precedSib" && ptType === "parTrans") {
      if (ctx.kind === "node" && ctx.node)
        contexts = [{ ...ctx, id: ctx.node.parTrans, kind: "parTrans" }];
    } else if (axis === "self") contexts = [ctx];
    const cnt = Number(att(body, "cnt") ?? 0);
    if (cnt > 0) contexts = contexts.slice(0, cnt);
    for (const c of contexts)
      for (const child of kids(body)) structural(child, c, parent);
  };

  const structural = (e: XmlElement, ctx: Context, parent: PresPoint) => {
    if (local(e) === "layoutNode") layoutNode(e, ctx, parent);
    else if (local(e) === "forEach") forEach(e, ctx, parent);
  };

  layoutNode(
    rootNode,
    { id: docId, node: null, kind: "doc", siblings: [], index: 0 },
    null,
  );

  // Style index and count among the points sharing a style label.
  const totals = new Map<string, number>();
  for (const p of points)
    if (p.styleLbl) {
      p.styleIdx = totals.get(p.styleLbl) ?? 0;
      totals.set(p.styleLbl, p.styleIdx + 1);
    }
  for (const p of points) if (p.styleLbl) p.styleCnt = totals.get(p.styleLbl)!;
  return { uniqueId, points, connections };
};

/**
 * The layout node of `family` that draws an item's shape of `role`, or null
 * when the definition has no node of its own for it. `depth` is the item's
 * outline level (0 for top-level items).
 */
export const layoutNodeForRole = (
  family: LayoutFamily,
  role: string,
  depth: number,
): string | null => {
  const r = role as Role;
  switch (family.kind) {
    case "snake":
    case "linear":
    case "cycle":
      return ["node", "hub", "venn", "text"].includes(r) ? "node" : null;
    case "composite":
      return ["node", "hub", "text"].includes(r)
        ? "head"
        : r === "child"
          ? "body"
          : null;
    case "picture":
      return r === "pic"
        ? "image"
        : ["node", "text", "hub"].includes(r)
          ? "caption"
          : null;
    case "tree":
      return ["node", "hub"].includes(r)
        ? depth === 0
          ? "topText"
          : "memberText"
        : null;
    case "pyramid":
      return ["node", "hub"].includes(r) ? "level" : null;
  }
  return null;
};
