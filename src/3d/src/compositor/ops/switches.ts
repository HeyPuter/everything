// Switch-like utility nodes shared with geometry nodes, in compositing trees: Menu Switch (with
// Menu constants), Index Switch and Implicit Conversion pass one of their inputs through.
import { registerExec } from '../eval/evaluator';
import { Result } from '../eval/result';
import { getNodeType } from '../../nodes/registry';
import type { NodeData } from '../../data/types';
import { COMPOSITOR_MENU } from '../nodes/defs';
import type { MenuCategory } from '../../nodes/types';
import { onAppReady } from '../../app/app';

const SHARED = ['GeometryNodeMenuSwitch', 'GeometryNodeIndexSwitch', 'FunctionNodeInputMenu', 'NodeImplicitConversion'];

function items(n: NodeData, key: string): { id: number; name: string }[] {
  try {
    const v = JSON.parse(String(n.props[key] ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

registerExec('FunctionNodeInputMenu', (x) => x.out('Menu', Result.single('STRING', String(x.prop('value') ?? ''))));

registerExec('GeometryNodeMenuSwitch', (x) => {
  const list = items(x.node, 'enum_items');
  const m = x.input('Menu');
  const name = m.domain ? '' : String(m.value ?? '');
  const pick = list.find((i) => i.name === name) ?? list[0];
  if (pick) x.out('Output', x.input(`Item_${pick.id}`));
  for (const it of list) x.out(`Item_${it.id}`, Result.single('BOOLEAN', it === pick));
});

registerExec('GeometryNodeIndexSwitch', (x) => {
  const list = items(x.node, 'index_switch_items');
  const i = Math.round(x.num('Index'));
  const pick = list[i];
  if (pick) x.out('Output', x.input(`Item_${pick.id}`));
});

registerExec('NodeImplicitConversion', (x) => x.out('Value', x.input('Value')));

/** Compositing trees use these nodes too: tree type and Add-menu entries (Input ▸ Constant, Utilities). */
const DATA_TYPES: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['STRING', 'String'],
];

function share() {
  for (const id of SHARED) {
    const d = getNodeType(id);
    if (d && !d.treeTypes.includes('COMPOSITOR')) d.treeTypes = [...d.treeTypes, 'COMPOSITOR'];
  }
  // compositor value types; new switches start as colors
  for (const id of ['GeometryNodeMenuSwitch', 'GeometryNodeIndexSwitch', 'NodeImplicitConversion']) {
    const d = getNodeType(id);
    const p = d?.props.find((x) => x.id === 'data_type');
    if (!d || !p) continue;
    const prev = p.itemsFor;
    p.itemsFor = (tree) => (tree?.type === 'COMPOSITOR' ? DATA_TYPES : (prev?.(tree) ?? p.items));
    const prevAdd = d.onAdd;
    d.onAdd = (tree, n) => {
      if (tree.type === 'COMPOSITOR' && !DATA_TYPES.some(([v]) => v === n.props.data_type)) n.props.data_type = 'RGBA';
      return prevAdd?.(tree, n) ?? [];
    };
  }
  const has = (c: MenuCategory, id: string): boolean => c.items.some((i) => typeof i !== 'string' && ('idname' in i ? i.idname === id : has(i, id)));
  const input = COMPOSITOR_MENU.find((c) => c.label === 'Input');
  const constant = input?.items.find((i) => typeof i !== 'string' && 'items' in i && i.label === 'Constant') as MenuCategory | undefined;
  if (constant && getNodeType('FunctionNodeInputMenu') && !has(constant, 'FunctionNodeInputMenu')) constant.items.push({ idname: 'FunctionNodeInputMenu' });
  const util = COMPOSITOR_MENU.find((c) => c.label === 'Utilities');
  if (util && !has(util, 'GeometryNodeMenuSwitch')) {
    const extra: MenuCategory['items'] = ['SEPARATOR'];
    if (getNodeType('NodeImplicitConversion')) extra.push({ idname: 'NodeImplicitConversion' });
    if (getNodeType('GeometryNodeIndexSwitch')) extra.push({ idname: 'GeometryNodeIndexSwitch' });
    if (getNodeType('GeometryNodeMenuSwitch')) extra.push({ idname: 'GeometryNodeMenuSwitch' });
    util.items.push(...extra);
  }
}
onAppReady(share);
