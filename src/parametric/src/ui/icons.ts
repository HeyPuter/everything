// Icon set. Generic glyphs come from Lucide; CAD-specific icons are original
// drawings in the same format (24px grid, 1.5px round strokes). Elements with
// class "a" are filled with the accent tint, "s" with a soft neutral fill.

import {
  ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronRight, ChevronLeft, ChevronUp, CircleHelp, Copy, Download, Eye,
  EyeOff, FileInput, FileOutput, FilePlus, FolderOpen, Keyboard, LogIn, LogOut, Menu, Monitor, Moon, MoreHorizontal,
  Palette, Pencil, Redo2, Save, Search, Settings, Share2, Sigma, Sun, Trash2, Undo2, Upload, X, Info, TriangleAlert,
  CircleX, Ruler, Weight, Lock, Unlock, ListTree, PanelLeft, PanelRight, Files, Plus, Minus, GripVertical, RotateCcw,
  Cloud, HardDrive, Pin, Scissors, MousePointer2, Hand, ZoomIn, ZoomOut, Rotate3d, Type, FileText, Users, Sparkles, ArrowUp, Square,
  SquarePen, Camera, Paperclip, Image as ImageIcon, ExternalLink,
} from 'lucide';

type IconNode = [string, Record<string, string | number>][];

const P = (d: string, cls?: string): [string, Record<string, string>] => (cls ? ['path', { d, class: cls }] : ['path', { d }]);
const C = (cx: number, cy: number, r: number, cls?: string): [string, Record<string, string | number>] => (cls ? ['circle', { cx, cy, r, class: cls }] : ['circle', { cx, cy, r }]);
const DOT = (cx: number, cy: number) => C(cx, cy, 1.4, 'f');
const DASH = (d: string, dash = '3 2'): [string, Record<string, string>] => ['path', { d, 'stroke-dasharray': dash }];

// Isometric cube used by view and display icons.
const CUBE_TOP = 'M12 3l8 4-8 4-8-4z';
const CUBE_LEFT = 'M4 7l8 4v10l-8-4z';
const CUBE_RIGHT = 'M20 7l-8 4v10l8-4z';

