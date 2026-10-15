// Data-driven node type registry shared by all node tree kinds.
//
//   registerNodeType(def)                     – add a node type
//   nodeTypes[idname]                         – lookup (aliases resolved by getNodeType)
//   nodeSockets(node, ctx)                    – available sockets of a node instance
//   registerNodeMenu(treeTypes, categories)   – Add-menu layout per tree type
//
// Shader nodes register in shader/defs.ts; Geometry Nodes and Compositor nodes can use the same
// registry (set `treeTypes`), editor and tree utilities.
import type { DocumentData, NodeData, NodeTreeData, SocketValue } from '../data/types';
import type { MenuCategory, NodePanelDef, NodePropDef, NodeTypeDef, RawNodeData, RawSocket, ResolvedSocket, SocketContext, SocketDef, SocketType, TreeType, NodeClass } from './types';

export const nodeTypes: Record<string, NodeTypeDef> = {};
const aliases: Record<string, string> = {};

export function registerNodeType(def: NodeTypeDef) {
  nodeTypes[def.idname] = def;
}

/** Register an alternative idname (legacy or renamed node types). */
export function registerNodeAlias(alias: string, idname: string) {
  aliases[alias] = idname;
}

export function getNodeType(idname: string): NodeTypeDef | undefined {
  return nodeTypes[idname] ?? nodeTypes[aliases[idname]];
}

export function canonicalIdname(idname: string) {
  return nodeTypes[idname] ? idname : (aliases[idname] ?? idname);
}

const RAW_TYPE: Record<string, SocketType> = {
  VALUE: 'FLOAT',
  FLOAT: 'FLOAT',
  INT: 'INT',
  BOOLEAN: 'BOOLEAN',
  VECTOR: 'VECTOR',
  RGBA: 'RGBA',
  SHADER: 'SHADER',
  STRING: 'STRING',
  ROTATION: 'ROTATION',
  MATRIX: 'MATRIX',
  MENU: 'MENU',
};

export function socketFromRaw(r: RawSocket): SocketDef {
  const [name, identifier, type, o] = r;
  const s: SocketDef = {
    name,
    identifier,
    type: RAW_TYPE[type] ?? (type as SocketType),
  };
  if (o) {
    if (o.d !== undefined) s.default = o.d;
    if (o.min !== undefined) s.min = o.min;
    if (o.max !== undefined) s.max = o.max;
    if (o.sub) s.subtype = o.sub;
    if (o.hv) s.hide_value = true;
    if (o.off) s.disabled = true;
  }
  return s;
}

/** Build a node type from generated interface data plus behaviour. */
export function defineFromRaw(idname: string, raw: RawNodeData, extra: Partial<NodeTypeDef> & { category: NodeClass; treeTypes: TreeType[] }): NodeTypeDef {
  const def: NodeTypeDef = {
    idname,
    label: raw.label,
    width: raw.width,
    inputs: raw.inputs.map(socketFromRaw),
    outputs: raw.outputs.map(socketFromRaw),
    props: (raw.props as NodePropDef[]).map((p) => ({ ...p })),
    ...extra,
  };
  registerNodeType(def);
  return def;
}

// ---------------------------------------------------------------------------
// Socket resolution

export function defaultForType(type: SocketType): SocketValue {
  switch (type) {
    case 'FLOAT':
    case 'INT':
      return 0;
    case 'BOOLEAN':
      return false;
    case 'VECTOR':
    case 'ROTATION':
      return [0, 0, 0];
    case 'RGBA':
      return [0.8, 0.8, 0.8, 1];
    case 'STRING':
      return '';
    default:
      return null;
  }
}

export function socketDefault(s: SocketDef): SocketValue {
  const d = s.default ?? defaultForType(s.type);
  return Array.isArray(d) ? [...d] : d;
}

