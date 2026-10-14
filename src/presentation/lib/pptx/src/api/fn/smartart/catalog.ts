// The SmartArt layouts this engine authors, by category.
import type { SmartArtItem } from "./model.ts";
import type { LayoutFn } from "./kit.ts";
import { FLOW_LAYOUTS } from "./layouts-flow.ts";
import { STRUCTURE_LAYOUTS } from "./layouts-structure.ts";

export type SmartArtCategory =
  | "list"
  | "process"
  | "cycle"
  | "hierarchy"
  | "relationship"
  | "matrix"
  | "pyramid"
  | "picture";

export const SMARTART_CATEGORIES: ReadonlyArray<{
  readonly id: SmartArtCategory;
  readonly label: string;
}> = [
  { id: "list", label: "List" },
  { id: "process", label: "Process" },
  { id: "cycle", label: "Cycle" },
  { id: "hierarchy", label: "Hierarchy" },
  { id: "relationship", label: "Relationship" },
  { id: "matrix", label: "Matrix" },
  { id: "pyramid", label: "Pyramid" },
  { id: "picture", label: "Picture" },
];

export interface SmartArtLayoutInfo {
  readonly id: string;
  readonly name: string;
  readonly category: SmartArtCategory;
  readonly description: string;
  /** Outline levels the layout shows as distinct shapes or text. */
  readonly levels: number;
  readonly sample: ReadonlyArray<SmartArtItem>;
  readonly picture?: boolean;
}

interface LayoutEntry extends SmartArtLayoutInfo {
  readonly fn: LayoutFn;
}

const T = "[Text]";
const flat = (n: number): SmartArtItem[] =>
  Array.from({ length: n }, () => ({ text: T, level: 0 }));
const nested = (n: number, kids: number): SmartArtItem[] =>
  Array.from({ length: n }, () => [
    { text: T, level: 0 },
    ...Array.from({ length: kids }, () => ({ text: T, level: 1 })),
  ]).flat();
const orgSample: SmartArtItem[] = [
  { text: T, level: 0 },
  { text: T, level: 1 },
  { text: T, level: 2 },
  { text: T, level: 2 },
  { text: T, level: 1 },
  { text: T, level: 1 },
  { text: T, level: 2 },
];

const fns: Record<string, LayoutFn> = { ...FLOW_LAYOUTS, ...STRUCTURE_LAYOUTS };

