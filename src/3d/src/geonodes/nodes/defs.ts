// Geometry node type definitions: interface data from data.gen.ts plus behaviour (exec).
import { h, type Child } from '../../ui/h';
import { app } from '../../app/app';
import { enumMenu } from '../../ui/widgets';
import { registerNodeType, getNodeType, propValue } from '../../nodes/registry';
import type { NodeClass, NodePropDef, NodeTypeDef, SocketDef, SocketType, NodeDrawContext } from '../../nodes/types';
import type { NodeData, SocketValue } from '../../data/types';
import { GN_NODE_DATA } from '../data.gen';
import { registerExec, type GeoNodeExec } from '../exec';
import type { GnRawSocket } from '../types';

const RAW_TYPE: Record<string, SocketType> = { VALUE: 'FLOAT' };

export function sockFromRaw(r: GnRawSocket): SocketDef {
  const [name, identifier, type, o] = r;
  const s: SocketDef = {
    name,
    identifier,
    type: RAW_TYPE[type] ?? (type as SocketType),
  };
  if (o) {
    if (o.d !== undefined && o.d !== null) s.default = o.d;
    if (o.min !== undefined) s.min = o.min;
    if (o.max !== undefined) s.max = o.max;
    if (o.sub) s.subtype = o.sub;
    if (o.hv) s.hide_value = true;
    if (o.off) s.disabled = true;
    if (o.shape) s.shape = o.shape;
  }
  return s;
}

const ID_TYPES = new Set<SocketType>(['OBJECT', 'COLLECTION', 'MATERIAL', 'FONT']);
const ID_ICON: Record<string, string> = {
  OBJECT: 'object',
  COLLECTION: 'collection',
  MATERIAL: 'material',
  FONT: 'outliner_ob_font',
};

/** Selector rows for unlinked object/collection/material inputs (drawn in the node body). */
export function idSocketBody(ctx: NodeDrawContext, sockets: SocketDef[]): Child {
  const { node, tree } = ctx;
  return h(
    'div',
    { class: 'gn-id-rows' },
    sockets.map((s) => {
      const linked = tree.links.some((l) => l.to_node === node.id && l.to_socket === s.identifier);
      const doc = app.doc;
      const list: { id: string; name: string }[] =
        s.type === 'OBJECT'
          ? Object.values(doc.objects)
          : s.type === 'COLLECTION'
            ? Object.values(doc.collections).filter((c) => c.id !== doc.scene.collection)
            : s.type === 'FONT'
              ? Object.values(doc.fonts ?? {})
              : Object.values(doc.materials);
      const cur = (node.inputs[s.identifier] as string | null) ?? '';
      return h(
        'div',
        { key: s.identifier, class: { 'gn-id-row': true, linked } },
        enumMenu(
          `${ctx.key}:id:${s.identifier}`,
          [
            { value: '', label: s.name },
            ...list.map((o) => ({
              value: o.id,
              label: o.name,
              icon: ID_ICON[s.type],
            })),
          ],
          linked ? '' : cur,
          (v) => {
            node.inputs[s.identifier] = v || null;
            ctx.changed(`Set ${s.name}`, true);
          },
          {
            title: s.name,
            disabled: linked,
            tip: linked ? `${s.name} is linked` : s.name,
          },
        ),
      );
    }),
  );
}

export interface GnOptions extends Partial<Omit<NodeTypeDef, 'idname' | 'category' | 'treeTypes'>> {
  /** MENU sockets turned into enum properties: identifier → items */
  menus?: Record<string, [string, string][]>;
  /** sockets (identifiers) or properties (ids) dropped from the interface */
  drop?: string[];
  /** restrict enum items of properties */
  items?: Record<string, string[]>;
  /** property overrides */
  propPatch?: Record<string, Partial<NodePropDef>>;
}