const CAD: Record<string, IconNode> = {
  sketch: [P('M2.5 18.5l5-4h14l-5 4z', 'a'), P('M14.5 3.5l2.5 2.5-7 7H7.5V10.5z'), P('M12.5 5.5l2.5 2.5')],
  smartDimension: [P('M4 6v12M20 6v12'), P('M4 12h16'), P('M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5'), P('M9.5 5.5h5', 'thin')],
  line: [P('M5 19L19 5'), DOT(5, 19), DOT(19, 5)],
  centerline: [DASH('M4 20L20 4', '5 2 1.5 2')],
  rectangle: [['rect', { x: 4, y: 6, width: 16, height: 12, rx: 0.5 }], DOT(4, 6), DOT(20, 18)],
  centerRectangle: [['rect', { x: 4, y: 6, width: 16, height: 12, rx: 0.5 }], DASH('M4 6l16 12M20 6L4 18', '2 2'), DOT(12, 12)],
  circle: [C(12, 12, 8), DOT(12, 12), DASH('M12 12h8', '2 2')],
  perimeterCircle: [C(12, 12, 8), DOT(5, 8), DOT(19, 8), DOT(12, 20)],
  arc3: [P('M4 17a9 9 0 0 1 16 0'), DOT(4, 17), DOT(20, 17), DOT(12, 8)],
  centerArc: [P('M18 16a7 7 0 1 0-12 0'), DOT(12, 14), DASH('M12 14L6 16M12 14l6 2', '2 2')],
  tangentArc: [P('M3 18h7'), P('M10 18a6 6 0 0 0 6-6V5'), DOT(10, 18)],
  polygon: [P('M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z'), DASH('M12 12V3.5', '2 2'), DOT(12, 12)],
  slot: [P('M8 7.5h8a4.5 4.5 0 0 1 0 9H8a4.5 4.5 0 0 1 0-9z'), DOT(8, 12), DOT(16, 12)],
  spline: [P('M3 17c3-10 6-10 9-5s6 5 9-5'), DOT(3, 17), DOT(12, 12), DOT(21, 7)],
  point: [C(12, 12, 2.5, 'f'), P('M12 4v4M12 16v4M4 12h4M16 12h4', 'thin')],
  sketchFillet: [P('M5 4v8a7 7 0 0 0 7 7h8'), DASH('M5 12v7h7', '2 2')],
  sketchChamfer: [P('M5 4v9l6 6h9'), DASH('M5 13v6h6', '2 2')],
  trim: [P('M4 12h7'), DASH('M11 12h9', '2 2'), P('M14 4v16'), P('M9 7l-2-2M9 17l-2 2', 'thin')],
  extend: [P('M3 12h10'), DASH('M13 12h5', '2 2'), P('M20 4v16'), P('M15 9.5l3 2.5-3 2.5')],
  offset: [P('M4 15c4-7 12-7 16 0'), DASH('M4 20c4-7 12-7 16 0', '2.5 2'), P('M12 10v4', 'thin')],
  mirrorEntities: [DASH('M12 3v18', '4 2 1 2'), P('M9 7L4 17h5z', 'a'), P('M15 7l5 10h-5z')],
  sketchPattern: [['rect', { x: 3, y: 9, width: 5, height: 6 }], ['rect', { x: 10, y: 9, width: 5, height: 6 }], DASH('M17 9h5v6h-5z', '2 1.5')],
  convertEntities: [P('M4 9l6-4h10l-6 4z', 's'), P('M4 9v8h10V9'), P('M14 9l6-4v8l-6 4'), P('M8 20l4 2 4-2', 'thin')],
  construction: [DASH('M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', '3 2.5')],
  relation: [P('M3 19h13M8 19V5'), P('M8 15h4v4', 'thin'), P('M17 6h4M19 4v4')],
  showRelations: [P('M4 19L15 6'), ['rect', { x: 14, y: 13, width: 6, height: 6, rx: 1 }], P('M16 16h2', 'thin')],
  extrude: [P('M5 12l7-3.5 7 3.5-7 3.5z', 'a'), P('M5 12v6l7 3.5 7-3.5v-6'), P('M12 15.5v6'), P('M12 2v7M9.5 4.5L12 2l2.5 2.5')],
  extrudeCut: [P('M4 9l8-4 8 4-8 4z', 's'), P('M4 9v8l8 4 8-4V9'), P('M12 13v8'), P('M9 9.5l3-1.5 3 1.5-3 1.5z', 'a'), P('M12 1v6M10 5l2 2 2-2')],
  revolve: [P('M7 5v14h4a4 4 0 0 0 0-8H7', 'a'), DASH('M4 3v18', '4 2 1 2'), P('M16 4.5a8.5 8.5 0 0 1 0 15'), P('M14 18l2 1.6-.4 2.4')],
  revolveCut: [P('M7 5h5v14H7z', 's'), P('M9 9h3v6H9z', 'a'), DASH('M4 3v18', '4 2 1 2'), P('M16 4.5a8.5 8.5 0 0 1 0 15'), P('M14 18l2 1.6-.4 2.4')],
  sweep: [P('M3 19c5 0 6-12 15-12', 'thick-a'), P('M3 19c5 0 6-12 15-12'), ['ellipse', { cx: 19, cy: 7, rx: 2, ry: 3.5 }], ['ellipse', { cx: 3.5, cy: 19, rx: 1.6, ry: 2.8, class: 'a' }]],
  loft: [P('M3 18l5-3h12l-5 3z', 'a'), ['ellipse', { cx: 13, cy: 6, rx: 4, ry: 1.8 }], P('M3 18L9 6M15 18l2-12M20 15l1-9'), DASH('M8 15l1-9', '2 2')],
  fillet: [P('M4 20V4h7a9 9 0 0 1 9 9v7z', 's'), P('M11 4a9 9 0 0 1 9 9', 'thick-a'), P('M4 20V4h7a9 9 0 0 1 9 9v7z')],
  chamfer: [P('M4 20V4h9l7 7v9z', 's'), P('M13 4l7 7', 'thick-a'), P('M4 20V4h9l7 7v9z')],
  shell: [P('M4 8l8-4 8 4-8 4z'), P('M7 8l5-2.5L17 8l-5 2.5z', 'a'), P('M4 8v9l8 4 8-4V8'), P('M12 12v9')],
  hole: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 1, class: 's' }], C(12, 12, 4.5, 'a'), C(12, 12, 4.5), DASH('M12 3v18', '3 1.5 1 1.5')],
  draft: [P('M8 4h8l4 16H4z', 's'), P('M8 4h8l4 16H4z'), DASH('M12 2v20', '3 1.5 1 1.5')],
  linearPattern: [['rect', { x: 2.5, y: 8, width: 5, height: 5, class: 'a' }], ['rect', { x: 9.5, y: 8, width: 5, height: 5 }], ['rect', { x: 16.5, y: 8, width: 5, height: 5 }], P('M3 18h17M18 16l2 2-2 2', 'thin')],
  circularPattern: [C(12, 4.5, 2, 'a'), C(18.5, 8.2, 2), C(18.5, 15.8, 2), C(12, 19.5, 2), C(5.5, 15.8, 2), C(5.5, 8.2, 2), DOT(12, 12)],
  mirror: [DASH('M12 2v20', '4 2 1 2'), P('M3 8l6-2v12l-6-2z', 'a'), P('M21 8l-6-2v12l6-2z')],
  plane: [P('M3 17l5-10h13l-5 10z', 'a'), P('M3 17l5-10h13l-5 10z')],
  axis: [DASH('M4 20L20 4', '5 2 1.5 2'), DOT(12, 12)],
  measure: [P('M3 15l12-12 6 6-12 12z'), P('M7 11l2 2M10 8l2 2M13 5l2 2', 'thin')],
  massProperties: [P('M6 8h12l2 12H4z', 'a'), C(12, 5, 2), P('M10 15h4', 'thin')],
  sectionView: [P(CUBE_TOP, 's'), P(CUBE_LEFT), P(CUBE_RIGHT), P('M2 12l10-5 10 5-10 5z', 'a')],
  zoomFit: [P('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'), ['rect', { x: 8, y: 8, width: 8, height: 8, class: 'a' }]],
  zoomArea: [C(10, 10, 6), P('M14.5 14.5L20 20'), DASH('M7 7h6v6H7z', '1.5 1.5')],
  previousView: [P('M9 7L4 12l5 5'), P('M4 12h10a6 6 0 0 1 0 12', 'thin'), ['rect', { x: 14, y: 4, width: 6, height: 5, rx: 1 }]],
  normalTo: [P('M3 17l5-8h13l-5 8z', 'a'), P('M12 13V3M9.5 5.5L12 3l2.5 2.5')],
  viewFront: [P(CUBE_TOP), P(CUBE_LEFT, 'a'), P(CUBE_RIGHT)],
  viewBack: [P(CUBE_TOP), DASH(CUBE_LEFT), P(CUBE_RIGHT), P(CUBE_LEFT, 'a2')],
  viewLeft: [P(CUBE_TOP), P(CUBE_LEFT), DASH(CUBE_RIGHT), P(CUBE_RIGHT, 'a2')],
  viewRight: [P(CUBE_TOP), P(CUBE_LEFT), P(CUBE_RIGHT, 'a')],
  viewTop: [P(CUBE_TOP, 'a'), P(CUBE_LEFT), P(CUBE_RIGHT)],
  viewBottom: [DASH(CUBE_TOP), P(CUBE_TOP, 'a2'), P(CUBE_LEFT), P(CUBE_RIGHT)],
  viewIso: [P(CUBE_TOP, 'a'), P(CUBE_LEFT, 'a2'), P(CUBE_RIGHT, 's')],
  viewOrientation: [P(CUBE_TOP), P(CUBE_LEFT), P(CUBE_RIGHT, 'a'), P('M17 20.5l3 1.5', 'thin')],
  shadedEdges: [P(CUBE_TOP, 'a'), P(CUBE_LEFT, 'a2'), P(CUBE_RIGHT, 's')],
  shaded: [P(CUBE_TOP, 'a nostroke'), P(CUBE_LEFT, 'a2 nostroke'), P(CUBE_RIGHT, 's nostroke')],
  hiddenRemoved: [P(CUBE_TOP), P(CUBE_LEFT), P(CUBE_RIGHT)],
  hiddenVisible: [P(CUBE_TOP), P(CUBE_LEFT), P(CUBE_RIGHT), DASH('M4 17l8-4 8 4M12 13V3', '1.5 1.5')],
  wireframe: [P(CUBE_TOP), P(CUBE_LEFT), P(CUBE_RIGHT), P('M4 17l8-4 8 4M12 13V3', 'thin')],
  perspective: [P('M3 6l18-3v18L3 18z'), P('M8 8.5l8-1.5v10l-8-1.5z', 'a')],
  rebuild: [P('M12 8l4 2v4l-4 2-4-2v-4z', 'a'), P('M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3'), P('M18 3v4h-4M6 21v-4h4')],
  origin: [P('M5 19V5M5 19h14'), P('M3 7l2-2 2 2M17 17l2 2-2 2'), DOT(5, 19)],
  material: [P('M4 8l8-4 8 4-8 4z', 'a'), P('M4 8v8l8 4 8-4V8M12 12v8'), P('M6 13.5l4 2M6 16.5l4 2M14 15.5l4-2M14 18.5l4-2', 'thin')],
  part: [P(CUBE_TOP, 'a'), P(CUBE_LEFT, 's'), P(CUBE_RIGHT)],
  sketchFeature: [P('M3 17l5-4h13l-5 4z', 's'), P('M7 15l4-6 4 4 3-5', 'thin')],
  rollback: [P('M3 12h18', 'thick'), P('M8 8l-4 4 4 4')],
  github: [P('M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.4 9.4 0 0 1 12 6.94c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.13 10.13 0 0 0 22 12.23C22 6.58 17.52 2 12 2z', 'f nostroke')],
  // The 3×3 dot grid of the Apps launcher.
  apps: [5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => C(x, y, 2, 'f'))),
};

