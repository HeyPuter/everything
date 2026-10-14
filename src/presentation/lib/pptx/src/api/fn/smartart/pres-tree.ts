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
  readonly parent: Context | null;
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

  const docContext: Context = {
    id: docId,
    node: null,
    kind: "doc",
    siblings: [],
    index: 0,
    parent: null,
  };
  const nodeContext = (
    node: PresDataNode,
    siblings: ReadonlyArray<PresDataNode>,
    index: number,
    parent: Context,
  ): Context => ({ id: node.id, node, kind: "node", siblings, index, parent });
  const childrenOf = (ctx: Context): Context[] => {
    const list =
      ctx.kind === "doc"
        ? roots
        : ctx.kind === "node"
          ? (ctx.node?.children ?? [])
          : [];
    return list.map((n, i) => nodeContext(n, list, i, ctx));
  };
  const nodeOf = (ctx: Context): Context | null =>
    ctx.kind === "node" ? ctx : null;

  /** One step of an axis from a context, for one point type. */
  const step = (
    ctx: Context,
    axis: string,
    ptType: string,
    hideLast: boolean,
  ): Context[] => {
    const nodes = ptType === "node" || ptType === "all";
    switch (axis) {
      case "self":
        return [ctx];
      case "root":
        return [docContext];
      case "par":
        return ctx.parent ? [ctx.parent] : [];
      case "ch":
        return nodes ? childrenOf(ctx) : [];
      case "des": {
        if (!nodes) return [];
        const out: Context[] = [];
        const walk = (c: Context) =>
          childrenOf(c).forEach((k) => {
            out.push(k);
            walk(k);
          });
        walk(ctx);
        return out;
      }
      case "followSib": {
        const node = nodeOf(ctx);
        if (!node?.node) return [];
        if (ptType === "sibTrans") {
          const last = node.index >= node.siblings.length - 1;
          return last && hideLast
            ? []
            : [{ ...node, id: node.node.sibTrans, kind: "sibTrans" }];
        }
        return nodes
          ? node.siblings
              .slice(node.index + 1)
              .map((n, i) =>
                nodeContext(n, node.siblings, node.index + 1 + i, node.parent!),
              )
          : [];
      }
      case "precedSib": {
        const node = nodeOf(ctx);
        if (!node?.node) return [];
        if (ptType === "parTrans")
          return [{ ...node, id: node.node.parTrans, kind: "parTrans" }];
        return nodes
          ? node.siblings
              .slice(0, node.index)
              .map((n, i) => nodeContext(n, node.siblings, i, node.parent!))
          : [];
      }
    }
    return [];
  };
  /** An axis list ("ch ch") with its point types ("node node"); each
   *  result with the point its last step started from. */
  const alongFrom = (
    ctx: Context,
    axisAttr: string | null,
    ptAttr: string | null,
    hideLast = true,
  ): Array<readonly [Context, Context]> => {
    const axes = (axisAttr ?? "self").split(/\s+/).filter(Boolean);
    const types = (ptAttr ?? "all").split(/\s+/).filter(Boolean);
    let current: Array<readonly [Context, Context]> = [[ctx, ctx]];
    axes.forEach((axis, i) => {
      const type = types[Math.min(i, types.length - 1)] ?? "all";
      current = current.flatMap(([c]) =>
        step(c, axis, type, hideLast).map((r) => [r, c] as const),
      );
    });
    return current;
  };
  const along = (
    ctx: Context,
    axisAttr: string | null,
    ptAttr: string | null,
    hideLast = true,
  ): Context[] => alongFrom(ctx, axisAttr, ptAttr, hideLast).map(([c]) => c);
  const depthOf = (ctx: Context): number =>
    ctx.kind === "doc" ? 0 : ctx.node ? ctx.node.depth + 1 : 0;

  const holds = (cond: XmlElement, ctx: Context): boolean => {
    const set = alongFrom(ctx, att(cond, "axis"), att(cond, "ptType"));
    const func = att(cond, "func");
    // maxDepth counts levels below the point the axis's last step left.
    const value =
      func === "cnt"
        ? set.length
        : func === "maxDepth"
          ? Math.max(0, ...set.map(([p, from]) => depthOf(p) - depthOf(from)))
          : func === "depth" && att(cond, "axis") === "self"
            ? depthOf(ctx)
            : NaN;
    const target = Number(att(cond, "val"));
    switch (att(cond, "op")) {
      case "equ":
        return value === target;
      case "neq":
        return value !== target;
      case "gt":
        return value > target;
      case "lt":
        return value < target;
      case "gte":
        return value >= target;
      case "lte":
        return value <= target;
    }
    return false;
  };

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
    let contexts = along(
      ctx,
      att(body, "axis"),
      att(body, "ptType"),
      att(body, "hideLastTrans") !== "0" &&
        att(body, "hideLastTrans") !== "false",
    );
    const st = Number(att(body, "st") ?? 1) || 1;
    const stepBy = Math.max(1, Number(att(body, "step") ?? 1) || 1);
    const start = st < 0 ? Math.max(0, contexts.length + st) : st - 1;
    contexts = contexts.slice(start).filter((_, i) => i % stepBy === 0);
    const cnt = Number(att(body, "cnt") ?? 0);
    if (cnt > 0) contexts = contexts.slice(0, cnt);
    for (const c of contexts)
      for (const child of kids(body)) structural(child, c, parent);
  };

  const chooseBranch = (ch: XmlElement, ctx: Context, parent: PresPoint) => {
    for (const branch of kids(ch)) {
      if (local(branch) === "if" && !holds(branch, ctx)) continue;
      if (local(branch) !== "if" && local(branch) !== "else") continue;
      for (const child of kids(branch)) structural(child, ctx, parent);
      return;
    }
  };

  const structural = (e: XmlElement, ctx: Context, parent: PresPoint) => {
    if (local(e) === "layoutNode") layoutNode(e, ctx, parent);
    else if (local(e) === "forEach") forEach(e, ctx, parent);
    else if (local(e) === "choose") chooseBranch(e, ctx, parent);
  };

  layoutNode(rootNode, docContext, null);

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

