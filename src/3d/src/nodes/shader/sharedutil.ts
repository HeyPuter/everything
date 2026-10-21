// Utility nodes shared with geometry nodes that also work in shader and world trees: the Repeat
// zone (compiled to a GLSL loop by codegen.ts), Menu Switch with Menu constants (resolved while
// compiling) and Implicit Conversion. Their node types come from the geometry nodes module, so the
// tree types and Add-menu entries are added once every module has loaded.
import { onAppReady } from '../../app/app';
import { getNodeType } from '../registry';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { MenuCategory, MenuEntry, SocketType } from '../types';
import { SHADER_MENU } from './defs';
import { registerGenerator, glslType, literal, REPEAT_INPUT_TYPE, REPEAT_OUTPUT_TYPE, SHADER_BUNDLE_NODES } from './codegen';
// (Repeat Input used outside its zone passes its values through: see Codegen.nodeOutputs)

const MENU_SWITCH = 'GeometryNodeMenuSwitch';
const MENU_INPUT = 'FunctionNodeInputMenu';
const CONVERSION = 'NodeImplicitConversion';
export const SHADER_SHARED_UTILITIES = [REPEAT_INPUT_TYPE, REPEAT_OUTPUT_TYPE, MENU_SWITCH, MENU_INPUT, CONVERSION, ...SHADER_BUNDLE_NODES];

/** Value types a shader Menu Switch / Implicit Conversion can carry. */
const SHADER_DATA_TYPES: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['SHADER', 'Shader'],
];
const isShaderTree = (t?: NodeTreeData) => !!t && (t.type === 'SHADER' || t.type === 'WORLD');

interface MenuItemData {
  id: number;
  name: string;
}
function menuItems(n: NodeData): MenuItemData[] {
  try {
    const v = JSON.parse(String(n.props.enum_items ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

registerGenerator(MENU_SWITCH, (g) => {
  const t = glslType((g.str('data_type') || 'RGBA') as SocketType);
  const items = menuItems(g.node);
  const v = g.staticValue('Menu');
  const pick = items.find((i) => i.name === v) ?? items[0];
  g.out('Output', t, pick ? g.in(`Item_${pick.id}`, t) : literal(t, 0, g.ctx.N));
  for (const it of items) g.out(`Item_${it.id}`, 'float', it === pick ? '1.0' : '0.0');
});

registerGenerator(MENU_INPUT, (g) => g.out('Menu', 'float', '0.0'));

registerGenerator(CONVERSION, (g) => {
  const t = glslType((g.str('data_type') || 'RGBA') as SocketType);
  g.out('Value', t, g.in('Value', t));
});

/** Add the shared utility nodes to shader trees and to the shader Add menu. */
export function shareShaderUtilities() {
  for (const id of SHADER_SHARED_UTILITIES) {
    const d = getNodeType(id);
    if (!d) continue;
    for (const t of ['SHADER', 'WORLD'] as const) if (!d.treeTypes.includes(t)) d.treeTypes = [...d.treeTypes, t];
  }
  // shader-compatible data types; new switches start as colors
  for (const id of [MENU_SWITCH, CONVERSION]) {
    const d = getNodeType(id);
    const p = d?.props.find((x) => x.id === 'data_type');
    if (!d || !p) continue;
    const prev = p.itemsFor;
    p.itemsFor = (tree) => (isShaderTree(tree) ? SHADER_DATA_TYPES : (prev?.(tree) ?? p.items));
    const prevAdd = d.onAdd;
    d.onAdd = (tree, n) => {
      if (isShaderTree(tree) && !SHADER_DATA_TYPES.some(([v]) => v === n.props.data_type)) n.props.data_type = 'RGBA';
      return prevAdd?.(tree, n) ?? [];
    };
  }
  // a shader repeat zone starts without items (geometry items do not exist in shaders)
  const rin = getNodeType(REPEAT_INPUT_TYPE);
  if (rin) {
    const prevAdd = rin.onAdd;
    rin.onAdd = (tree, n) => {
      const added = prevAdd?.(tree, n) ?? [];
      if (isShaderTree(tree))
        for (const o of added) {
          if (o.type !== REPEAT_OUTPUT_TYPE) continue;
          o.props.repeat_items = '[]';
          tree.links = tree.links.filter((l) => !(l.from_node === n.id && l.to_node === o.id));
        }
      return added;
    };
  }
  const has = (c: MenuCategory, id: string): boolean => c.items.some((i) => typeof i !== 'string' && ('idname' in i ? i.idname === id : has(i, id)));
  const input = SHADER_MENU.find((c) => c.label === 'Input');
  const constants = input?.items.find((i) => typeof i !== 'string' && 'items' in i && i.label === 'Constant') as MenuCategory | undefined;
  if (constants && getNodeType(MENU_INPUT) && !has(constants, MENU_INPUT)) {
    // Boolean, Color, Integer, Menu, Value, Vector
    const at = constants.items.findIndex((i) => typeof i !== 'string' && (i as MenuEntry).idname === 'ShaderNodeValue');
    constants.items.splice(at < 0 ? constants.items.length : at, 0, { idname: MENU_INPUT });
  }
  const util = SHADER_MENU.find((c) => c.label === 'Utilities');
  if (util && getNodeType(REPEAT_INPUT_TYPE) && !has(util, REPEAT_INPUT_TYPE)) {
    const extra: MenuCategory['items'] = ['SEPARATOR', { idname: REPEAT_INPUT_TYPE, label: 'Repeat' }, 'SEPARATOR'];
    if (getNodeType(CONVERSION)) extra.push({ idname: CONVERSION });
    // closures and bundles (resolved while compiling)
    for (const [id, label] of [
      ['NodeClosureInput', 'Closure'],
      ['NodeEvaluateClosure', undefined],
      ['NodeCombineBundle', undefined],
      ['NodeSeparateBundle', undefined],
      ['NodeJoinBundle', undefined],
    ] as const)
      if (getNodeType(id)) extra.push(label ? { idname: id, label } : { idname: id });
    if (getNodeType(MENU_SWITCH)) extra.push('SEPARATOR', { idname: MENU_SWITCH, label: 'Menu Switch' });
    util.items.push(...extra);
  }
}
onAppReady(shareShaderUtilities);