// Relation glyphs shown next to sketch geometry (16px grid).
export const RELATION_GLYPHS: Record<string, IconNode> = {
  horizontal: [P('M2 8h12')],
  vertical: [P('M8 2v12')],
  coincident: [C(6, 8, 3), C(10, 8, 3)],
  parallel: [P('M4 13L9 3M8 13l5-10')],
  perpendicular: [P('M3 13h10M8 13V3')],
  tangent: [C(8, 9, 4.5), P('M2 4.5h12')],
  equal: [P('M3 6h10M3 10h10')],
  concentric: [C(8, 8, 5.5), C(8, 8, 2.2)],
  midpoint: [P('M2 8h12'), P('M8 4.5v7')],
  collinear: [P('M2 12l4-3M10 6l4-3')],
  fix: [P('M8 2v7M5 9h6l-1 3H6z'), P('M8 12v3')],
  symmetric: [DASH('M8 1v14', '2.5 1.5'), DOT(3.5, 8), DOT(12.5, 8)],
};

const LUCIDE: Record<string, IconNode> = {
  new: FilePlus as unknown as IconNode,
  open: FolderOpen as unknown as IconNode,
  save: Save as unknown as IconNode,
  undo: Undo2 as unknown as IconNode,
  redo: Redo2 as unknown as IconNode,
  settings: Settings as unknown as IconNode,
  search: Search as unknown as IconNode,
  close: X as unknown as IconNode,
  check: Check as unknown as IconNode,
  chevronDown: ChevronDown as unknown as IconNode,
  chevronRight: ChevronRight as unknown as IconNode,
  chevronLeft: ChevronLeft as unknown as IconNode,
  chevronUp: ChevronUp as unknown as IconNode,
  help: CircleHelp as unknown as IconNode,
  copy: Copy as unknown as IconNode,
  download: Download as unknown as IconNode,
  eye: Eye as unknown as IconNode,
  eyeOff: EyeOff as unknown as IconNode,
  import: FileInput as unknown as IconNode,
  export: FileOutput as unknown as IconNode,
  keyboard: Keyboard as unknown as IconNode,
  signIn: LogIn as unknown as IconNode,
  signOut: LogOut as unknown as IconNode,
  menu: Menu as unknown as IconNode,
  system: Monitor as unknown as IconNode,
  dark: Moon as unknown as IconNode,
  light: Sun as unknown as IconNode,
  more: MoreHorizontal as unknown as IconNode,
  appearance: Palette as unknown as IconNode,
  edit: Pencil as unknown as IconNode,
  share: Share2 as unknown as IconNode,
  equations: Sigma as unknown as IconNode,
  trash: Trash2 as unknown as IconNode,
  upload: Upload as unknown as IconNode,
  info: Info as unknown as IconNode,
  warning: TriangleAlert as unknown as IconNode,
  error: CircleX as unknown as IconNode,
  ruler: Ruler as unknown as IconNode,
  weight: Weight as unknown as IconNode,
  lock: Lock as unknown as IconNode,
  unlock: Unlock as unknown as IconNode,
  tree: ListTree as unknown as IconNode,
  panelLeft: PanelLeft as unknown as IconNode,
  panelRight: PanelRight as unknown as IconNode,
  files: Files as unknown as IconNode,
  plus: Plus as unknown as IconNode,
  minus: Minus as unknown as IconNode,
  grip: GripVertical as unknown as IconNode,
  reset: RotateCcw as unknown as IconNode,
  cloud: Cloud as unknown as IconNode,
  device: HardDrive as unknown as IconNode,
  users: Users as unknown as IconNode,
  pin: Pin as unknown as IconNode,
  scissors: Scissors as unknown as IconNode,
  select: MousePointer2 as unknown as IconNode,
  pan: Hand as unknown as IconNode,
  zoomIn: ZoomIn as unknown as IconNode,
  zoomOut: ZoomOut as unknown as IconNode,
  rotate: Rotate3d as unknown as IconNode,
  text: Type as unknown as IconNode,
  file: FileText as unknown as IconNode,
  upToLine: ArrowUpFromLine as unknown as IconNode,
  downToLine: ArrowDownToLine as unknown as IconNode,
  assistant: Sparkles as unknown as IconNode,
  send: ArrowUp as unknown as IconNode,
  stop: Square as unknown as IconNode,
  newChat: SquarePen as unknown as IconNode,
  camera: Camera as unknown as IconNode,
  attach: Paperclip as unknown as IconNode,
  image: ImageIcon as unknown as IconNode,
  external: ExternalLink as unknown as IconNode,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function build(nodes: IconNode, size: number, viewBox: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewBox} ${viewBox}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', viewBox === 16 ? '1.4' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const [tag, attrs] of nodes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

export type IconName = keyof typeof CAD | keyof typeof LUCIDE;

export function icon(name: string, size = 18): SVGSVGElement {
  // Constraint commands use the glyphs of their relation badges.
  if (name.startsWith('rel:')) return relationGlyph(name.slice(4), size);
  const nodes = CAD[name] ?? LUCIDE[name];
  if (!nodes) return build([], size, 24);
  return build(nodes, size, 24);
}

export function relationGlyph(type: string, size = 14): SVGSVGElement {
  return build(RELATION_GLYPHS[type] ?? [], size, 16);
}

export const hasIcon = (name: string) => name in CAD || name in LUCIDE || (name.startsWith('rel:') && name.slice(4) in RELATION_GLYPHS);
