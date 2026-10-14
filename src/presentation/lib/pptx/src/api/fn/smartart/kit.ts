// Shared vocabulary for SmartArt layout code: the abstract shapes a layout
// produces (later written as the saved drawing, a preview, or ordinary
// shapes), paragraph helpers, and text fitting.
import { parsePresetGeometry } from "../../../internal/drawingml/preset-geometry.ts";
import {
  NS,
  attr,
  elem,
  qname,
  type XmlElement,
} from "../../../internal/xml/index.ts";
import type { Role } from "./paint.ts";
import type { SmartArtShapeFormat, SmartArtTextStyle } from "./format.ts";
import { descendantLines, type SmartArtNode } from "./model.ts";

export interface Para {
  readonly text: string;
  /** Outline level inside the shape: 0 is the shape's own heading. */
  readonly level: number;
  readonly bullet: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One shape of a laid-out diagram, in frame-local EMU. */
export interface ArtShape extends Rect {
  readonly geom: string;
  /** Preset adjustments, by guide name (`adj`, `adj1`, ...). */
  readonly adj?: Readonly<Record<string, number>>;
  /** Clockwise rotation in degrees. */
  readonly rot?: number;
  readonly flipH?: boolean;
  readonly flipV?: boolean;
  readonly role: Role;
  /** Position in the palette sequence, and its length. */
  readonly index: number;
  readonly count: number;
  readonly paras?: ReadonlyArray<Para>;
  readonly anchor?: "t" | "ctr" | "b";
  readonly align?: "l" | "ctr" | "r";
  /** Text rectangle (frame-local, before rotation) when not the geometry's. */
  readonly textBox?: Rect;
  /** Shapes in one group share a font size. Defaults to the role. */
  readonly group?: string;
  /** Largest font size, in points. */
  readonly maxPt?: number;
  /** Polylines (shape-local EMU) for `geom: "custom"`. */
  readonly path?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Custom paths are filled polygons rather than strokes. */
  readonly closed?: boolean;
  /** The outline item the shape stands for, if any. */
  readonly item?: number;
  /** Font size chosen by fitting, in points. */
  pt?: number;
  /** Names the shape for its formatting: "3/pic" (item 3's picture shape)
   *  or "trans:0" (the first arrow that stands for no item). */
  key?: string;
  /** Formatting given to this shape (see format.ts). */
  format?: SmartArtShapeFormat;
  /** Formatting given to the text of the item the shape shows. */
  textStyle?: SmartArtTextStyle;
}

export interface LayoutContext {
  readonly w: number;
  readonly h: number;
  readonly nodes: ReadonlyArray<SmartArtNode>;
}

export type LayoutFn = (ctx: LayoutContext) => ArtShape[];

/** A node's own text, then its descendants as bullets. */
export const nodeParas = (node: SmartArtNode, withChildren = true): Para[] => [
  { text: node.text, level: 0, bullet: false },
  ...(withChildren
    ? descendantLines(node).map((l) => ({
        text: l.text,
        level: l.level,
        bullet: true,
      }))
    : []),
];
/** A node's descendants alone, as bullets starting at level 0. */
export const childParas = (node: SmartArtNode): Para[] =>
  descendantLines(node).map((l) => ({
    text: l.text,
    level: l.level - 1,
    bullet: true,
  }));
export const textParas = (text: string): Para[] => [
  { text, level: 0, bullet: false },
];

export const PT = 12700;
const CHAR = 0.56; // average glyph advance, in ems (generous: wide faces)
const LINE = 1.12; // line height, in ems
export const INSET_RATIO = 0.06;

/** The text rectangle a geometry offers (shape-local EMU). */
export const geometryTextRect = (shape: ArtShape): Rect => {
  if (shape.textBox)
    return {
      x: shape.textBox.x - shape.x,
      y: shape.textBox.y - shape.y,
      w: shape.textBox.w,
      h: shape.textBox.h,
    };
  if (shape.geom === "custom") return { x: 0, y: 0, w: shape.w, h: shape.h };
  const geometry = parsePresetGeometry(
    shape.geom,
    shape.w,
    shape.h,
    adjustmentList(shape.adj),
  );
  const r = geometry?.textRect;
  if (!r) return { x: 0, y: 0, w: shape.w, h: shape.h };
  return {
    x: r.l,
    y: r.t,
    w: Math.max(0, r.r - r.l),
    h: Math.max(0, r.b - r.t),
  };
};

export const adjustmentList = (
  adj: Readonly<Record<string, number>> | undefined,
): XmlElement | null =>
  adj
    ? elem(qname("a", "avLst", NS.dml), {
        children: Object.entries(adj).map(([name, v]) =>
          elem(qname("a", "gd", NS.dml), {
            attrs: [
              attr(qname("", "name", ""), name),
              attr(qname("", "fmla", ""), `val ${Math.round(v)}`),
            ],
          }),
        ),
      })
    : null;

export const insetOf = (shape: ArtShape): number => {
  const r = geometryTextRect(shape);
  return Math.round(
    Math.min(91440, Math.max(12700, Math.min(r.w, r.h) * INSET_RATIO)),
  );
};

/** Lines a paragraph needs at `pt` in `width` EMU; Infinity if a word cannot fit. */
const linesFor = (text: string, pt: number, width: number): number => {
  const em = pt * PT;
  const advance = em * CHAR;
  if (width <= advance) return Infinity;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1,
    used = 0;
  for (const word of words) {
    const w = word.length * advance;
    // A word must fit with room to spare: a renderer breaks it otherwise.
    if (w * 1.12 > width) return Infinity;
    const next = used === 0 ? w : used + advance + w;
    if (next > width) {
      lines++;
      used = w;
    } else used = next;
  }
  return lines;
};

/** Text with sub-points starts at the top left, as layout engines set it;
 *  other text is centered unless the layout says otherwise. */
export const textAnchorOf = (shape: ArtShape): "t" | "ctr" | "b" =>
  shape.anchor ?? (shape.paras?.some((p) => p.bullet) ? "t" : "ctr");
export const headingAlignOf = (shape: ArtShape): "l" | "ctr" | "r" =>
  shape.align ?? (shape.paras?.some((p) => p.bullet) ? "l" : "ctr");

export const CHILD_SCALE = 0.78;
export const paraPt = (para: Para, pt: number, shape: ArtShape): number =>
  para.level > 0 || (para.bullet && shape.paras?.[0]?.bullet === false)
    ? pt * CHILD_SCALE
    : pt;
const BULLET_INDENT = 0.9; // ems

const fits = (shape: ArtShape, pt: number): boolean => {
  const paras = shape.paras ?? [];
  if (!paras.length) return true;
  const rect = geometryTextRect(shape);
  const inset = insetOf(shape);
  const width = rect.w - 2 * inset;
  const height = rect.h - 2 * inset;
  if (width <= 0 || height <= 0) return false;
  let total = 0;
  for (const para of paras) {
    const size = paraPt(para, pt, shape);
    const indent = para.bullet
      ? (para.level + 1) * BULLET_INDENT * size * PT
      : 0;
    const lines = linesFor(para.text, size, width - indent);
    if (!Number.isFinite(lines)) return false;
    total += lines * size * PT * LINE;
  }
  return total <= height;
};

/**
 * Picks one font size per group: the largest (up to each shape's maximum)
 * at which every shape of the group fits, in half points, never below 5pt.
 */
export const fitText = (shapes: ArtShape[], scale = 1): void => {
  const groups = new Map<string, ArtShape[]>();
  for (const shape of shapes) {
    if (!shape.paras?.length) continue;
    const key = shape.group ?? shape.role;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(shape);
  }
  for (const list of groups.values()) {
    const max = Math.max(...list.map((s) => (s.maxPt ?? 28) * scale));
    let pt = Math.max(5, Math.floor(max * 2) / 2);
    while (
      pt > 5 &&
      !list.every((s) => fits(s, Math.min(pt, (s.maxPt ?? 28) * scale)))
    )
      pt -= 0.5;
    for (const s of list) s.pt = Math.min(pt, (s.maxPt ?? 28) * scale);
  }
};

/** Mirrors a laid-out diagram left to right. */
export const mirror = (shapes: ArtShape[], width: number): ArtShape[] =>
  shapes.map((s) => ({
    ...s,
    x: width - s.x - s.w,
    ...(s.textBox
      ? { textBox: { ...s.textBox, x: width - s.textBox.x - s.textBox.w } }
      : {}),
    ...(s.rot ? { rot: -s.rot } : {}),
    ...(s.geom === "custom" && s.path
      ? {
          path: s.path.map((line) =>
            line.map(([x, y]) => [s.w - x, y] as const),
          ),
        }
      : s.geom === "pie" && s.adj
        ? {
            // Mirror the slice's angles; flipping would mirror its text.
            adj: {
              adj1: mirrorAngle(s.adj["adj2"] ?? 0),
              adj2: mirrorAngle(s.adj["adj1"] ?? 0),
            },
          }
        : MIRRORED.has(s.geom)
          ? { flipH: !s.flipH }
          : {}),
    ...(s.align === "l"
      ? { align: "r" as const }
      : s.align === "r"
        ? { align: "l" as const }
        : {}),
  }));
const mirrorAngle = (a: number) =>
  (((10800000 - a) % 21600000) + 21600000) % 21600000;
const MIRRORED = new Set([
  "rightArrow",
  "leftArrow",
  "chevron",
  "homePlate",
  "circularArrow",
  "curvedRightArrow",
  "curvedLeftArrow",
  "round2DiagRect",
  "snip1Rect",
]);

// Geometry helpers.
export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
/** Splits `length` into `n` cells separated by gaps of `gapRatio` × cell. */
export const cells = (length: number, n: number, gapRatio: number) => {
  const cell = length / (n + (n - 1) * gapRatio);
  return {
    cell,
    gap: cell * gapRatio,
    at: (i: number) => i * cell * (1 + gapRatio),
  };
};
/** A centered rectangle of aspect `ratio` (w/h) fitting inside `w`×`h`. */
export const fitAspect = (w: number, h: number, ratio: number) =>
  w / h > ratio ? { w: h * ratio, h } : { w, h: w / ratio };
/** Grid dimensions for `n` cells of aspect `ratio` filling `w`×`h` best. */
export const gridFor = (n: number, w: number, h: number, ratio: number) => {
  let best = { cols: 1, rows: n, size: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    // Gaps are a tenth of a cell's width, across and down.
    const cw = w / (cols + (cols - 1) * 0.1);
    const size = Math.min(cw, h / (rows / ratio + (rows - 1) * 0.1));
    // On a tie, more columns (as the snake algorithm settles it).
    if (size >= best.size - 1e-6) best = { cols, rows, size };
  }
  return best;
};