/** Map an interface socket_type (e.g. 'NodeSocketFloatFactor') to a socket type + subtype. */
export function interfaceSocketType(socketType: string): {
  type: SocketType;
  subtype?: string;
} {
  const t = socketType.replace(/^NodeSocket/, '');
  const table: [string, SocketType][] = [
    ['Float', 'FLOAT'],
    ['Int', 'INT'],
    ['Bool', 'BOOLEAN'],
    ['Vector', 'VECTOR'],
    ['Color', 'RGBA'],
    ['Shader', 'SHADER'],
    ['String', 'STRING'],
    ['Geometry', 'GEOMETRY'],
    ['Object', 'OBJECT'],
    ['Collection', 'COLLECTION'],
    ['Image', 'IMAGE'],
    ['Material', 'MATERIAL'],
    ['Texture', 'TEXTURE'],
    ['Rotation', 'ROTATION'],
    ['Matrix', 'MATRIX'],
    ['Menu', 'MENU'],
    ['Closure', 'CLOSURE'],
    ['Bundle', 'BUNDLE'],
  ];
  for (const [p, type] of table) if (t.startsWith(p)) return { type, subtype: t.slice(p.length).toUpperCase() || undefined };
  if (['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'SHADER', 'STRING', 'GEOMETRY'].includes(socketType)) return { type: socketType as SocketType };
  return { type: 'FLOAT' };
}

export const SOCKET_IDNAME: Record<string, string> = {
  FLOAT: 'NodeSocketFloat',
  INT: 'NodeSocketInt',
  BOOLEAN: 'NodeSocketBool',
  VECTOR: 'NodeSocketVector',
  RGBA: 'NodeSocketColor',
  SHADER: 'NodeSocketShader',
  STRING: 'NodeSocketString',
  GEOMETRY: 'NodeSocketGeometry',
  OBJECT: 'NodeSocketObject',
  COLLECTION: 'NodeSocketCollection',
  IMAGE: 'NodeSocketImage',
  MATERIAL: 'NodeSocketMaterial',
  TEXTURE: 'NodeSocketTexture',
  ROTATION: 'NodeSocketRotation',
  MATRIX: 'NodeSocketMatrix',
  MENU: 'NodeSocketMenu',
};

/** Sockets of a group interface as node sockets. */
export function interfaceSockets(tree: NodeTreeData | undefined, inOut: 'INPUT' | 'OUTPUT'): SocketDef[] {
  if (!tree?.interface) return [];
  return tree.interface
    .filter((i) => i.in_out === inOut)
    .map((i) => {
      const { type, subtype } = interfaceSocketType(i.socket_type);
      const s: SocketDef = { name: i.name, identifier: i.identifier, type };
      if (subtype && subtype !== 'NONE') s.subtype = subtype;
      if (i.default_value !== undefined) s.default = i.default_value;
      if (i.min_value !== undefined) s.min = i.min_value;
      if (i.max_value !== undefined) s.max = i.max_value;
      if (i.hide_value) s.hide_value = true;
      if (i.description) s.description = i.description;
      return s;
    });
}

/** All sockets (including unavailable ones) of a node instance. */
export function allSockets(node: NodeData, ctx?: SocketContext): { inputs: SocketDef[]; outputs: SocketDef[] } {
  const def = getNodeType(node.type);
  if (!def) return { inputs: [], outputs: [] };
  if (def.dynamicSockets && ctx) return def.dynamicSockets(node, ctx);
  return { inputs: def.inputs, outputs: def.outputs };
}

function resolve(def: NodeTypeDef | undefined, node: NodeData, s: SocketDef, isOutput: boolean): ResolvedSocket {
  const label = def?.socketLabel?.(node, s, isOutput) ?? s.shortLabel ?? s.name;
  return { ...s, label };
}

export function isAvailable(node: NodeData, s: SocketDef, isOutput: boolean) {
  const def = getNodeType(node.type);
  if (def?.available) return def.available(node, s, isOutput);
  return !s.disabled;
}

/** Available (visible) sockets of a node instance with display labels. */
export function nodeSockets(node: NodeData, ctx?: SocketContext): { inputs: ResolvedSocket[]; outputs: ResolvedSocket[] } {
  const def = getNodeType(node.type);
  const all = allSockets(node, ctx);
  return {
    inputs: all.inputs.filter((s) => isAvailable(node, s, false)).map((s) => resolve(def, node, s, false)),
    outputs: all.outputs.filter((s) => isAvailable(node, s, true)).map((s) => resolve(def, node, s, true)),
  };
}

/** Collapsible input panels of a node: from its type, or from a group's interface. */
export function nodePanels(node: NodeData, ctx?: SocketContext): NodePanelDef[] {
  const def = getNodeType(node.type);
  if (!def) return [];
  if (def.dynamicSockets && ctx) return def.dynamicSockets(node, ctx).panels ?? def.panels ?? [];
  return def.panels ?? [];
}

/** Panels of a group interface, as node panels (inputs only). */
export function interfacePanels(tree: NodeTreeData | undefined): NodePanelDef[] {
  if (!tree?.interface_panels?.length) return [];
  return tree.interface_panels.map((p) => ({
    name: p.name,
    inputs: (tree.interface ?? []).filter((i) => i.in_out === 'INPUT' && i.panel === p.identifier).map((i) => i.identifier),
    closed: !!p.default_closed,
  }));
}

export function findSocket(node: NodeData, identifier: string, isOutput: boolean, ctx?: SocketContext): SocketDef | undefined {
  const all = allSockets(node, ctx);
  const list = isOutput ? all.outputs : all.inputs;
  return list.find((s) => s.identifier === identifier) ?? list.find((s) => s.name === identifier);
}

/** Current value of an unlinked input (stored or default). */
export function inputValue(node: NodeData, s: SocketDef): SocketValue {
  const v = node.inputs[s.identifier];
  return v === undefined ? socketDefault(s) : v;
}

export function propValue(node: NodeData, id: string): SocketValue {
  if (node.props[id] !== undefined) return node.props[id];
  const p = getNodeType(node.type)?.props.find((x) => x.id === id);
  return p?.d ?? null;
}

export function nodeLabel(node: NodeData): string {
  if (node.label) return node.label;
  const def = getNodeType(node.type);
  if (!def) return node.name || node.type;
  return def.dynamicLabel?.(node) ?? def.label;
}

// ---------------------------------------------------------------------------
// Add menus

const menus: { treeTypes: TreeType[]; categories: MenuCategory[] }[] = [];

export function registerNodeMenu(treeTypes: TreeType[], categories: MenuCategory[]) {
  menus.push({ treeTypes, categories });
}

export function nodeMenu(treeType: TreeType): MenuCategory[] {
  return menus.filter((m) => m.treeTypes.includes(treeType)).flatMap((m) => m.categories);
}

/** Node types usable in a tree type. */
export function nodeTypesFor(treeType: TreeType): NodeTypeDef[] {
  return Object.values(nodeTypes).filter((d) => d.treeTypes.includes(treeType));
}

// ---------------------------------------------------------------------------
// Theme colors (header colors per node class, socket colors per type)

/** Node editor behaviour (Preferences ▸ Editing ▸ Node Editor). */
export const nodeEditorSettings = { insertOffset: true, insertMargin: 40 };

/** Node editor canvas colours (Preferences ▸ Themes writes them). */
export const NODE_EDITOR_COLORS = { back: '#1d1d1d', grid: '#2c2c2c', gridMajor: '#353535' };

export const NODE_CLASS_COLORS: Record<NodeClass, string> = {
  input: '#83314a',
  output: '#4c1e2a',
  shader: '#2b652b',
  texture: '#79461d',
  color: '#6e6e1d',
  vector: '#3c3c83',
  converter: '#246283',
  group: '#3b5959',
  layout: '#4d4d4d',
  geometry: '#1d725e',
  attribute: '#1d2546',
  distort: '#4c9797',
  matte: '#977474',
  filter: '#3a2a4a',
  script: '#2d4a2d',
  interface: '#3b3b3b',
  pattern: '#79461d',
};

export const SOCKET_COLORS: Record<SocketType, string> = {
  FLOAT: '#a1a1a1',
  INT: '#598c5c',
  BOOLEAN: '#cca6d6',
  VECTOR: '#6363c7',
  RGBA: '#c7c729',
  SHADER: '#63c763',
  STRING: '#70b2ff',
  ROTATION: '#a663c7',
  MATRIX: '#4882bf',
  MENU: '#4d4d4d',
  GEOMETRY: '#00d6a3',
  OBJECT: '#ed9e5c',
  COLLECTION: '#f5f5f5',
  IMAGE: '#633863',
  MATERIAL: '#eb7582',
  TEXTURE: '#9e4fa3',
  CLOSURE: '#fcb36b',
  BUNDLE: '#4a8899',
  CUSTOM: '#808080',
};

/** Socket type compatibility for links (implicit conversions). */
export function canConvert(from: SocketType, to: SocketType): boolean {
  if (from === to) return true;
  const numeric: SocketType[] = ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION'];
  if (numeric.includes(from) && numeric.includes(to)) return !(from === 'ROTATION' && to !== 'VECTOR') && !(to === 'ROTATION' && from !== 'VECTOR');
  if (to === 'SHADER') return from !== 'GEOMETRY' && numeric.includes(from);
  if (to === 'CUSTOM' || from === 'CUSTOM') return true;
  return false;
}

/** Document helpers for socket contexts */
export function socketContext(doc: DocumentData, tree: NodeTreeData): SocketContext {
  return { doc, tree };
}