const entries: Array<Omit<LayoutEntry, "fn">> = [
  // Lists
  {
    id: "tiles",
    name: "Tile Grid",
    category: "list",
    description:
      "Equal tiles that wrap into rows. Good for a set of peers with no order; sub-points appear inside each tile.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "banner-list",
    name: "Banner List",
    category: "list",
    description:
      "Full-width banners stacked top to bottom, each followed by its own sub-points. Suits topics with detail.",
    levels: 2,
    sample: nested(3, 1),
  },
  {
    id: "heading-columns",
    name: "Heading Columns",
    category: "list",
    description:
      "Side-by-side columns, each with a colored heading over a panel of sub-points.",
    levels: 2,
    sample: nested(3, 2),
  },
  {
    id: "stacked-cards",
    name: "Stacked Cards",
    category: "list",
    description:
      "Rows with a colored tab for each heading and a light card for its sub-points.",
    levels: 2,
    sample: nested(3, 2),
  },
  {
    id: "ruled-list",
    name: "Ruled List",
    category: "list",
    description:
      "Text separated by thin rules, headings on the left and details on the right. Light and text-focused.",
    levels: 2,
    sample: nested(3, 2),
  },
  {
    id: "grouped-boxes",
    name: "Grouped Boxes",
    category: "list",
    description:
      "Light panels that each gather a group of boxes under a shared heading.",
    levels: 3,
    sample: nested(3, 2),
  },
  // Processes
  {
    id: "arrow-steps",
    name: "Arrow Steps",
    category: "process",
    description:
      "Steps from left to right joined by arrows. Shows a sequence or the stages of a task.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "chevrons",
    name: "Chevron Flow",
    category: "process",
    description:
      "Interlocking chevrons for stages that lead into each other, with details beneath each one.",
    levels: 2,
    sample: flat(4),
  },
  {
    id: "downward-flow",
    name: "Downward Flow",
    category: "process",
    description: "Steps from top to bottom joined by downward arrows.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "rising-steps",
    name: "Rising Steps",
    category: "process",
    description:
      "Blocks that climb from left to right. Shows progress or growth through stages.",
    levels: 2,
    sample: flat(4),
  },
  {
    id: "timeline",
    name: "Timeline",
    category: "process",
    description:
      "Markers along an arrow with labels alternating above and below. Use it for dates or milestones.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "blocks-on-arrow",
    name: "Blocks on an Arrow",
    category: "process",
    description:
      "Steps set on one broad arrow, for stages that move toward a goal.",
    levels: 2,
    sample: flat(3),
  },
  // Cycles
  {
    id: "ring",
    name: "Ring",
    category: "cycle",
    description:
      "Circles around a ring joined by arrows. Shows stages that repeat.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "text-ring",
    name: "Text Ring",
    category: "cycle",
    description:
      "Text arranged in a circle with arrows between items. Keeps the focus on the words.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "block-ring",
    name: "Block Ring",
    category: "cycle",
    description:
      "Rounded blocks around a ring with arrows, for cycles with longer labels.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "wheel",
    name: "Segmented Wheel",
    category: "cycle",
    description:
      "A circle cut into equal slices. Shows parts of a whole or a repeating cycle.",
    levels: 2,
    sample: flat(4),
  },
  {
    id: "hub-spokes",
    name: "Hub and Spokes",
    category: "cycle",
    description:
      "A central idea joined to the items around it. The first item is the hub.",
    levels: 2,
    sample: [
      { text: T, level: 0 },
      ...flat(4).map((i) => ({ ...i, level: 1 })),
    ],
  },
  {
    id: "ring-track",
    name: "Ring Track",
    category: "cycle",
    description:
      "Labels riding on a continuous ring, for a loop without a start or end.",
    levels: 2,
    sample: flat(5),
  },
  // Hierarchies
  {
    id: "org-chart",
    name: "Org Chart",
    category: "hierarchy",
    description:
      "A top-down tree with connecting lines. Shows reporting lines or any parent and child structure.",
    levels: 6,
    sample: orgSample,
  },
  {
    id: "sideways-tree",
    name: "Sideways Tree",
    category: "hierarchy",
    description:
      "A tree that grows from left to right, suited to decisions and breakdowns.",
    levels: 6,
    sample: orgSample,
  },
  {
    id: "bubble-tree",
    name: "Bubble Tree",
    category: "hierarchy",
    description:
      "Circles linked from the top down. A softer take on a hierarchy.",
    levels: 6,
    sample: orgSample,
  },
  {
    id: "layered-blocks",
    name: "Layered Blocks",
    category: "hierarchy",
    description: "Each item spans the items below it, like a layered table.",
    levels: 6,
    sample: orgSample,
  },
  // Relationships
  {
    id: "venn",
    name: "Venn",
    category: "relationship",
    description:
      "Overlapping circles that show where ideas share common ground.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "linked-circles",
    name: "Linked Circles",
    category: "relationship",
    description:
      "A row of overlapping circles for ideas that connect one to the next.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "nested-circles",
    name: "Nested Circles",
    category: "relationship",
    description:
      "Circles inside one another, for ideas that contain or build on each other.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "target",
    name: "Target",
    category: "relationship",
    description:
      "Concentric rings with a label for each, from the outside in. Shows focus or containment.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "counter-arrows",
    name: "Counter Arrows",
    category: "relationship",
    description:
      "Arrows that alternate direction, for opposing forces or a back and forth.",
    levels: 2,
    sample: flat(2),
  },
  {
    id: "converging-arrows",
    name: "Converging Arrows",
    category: "relationship",
    description:
      "Arrows from both sides pointing at a central idea. The first item is the center.",
    levels: 2,
    sample: flat(5),
  },
  {
    id: "equation",
    name: "Equation",
    category: "relationship",
    description:
      "Parts that add up to a result, joined by plus and equals signs.",
    levels: 2,
    sample: flat(3),
  },
  // Matrices
  {
    id: "quadrants",
    name: "Quadrants",
    category: "matrix",
    description: "Four equal squares, for comparing items in a grid.",
    levels: 2,
    sample: flat(4),
  },
  {
    id: "centered-quadrants",
    name: "Centered Quadrants",
    category: "matrix",
    description:
      "Four quadrants around a central label. The first item sits in the center; its sub-points fill the quadrants.",
    levels: 2,
    sample: [
      { text: T, level: 0 },
      ...flat(4).map((i) => ({ ...i, level: 1 })),
    ],
  },
  {
    id: "header-grid",
    name: "Header Grid",
    category: "matrix",
    description: "Column headings with cells beneath, like a simple table.",
    levels: 2,
    sample: nested(3, 2),
  },
  {
    id: "petals",
    name: "Petals",
    category: "matrix",
    description:
      "Leaf-shaped quarters that face one another. A friendlier grid.",
    levels: 2,
    sample: flat(4),
  },
  // Pyramids
  {
    id: "pyramid",
    name: "Pyramid",
    category: "pyramid",
    description:
      "Levels that widen toward the base. Shows foundations or proportions.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "inverted-pyramid",
    name: "Inverted Pyramid",
    category: "pyramid",
    description:
      "Levels that narrow toward the bottom, for filtering or narrowing down.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "pyramid-ledger",
    name: "Pyramid Ledger",
    category: "pyramid",
    description:
      "A pyramid backdrop with a labeled bar for each level beside it.",
    levels: 2,
    sample: flat(3),
  },
  {
    id: "stepped-pyramid",
    name: "Stepped Pyramid",
    category: "pyramid",
    description: "Stacked blocks that grow wider downward, like terraces.",
    levels: 2,
    sample: flat(4),
  },
  // Pictures
  {
    id: "captioned-pictures",
    name: "Captioned Pictures",
    category: "picture",
    description: "Pictures side by side with a caption under each.",
    levels: 2,
    sample: flat(3),
    picture: true,
  },
  {
    id: "picture-tiles",
    name: "Picture Tiles",
    category: "picture",
    description:
      "A grid of pictures, each with a caption band across its foot.",
    levels: 2,
    sample: flat(4),
    picture: true,
  },
  {
    id: "picture-bullets",
    name: "Picture Bullets",
    category: "picture",
    description: "A list where each item leads with a round picture.",
    levels: 2,
    sample: flat(3),
    picture: true,
  },
  {
    id: "portrait-circles",
    name: "Portrait Circles",
    category: "picture",
    description:
      "Round portraits in a row with names beneath. Suits introducing people.",
    levels: 2,
    sample: flat(3),
    picture: true,
  },
];

const LAYOUTS: LayoutEntry[] = entries.map((entry) => {
  const fn = fns[entry.id];
  if (!fn) throw new Error(`SmartArt layout ${entry.id} has no layout code`);
  return { ...entry, fn };
});

export const SMARTART_LAYOUTS: ReadonlyArray<SmartArtLayoutInfo> = LAYOUTS.map(
  ({ fn: _fn, ...info }) => info,
);

export const layoutEntry = (id: string): LayoutEntry | null =>
  LAYOUTS.find((l) => l.id === id) ?? null;

export const DEFAULT_SMARTART_LAYOUT = "tiles";
