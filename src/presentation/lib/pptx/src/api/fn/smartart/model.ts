// SmartArt authoring: the semantic model shared by the catalog, the layout
// code, the part writers and the reader.
//
// A diagram is edited as a flat outline (what a text pane shows): each item
// has text and an indent level. Layouts work on the tree that outline
// describes.

import type { SmartArtShapeFormat, SmartArtTextStyle } from "./format.ts";

/** One line of the outline: its text and indent level (0 = top level). */
export interface SmartArtItem {
  readonly text: string;
  readonly level: number;
  /** Formatting of the item's shapes, by shape name ("node", "pic",
   *  "child", "node:1" for a second shape of the same kind...). */
  readonly format?: Readonly<Record<string, SmartArtShapeFormat>>;
  /** WordArt formatting of the item's text. */
  readonly textStyle?: SmartArtTextStyle;
}

export interface SmartArtModel {
  /** A `SMARTART_LAYOUTS` id, or "" for a layout this engine does not author. */
  readonly layout: string;
  readonly items: ReadonlyArray<SmartArtItem>;
  /** A `SMARTART_COLOR_SCHEMES` id. */
  readonly colors: string;
  /** A `SMARTART_STYLES` id. */
  readonly style: string;
  readonly rightToLeft?: boolean;
  /** Formatting of shapes that stand for no item (arrows, backgrounds),
   *  by shape name ("trans:0", "bg:0"...). */
  readonly format?: Readonly<Record<string, SmartArtShapeFormat>>;
}

export interface SmartArtNode {
  readonly text: string;
  readonly children: SmartArtNode[];
  /** Index of the outline item this node came from. */
  readonly item: number;
  readonly format?: SmartArtItem["format"];
  readonly textStyle?: SmartArtItem["textStyle"];
}

/**
 * Builds the tree an outline describes. A line indented deeper than one level
 * below its predecessor attaches to the nearest shallower line, and leading
 * indented lines become top-level ones, so every outline has a tree.
 */
export const smartArtTree = (
  items: ReadonlyArray<SmartArtItem>,
): SmartArtNode[] => {
  const roots: SmartArtNode[] = [];
  const stack: { level: number; node: SmartArtNode }[] = [];
  items.forEach((item, index) => {
    const level = Math.max(0, Math.floor(Number(item.level) || 0));
    const node: SmartArtNode = {
      text: item.text,
      children: [],
      item: index,
      ...(item.format ? { format: item.format } : {}),
      ...(item.textStyle ? { textStyle: item.textStyle } : {}),
    };
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ level: parent ? level : 0, node });
  });
  return roots;
};

/** Flattens a tree back to the outline, normalizing levels. */
export const smartArtItems = (
  nodes: ReadonlyArray<SmartArtNode>,
  level = 0,
  out: SmartArtItem[] = [],
): SmartArtItem[] => {
  for (const node of nodes) {
    out.push({
      text: node.text,
      level,
      ...(node.format ? { format: node.format } : {}),
      ...(node.textStyle ? { textStyle: node.textStyle } : {}),
    });
    smartArtItems(node.children, level + 1, out);
  }
  return out;
};

/** Normalizes levels so the outline reads exactly as its tree. */
export const normalizeSmartArtItems = (
  items: ReadonlyArray<SmartArtItem>,
): SmartArtItem[] => smartArtItems(smartArtTree(items));

export const smartArtDepth = (nodes: ReadonlyArray<SmartArtNode>): number =>
  nodes.reduce(
    (max, node) => Math.max(max, 1 + smartArtDepth(node.children)),
    0,
  );

/** Every descendant's text, depth first, with its level below `node`. */
export const descendantLines = (
  node: SmartArtNode,
  level = 1,
  out: { text: string; level: number }[] = [],
): { text: string; level: number }[] => {
  for (const child of node.children) {
    out.push({ text: child.text, level });
    descendantLines(child, level + 1, out);
  }
  return out;
};

/** Converts a diagram to the outline a bulleted text box would hold. */
export const smartArtTextLines = (
  model: SmartArtModel,
): ReadonlyArray<SmartArtItem> => normalizeSmartArtItems(model.items);
