// Node system types shared by every node tree kind (shader, world, geometry, compositor).
import type { Child } from '../ui/h';
import type { DocumentData, NodeData, NodeTreeData, SocketValue } from '../data/types';

export type TreeType = NodeTreeData['type'];

/** Socket data types (`bpy` names, with FLOAT for 'VALUE'). */
export type SocketType =
  | 'FLOAT'
  | 'INT'
  | 'BOOLEAN'
  | 'VECTOR'
  | 'RGBA'
  | 'SHADER'
  | 'STRING'
  | 'ROTATION'
  | 'MATRIX'
  | 'MENU'
  | 'GEOMETRY'
  | 'OBJECT'
  | 'COLLECTION'
  | 'IMAGE'
  | 'MATERIAL'
  | 'TEXTURE'
  | 'FONT'
  | 'SOUND'
  | 'CLOSURE'
  | 'BUNDLE'
  | 'CUSTOM';

/** Socket subtypes affecting the value widget (unit display, slider). */
export type SocketSubtype =
  | 'NONE'
  | 'FACTOR'
  | 'ANGLE'
  | 'DISTANCE'
  | 'PERCENTAGE'
  | 'WAVELENGTH'
  | 'EULER'
  | 'XYZ'
  | 'TRANSLATION'
  | 'DIRECTION'
  | 'TIME'
  | 'TEMPERATURE'
  | 'COLOR_TEMPERATURE'
  | 'FREQUENCY'
  | 'PIXEL'
  | string;

export interface SocketDef {
  name: string;
  identifier: string;
  type: SocketType;
  default?: SocketValue;
  min?: number;
  max?: number;
  subtype?: SocketSubtype;
  /** draw only the label (no value widget) when unlinked */
  hide_value?: boolean;
  /** unavailable unless the node's `available` callback enables it */
  disabled?: boolean;
  /** label shown instead of `name` (e.g. inside a panel) */
  shortLabel?: string;
  /** accepts several links (geometry join etc.) */
  multiInput?: boolean;
  /** geometry nodes: field/single value display hint */
  shape?: 'CIRCLE' | 'DIAMOND' | 'DIAMOND_DOT' | 'SQUARE';
  /** MENU sockets: item identifiers (also used as labels) */
  items?: string[];
  /** VECTOR sockets: number of components shown (default 3) */
  dimensions?: number;
  /** tooltip text (group interface sockets) */
  description?: string;
}

export type NodePropType =
  | 'ENUM'
  | 'BOOLEAN'
  | 'INT'
  | 'FLOAT'
  | 'STRING'
  | 'COLOR'
  | 'VECTOR'
  | 'DIRECTION'
  | 'IMAGE'
  | 'OBJECT'
  | 'COLLECTION'
  | 'MATERIAL'
  | 'NODE_TREE'
  | 'TEXT'
  | 'ATTRIBUTE'
  | 'UV_MAP'
  | 'COLOR_ATTRIBUTE';

export interface NodePropDef {
  id: string;
  name: string;
  type: NodePropType;
  items?: [string, string][];
  d?: SocketValue;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  sub?: string;
  /** shown in the node body (default true for enums/booleans); false = only in sidebar Options */
  inNode?: boolean;
  /** draw an enum as a radio row instead of a dropdown */
  expand?: boolean;
  /** hide the label in the node body */
  noLabel?: boolean;
  /** only drawn when the predicate holds */
  visible?: (node: NodeData) => boolean;
  /** enum items that depend on the tree the node is in (defaults to `items`) */
  itemsFor?: (tree?: NodeTreeData) => [string, string][] | undefined;
}

/** A collapsible panel of sockets/props inside a node (e.g. Principled BSDF ▸ Subsurface). */
export interface NodePanelDef {
  name: string;
  /** socket identifiers (inputs) in display order */
  inputs: string[];
  /** props drawn at the top of the panel */
  props?: string[];
  closed?: boolean;
}

