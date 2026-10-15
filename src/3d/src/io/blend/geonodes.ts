// Geometry Nodes modifiers from .blend files: the node group is converted when every node in it
// (and in nested groups) is a type this app evaluates; otherwise the modifier is skipped with a
// warning naming the missing node types. Number and boolean inputs set on the modifier are kept.
import { getNodeType } from '../../nodes/registry';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { convertGroupTree } from './nodes';

const LAYOUT = new Set(['NodeFrame', 'NodeReroute', 'NodeGroupInput', 'NodeGroupOutput', 'GeometryNodeGroup']);

/** Node types of a group (and its nested groups) that this app can't evaluate. */
function missingTypes(ng: BStruct, seen = new Set<number>()): string[] {
  if (seen.has(ng.offset)) return [];
  seen.add(ng.offset);
  const out = new Set<string>();
  for (const n of ng.list('nodes', 100_000)) {
    const idname = n.str('idname');
    if (idname === 'GeometryNodeGroup') {
      const sub = n.ref('id');
      if (sub) for (const t of missingTypes(sub, seen)) out.add(t);
      continue;
    }
    if (LAYOUT.has(idname)) continue;
    if (!getNodeType(idname)?.treeTypes.includes('GEOMETRY')) out.add(idname);
  }
  return [...out];
}

/** IDProperty int / float / double / boolean value. */
function idpValue(prop: BStruct, ctx: Ctx): number | boolean | null {
  const type = prop.num('type');
  const data = prop.sub('data');
  if (!data) return null;
  const off = data.offset + (data.field('val')?.offset ?? 0);
  if (type === 1) return data.num('val');
  if (type === 2) return ctx.f.dv.getFloat32(off, ctx.f.littleEndian);
  if (type === 8) return ctx.f.dv.getFloat64(off, ctx.f.littleEndian);
  if (type === 10) return data.num('val') !== 0;
  return null;
}

/** Modifier settings of a geometry nodes modifier, or null when its group can't be evaluated here. */
export function importGeometryNodes(d: BStruct, ctx: Ctx): { node_group: string | null; inputs: Record<string, number | boolean> } | null {
  const ng = d.ref('node_group');
  if (!ng) return { node_group: null, inputs: {} };
  const missing = missingTypes(ng);
  if (missing.length) {
    ctx.warn.add('Geometry Nodes modifiers not supported (skipped)', `${d.sub('modifier')?.str('name') ?? ''} (${ng.idName}: ${missing.join(', ')})`);
    return null;
  }
  const id = convertGroupTree(ng, 'GEOMETRY', ctx);
  if (!id) return null;
  const g = ctx.doc.node_groups[id];
  if (g) g.is_modifier = true;
  const inputs: Record<string, number | boolean> = {};
  const props = d.sub('settings')?.ref('properties');
  for (const p of props?.sub('data')?.list('group') ?? []) {
    const name = p.str('name');
    const v = idpValue(p, ctx);
    if (name && v !== null && Number.isFinite(Number(v))) inputs[name] = v;
  }
  return { node_group: id, inputs };
}