/** Define a geometry node from interface data and an exec implementation. */
export function gn(idname: string, category: NodeClass, exec: GeoNodeExec, opts: GnOptions = {}): NodeTypeDef {
  const raw = GN_NODE_DATA[idname];
  if (!raw) throw new Error(`missing geometry node data ${idname}`);
  const drop = new Set(opts.drop ?? []);
  const menus = opts.menus ?? {};
  const inputs: SocketDef[] = [];
  const menuProps: NodePropDef[] = [];
  for (const r of raw.inputs) {
    if (drop.has(r[1])) continue;
    if (r[2] === 'MENU') {
      const items = menus[r[1]];
      if (!items) continue;
      menuProps.push({
        id: r[1],
        name: r[0],
        type: 'ENUM',
        items,
        d: (r[3]?.d as string) ?? items[0][0],
        noLabel: true,
      });
      continue;
    }
    const s = sockFromRaw(r);
    if (ID_TYPES.has(s.type)) s.hide_value = true;
    inputs.push(s);
  }
  const outputs = raw.outputs.filter((r) => !drop.has(r[1])).map(sockFromRaw);
  const props: NodePropDef[] = [...menuProps];
  for (const p of raw.props) {
    if (drop.has(p.id)) continue;
    let type = p.type as NodePropDef['type'];
    if (p.type === 'FLOAT' && Array.isArray(p.d)) type = 'VECTOR';
    const def: NodePropDef = { id: p.id, name: p.name, type, d: p.d };
    if (p.items) {
      const allow = opts.items?.[p.id];
      def.items = allow ? p.items.filter(([v]) => allow.includes(v)) : p.items;
    }
    if (p.min !== undefined) def.min = p.min;
    if (p.max !== undefined) def.max = p.max;
    if (p.softMin !== undefined) def.softMin = p.softMin;
    if (p.softMax !== undefined) def.softMax = p.softMax;
    if (p.sub) def.sub = p.sub;
    if (type === 'ENUM') def.noLabel = true;
    Object.assign(def, opts.propPatch?.[p.id] ?? {});
    props.push(def);
  }
  const idSockets = inputs.filter((s) => ID_TYPES.has(s.type));
  const def: NodeTypeDef = {
    idname,
    label: raw.label,
    category,
    treeTypes: ['GEOMETRY'],
    inputs,
    outputs,
    props,
    width: raw.width,
    description: raw.description,
    ...opts,
  };
  delete (def as GnOptions).menus;
  delete (def as GnOptions).drop;
  delete (def as GnOptions).items;
  delete (def as GnOptions).propPatch;
  if (idSockets.length && !opts.drawBody) {
    def.drawBody = (ctx) =>
      idSocketBody(
        ctx,
        idSockets.filter((s) => def.available?.(ctx.node, s, false) ?? !s.disabled),
      );
    def.bodyHeight = (n) => 24 * idSockets.filter((s) => def.available?.(n, s, false) ?? !s.disabled).length + 2;
  }
  registerNodeType(def);
  registerExec(idname, exec);
  return def;
}

/** Extend an existing (shader) node type to geometry trees with an exec implementation. */
export function shared(idname: string, exec: GeoNodeExec): NodeTypeDef {
  const def = getNodeType(idname);
  if (!def) throw new Error(`missing node type ${idname}`);
  if (!def.treeTypes.includes('GEOMETRY')) def.treeTypes = [...def.treeTypes, 'GEOMETRY'];
  registerExec(idname, exec);
  return def;
}

export const prop = (n: NodeData, id: string) => propValue(n, id) as SocketValue;
export const sprop = (n: NodeData, id: string) => String(propValue(n, id) ?? '');

export const DOMAIN_ITEMS: [string, string][] = [
  ['POINT', 'Point'],
  ['EDGE', 'Edge'],
  ['FACE', 'Face'],
  ['CORNER', 'Face Corner'],
  ['CURVE', 'Spline'],
  ['INSTANCE', 'Instance'],
];
export const DOMAIN_IDS = DOMAIN_ITEMS.map(([v]) => v);

export const ATTR_TYPES = ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'QUATERNION', 'FLOAT2'];