/** Context passed to dynamic socket resolvers (group nodes need the document). */
export interface SocketContext {
  doc: DocumentData;
  tree: NodeTreeData;
}

export interface ResolvedSocket extends SocketDef {
  /** displayed label */
  label: string;
}

export interface NodeDrawContext {
  node: NodeData;
  tree: NodeTreeData;
  /** call after modifying node data (pushes undo when final) */
  changed: (label: string, final?: boolean) => void;
  /** where the UI is drawn (affects compactness) */
  where: 'node' | 'sidebar' | 'properties';
  /** unique key prefix for widget ids */
  key: string;
}

export interface NodeTypeDef {
  idname: string;
  label: string;
  /** header color class (theme) */
  category: NodeClass;
  treeTypes: TreeType[];
  inputs: SocketDef[];
  outputs: SocketDef[];
  props: NodePropDef[];
  panels?: NodePanelDef[];
  width: number;
  minWidth?: number;
  maxWidth?: number;
  /** dynamic socket availability */
  available?: (node: NodeData, socket: SocketDef, isOutput: boolean) => boolean;
  /** dynamic socket label */
  socketLabel?: (node: NodeData, socket: SocketDef, isOutput: boolean) => string | undefined;
  /** dynamic node label shown in the header (e.g. the Math operation) */
  dynamicLabel?: (node: NodeData) => string;
  /** fully dynamic sockets (group nodes, group input/output) */
  dynamicSockets?: (node: NodeData, ctx: SocketContext) => { inputs: SocketDef[]; outputs: SocketDef[]; panels?: NodePanelDef[] };
  /** initialize props of a newly created node */
  init?: (node: NodeData) => void;
  /** after the node is added interactively: add companion nodes (zone outputs) and return them */
  onAdd?: (tree: NodeTreeData, node: NodeData) => NodeData[];
  /** custom body UI (color ramps, curves, image selector) drawn after props */
  drawBody?: (ctx: NodeDrawContext) => Child;
  /** extra height for custom body UI in node units */
  bodyHeight?: (node: NodeData) => number;
  /** custom sidebar UI (Options tab) */
  drawOptions?: (ctx: NodeDrawContext) => Child;
  /** not listed in the Add menu (legacy or internal nodes) */
  hidden?: boolean;
  /** layout-only node (Frame, Reroute) */
  layout?: 'FRAME' | 'REROUTE';
  /** short description for tooltips / search */
  description?: string;
  /** search aliases */
  aliases?: string[];
}

export type NodeClass =
  'input' | 'output' | 'shader' | 'texture' | 'color' | 'vector' | 'converter' | 'group' | 'layout' | 'geometry' | 'attribute' | 'distort' | 'matte' | 'filter' | 'script' | 'interface' | 'pattern';

/** Raw interface data (generated node interface tables). */
export type RawSocket = [
  name: string,
  identifier: string,
  type: string,
  opts?: {
    d?: SocketValue;
    min?: number;
    max?: number;
    sub?: string;
    hv?: boolean;
    off?: boolean;
  },
];
export interface RawNodeData {
  label: string;
  width: number;
  inputs: RawSocket[];
  outputs: RawSocket[];
  props:
    | NodePropDef[]
    | {
        id: string;
        name: string;
        type: string;
        items?: [string, string][];
        d?: SocketValue;
        min?: number;
        max?: number;
        softMin?: number;
        softMax?: number;
        sub?: string;
      }[];
}

/** Add-menu entry. */
export interface MenuEntry {
  idname: string;
  label?: string;
  /** props set on the new node */
  settings?: Record<string, SocketValue>;
}
export interface MenuCategory {
  label: string;
  /** entries, nested categories or separators */
  items: (MenuEntry | MenuCategory | 'SEPARATOR')[];
  /** only shown for these trees (e.g. object vs world shader) */
  poll?: (ctx: { treeType: TreeType; shaderType?: 'OBJECT' | 'WORLD' }) => boolean;
  /** top-level categories: draw a separator above this one in the Add menu */
  separatorBefore?: boolean;
}
