// Several UV maps per mesh: the active one lives in `uvs` / `uv_map_name` (what editing, unwrapping and
// display use), the others in `uv_layers_extra`; `uv_active_index` keeps the list order (pure).
import type { MeshData } from '../data/types';

export interface UVMapRow {
  name: string;
  active: boolean;
  render: boolean;
}

const valid = (me: MeshData) => (me.uv_layers_extra ?? []).filter((u) => u.data.length === me.indices.length * 2);
export const hasActiveUV = (me: MeshData) => me.indices.length > 0 && me.uvs.length === me.indices.length * 2;

/** The UV maps in list order. */
export function uvMaps(me: MeshData): UVMapRow[] {
  const extra = valid(me).map((u) => u.name);
  const names = [...extra];
  if (hasActiveUV(me)) names.splice(Math.max(0, Math.min(extra.length, me.uv_active_index ?? 0)), 0, me.uv_map_name || 'UVMap');
  const render = names.includes(me.uv_render_name ?? '') ? me.uv_render_name : names[0];
  return names.map((name) => ({ name, active: hasActiveUV(me) && name === (me.uv_map_name || 'UVMap'), render: name === render }));
}

/** Make the map at list position i active (its data moves into `uvs`). */
export function setActiveUV(me: MeshData, i: number): boolean {
  const rows = uvMaps(me);
  const row = rows[i];
  if (!row || row.active) return false;
  const extra = valid(me);
  const k = extra.findIndex((u) => u.name === row.name);
  if (k < 0) return false;
  const next = extra[k];
  const rest = extra.filter((_, j) => j !== k);
  // the previous active map goes back to its place in the list
  if (hasActiveUV(me)) {
    const at = rows.findIndex((r) => r.active);
    rest.splice(at > i ? at - 1 : at, 0, { name: me.uv_map_name || 'UVMap', data: me.uvs });
  }
  me.uv_layers_extra = rest;
  me.uvs = next.data;
  me.uv_map_name = next.name;
  me.uv_active_index = i;
  return true;
}

/** A free UV map name based on `base`. */
export function uniqueUVName(me: MeshData, base = 'UVMap'): string {
  const used = new Set(uvMaps(me).map((r) => r.name));
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}.${String(n).padStart(3, '0')}`)) n++;
  return `${base}.${String(n).padStart(3, '0')}`;
}

/** Add a UV map (a copy of the active one, or all zero) at the end of the list and make it active. */
export function addUVMap(me: MeshData, name?: string): string {
  const nc = me.indices.length;
  const data = hasActiveUV(me) ? me.uvs.slice() : new Float32Array(nc * 2);
  const n = uniqueUVName(me, name || 'UVMap');
  if (!hasActiveUV(me)) {
    me.uvs = data;
    me.uv_map_name = n;
    me.uv_active_index = valid(me).length;
    return n;
  }
  const rows = uvMaps(me);
  const extra = valid(me);
  // insert the old active at its place, then append the new map as the active one
  const at = rows.findIndex((r) => r.active);
  extra.splice(at, 0, { name: me.uv_map_name || 'UVMap', data: me.uvs });
  me.uv_layers_extra = extra;
  me.uvs = data;
  me.uv_map_name = n;
  me.uv_active_index = extra.length;
  return n;
}

/** Remove the active UV map; the next one (or the previous) becomes active. */
export function removeActiveUV(me: MeshData): boolean {
  if (!hasActiveUV(me)) return false;
  const rows = uvMaps(me);
  const at = rows.findIndex((r) => r.active);
  const extra = valid(me);
  if (me.uv_render_name === me.uv_map_name) me.uv_render_name = undefined;
  if (!extra.length) {
    me.uvs = new Float32Array(0);
    me.uv_map_name = 'UVMap';
    me.uv_layers_extra = undefined;
    me.uv_active_index = 0;
    return true;
  }
  const k = Math.min(at, extra.length - 1);
  const next = extra[k];
  me.uv_layers_extra = extra.filter((_, j) => j !== k);
  me.uvs = next.data;
  me.uv_map_name = next.name;
  me.uv_active_index = k;
  return true;
}

/** Rename the map at list position i. */
export function renameUV(me: MeshData, i: number, name: string): boolean {
  const rows = uvMaps(me);
  name = name.trim();
  if (!rows[i] || !name || rows.some((r, j) => j !== i && r.name === name)) return false;
  const old = rows[i].name;
  if (rows[i].active) me.uv_map_name = name;
  else {
    const u = valid(me).find((x) => x.name === old);
    if (u) u.name = name;
  }
  if (me.uv_render_name === old) me.uv_render_name = name;
  return true;
}
