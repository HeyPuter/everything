// Extra values of the Viewer node: besides its main Value, a viewer can show more fields, each
// stored on the viewed geometry as `.viewer:<name>` and shown as its own spreadsheet column.
import { getNodeType } from '../../nodes/registry';
import type { NodeData } from '../../data/types';
import { fieldTypeOfEnum } from '../types';
import { valueSocket } from './geometry';
import { itemListUI, itemSocket, readItems, registerItemNode, type ItemListDef, type NodeItem } from './items';
import { VIEWER } from './output';

export const viewerItems = (n: NodeData): NodeItem[] => readItems(n, 'viewer_items');
export const viewerItemIn = (it: NodeItem) => `Value_${it.id}`;
/** Attribute holding an extra viewed value. */
export const viewerAttr = (it: NodeItem) => `.viewer:${it.name}`;

const TYPE_OF: Record<string, string> = { FLOAT: 'FLOAT', INT: 'INT', BOOLEAN: 'BOOLEAN', VECTOR: 'FLOAT_VECTOR', RGBA: 'FLOAT_COLOR', ROTATION: 'QUATERNION' };

export const VIEWER_ITEMS: ItemListDef = {
  prop: 'viewer_items',
  title: 'Extra Values',
  inSocket: viewerItemIn,
  types: [
    ['FLOAT', 'Float'],
    ['INT', 'Integer'],
    ['BOOLEAN', 'Boolean'],
    ['FLOAT_VECTOR', 'Vector'],
    ['FLOAT_COLOR', 'Color'],
    ['QUATERNION', 'Rotation'],
  ],
  typeKey: 'data_type',
  typeFor: (s) => TYPE_OF[s.type],
  defaultName: () => 'Value',
  ops: 'geometry_nodes_viewer',
  opLabel: 'Viewer',
};
registerItemNode(VIEWER, VIEWER_ITEMS, viewerItems);

{
  const d = getNodeType(VIEWER)!;
  const base = d.dynamicSockets!;
  d.dynamicSockets = (node, ctx) => {
    const s = base(node, ctx);
    return {
      ...s,
      inputs: [...s.inputs, ...viewerItems(node).map((it) => ({ ...valueSocket(viewerItemIn(it), fieldTypeOfEnum(String(it.data_type ?? 'FLOAT')), it.name), hide_value: true })), itemSocket()],
    };
  };
  d.drawOptions = (ctx) => itemListUI(ctx, VIEWER_ITEMS);
}