/** Layout node names that draw each kind of an item's shape, per layout. */
const ROLE_NODES: Readonly<
  Record<string, Readonly<Partial<Record<Role, RegExp>>>>
> = {
  tiles: { node: /^node$/ },
  "banner-list": { node: /^head$/, text: /^body\d+$/ },
  "heading-columns": { node: /^head(ing)?$/, child: /^body$/ },
  "stacked-cards": { node: /^tab(Only)?$/, child: /^card$/ },
  "ruled-list": { text: /^head(Only)?$/ },
  "grouped-boxes": { bg: /^panel(Only)?$/, node: /^box$/ },
  "arrow-steps": { node: /^step$/ },
  chevrons: { node: /^(first|chevron)(Only)?$/, text: /^details$/ },
  "downward-flow": { node: /^step$/ },
  "rising-steps": { node: /^step\d+$/ },
  timeline: { node: /^dot$/, text: /^(above|below)$/ },
  "blocks-on-arrow": { node: /^block$/ },
  ring: { node: /^node$/ },
  "text-ring": { text: /^node$/ },
  "block-ring": { node: /^node$/ },
  wheel: { node: /^slice\d+_\d+$/ },
  "hub-spokes": { hub: /^(hub|center)$/, node: /^(satellite|around)$/ },
  "ring-track": { node: /^node$/ },
  "org-chart": { hub: /^topText$/, node: /^memberText$/ },
  "sideways-tree": { hub: /^topText$/, node: /^memberText$/ },
  "bubble-tree": { hub: /^topText$/, node: /^memberText$/ },
  "layered-blocks": { hub: /^top(Head|Leaf)$/, node: /^(head|leaf)$/ },
  venn: { venn: /^circle\d+_\d+$/ },
  "linked-circles": { venn: /^circle$/ },
  "nested-circles": { venn: /^ring\d+_\d+$/ },
  target: { node: /^ring\d+_\d+$/, text: /^label\d+_\d+$/ },
  "counter-arrows": { node: /^(forth|back)$/ },
  "converging-arrows": { hub: /^hub$/, node: /^(left|right)Arrow$/ },
  equation: { node: /^(term|only)$/, hub: /^result$/ },
  quadrants: { node: /^node$/ },
  "centered-quadrants": { hub: /^(hub|center)$/, node: /^(sub|quad)\d+_\d+$/ },
  "header-grid": { hub: /^head$/, child: /^cell$/ },
  petals: { node: /^petal(Alt)?$/ },
  pyramid: { node: /^level$/ },
  "inverted-pyramid": { node: /^level$/ },
  "pyramid-ledger": { node: /^bar$/ },
  "stepped-pyramid": { node: /^step\d+$/ },
  "captioned-pictures": { pic: /^image$/, text: /^caption$/ },
  "picture-tiles": { pic: /^image$/, node: /^caption$/ },
  "picture-bullets": { pic: /^image$/, node: /^bar$/ },
  "portrait-circles": { pic: /^image$/, text: /^caption$/ },
};

/**
 * Whether the layout node `name` of `layout`'s definition draws an item's
 * shape of `role` (null when the definition has no node of its own for it).
 */
export const layoutNodeForRole = (
  layout: string,
  role: string,
): ((name: string) => boolean) | null => {
  const pattern = ROLE_NODES[layout]?.[role as Role];
  return pattern ? (name) => pattern.test(name) : null;
};
