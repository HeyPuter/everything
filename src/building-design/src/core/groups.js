/**
 * Model groups. A group type holds a definition: its member elements with
 * coordinates relative to the group origin (rotation 0), levels replaced by
 * placeholders, and host references between members by local ids. A group
 * instance places the definition at a point, rotation and level; its
 * members are ordinary elements that carry the instance's id as `groupId`.
 *
 * Editing one instance and finishing rebuilds the definition from it and
 * re-creates the members of every other instance of the type.
 *
 * Detail groups work the same way for view-specific elements (detail lines,
 * regions, text, detail components): the instance and its members belong to
 * one view.
 */
import { transformPatch, rotation, translation, deleteElements } from './ops.js';
import { isView } from './doc.js';
import { bbox } from './geom.js';

const BASE = '$base';
const ABOVE = '$above';
const VIEW = '$view';

/** View-specific elements that can be in a detail group (not ones that point at model elements). */
export function detailGroupable(el) {
  return !!el && !!el.viewId && !isView(el) && !['dimension', 'tag', 'spot', 'radialDim', 'angularDim', 'colorLegend', 'group', 'viewport', 'image'].includes(el.kind);
}

/** Elements that can belong to a model group. */
export function groupable(el) {
  return !!el && !isView(el) && !el.viewId && !el.kind.endsWith('Type') && !['level', 'grid', 'refPlane', 'material', 'project', 'group', 'viewport', 'areaBoundary', 'area'].includes(el.kind);
}

/** Group members of a group instance. */
export function membersOf(doc, groupId) {
  return doc.filter((el) => el.groupId === groupId);
}

/** Compose rotation about the origin then translation. */
function placement(at, rot) {
  const r = rotation([0, 0], rot);
  const t = translation(at);
  return { point: (p) => t.point(r.point(p)), angle: rot };
}

function inverse(at, rot) {
  const t = translation([-at[0], -at[1]]);
  const r = rotation([0, 0], -rot);
  return { point: (p) => r.point(t.point(p)), angle: -rot };
}

/** Definition of a group from its current members. */
export function definitionOf(doc, group) {
  const members = membersOf(doc, group.id);
  const above = doc.levelAbove(group.levelId)?.id;
  const xf = inverse(group.at, ((+group.rotation || 0) * Math.PI) / 180);
  return members.map((el) => {
    const { id, groupId: _g, ...rest } = el;
    void _g;
    const local = el.hostId ? {} : transformPatch(el, xf);
    const out = { ...rest, ...local, localId: id };
    if (out.levelId === group.levelId) out.levelId = BASE;
    if (out.topLevelId && out.topLevelId === above) out.topLevelId = ABOVE;
    if (out.viewId && out.viewId === group.viewId) out.viewId = VIEW;
    if (out.hostId) out.hostId = `@${out.hostId}`;
    return out;
  });
}

/** Create the members of a group instance from a definition. Returns their ids. */
export function instantiate(doc, group, def) {
  const above = doc.levelAbove(group.levelId)?.id ?? null;
  const xf = placement(group.at, ((+group.rotation || 0) * Math.PI) / 180);
  const map = new Map();
  const ids = [];
  // Hosts first, so hosted members can refer to their new ids.
  const ordered = [...def.filter((m) => !m.hostId), ...def.filter((m) => m.hostId)];
  for (const m of ordered) {
    const { localId, ...rest } = m;
    const item = { ...rest, ...(m.hostId ? {} : transformPatch(m, xf)), groupId: group.id };
    if (item.levelId === BASE) item.levelId = group.levelId;
    if (item.topLevelId === ABOVE) item.topLevelId = above;
    if (item.viewId === VIEW) item.viewId = group.viewId;
    if (item.hostId) {
      const host = map.get(item.hostId.slice(1));
      if (!host) continue;
      item.hostId = host;
    }
    const added = doc.add(item);
    map.set(localId, added.id);
    ids.push(added.id);
  }
  return ids;
}

/**
 * Make a group from elements. Hosted elements of included walls come along.
 * Returns the new group instance.
 */
export function createGroup(doc, ids, { name, levelId }) {
  const set = new Set(ids);
  for (const el of doc.items.values()) if (el.hostId && set.has(el.hostId)) set.add(el.id);
  const all = [...set].map((id) => doc.get(id)).filter((el) => el && !el.groupId);
  let members = all.filter(groupable);
  // Only view-specific elements, all in one view: a detail group.
  let viewId = null;
  if (!members.length) {
    const detail = all.filter(detailGroupable);
    if (detail.length && detail.every((el) => el.viewId === detail[0].viewId)) {
      members = detail;
      viewId = detail[0].viewId;
    }
  }
  if (!members.length) return null;
  const pts = [];
  for (const el of members) for (const f of ['a', 'b', 'at']) if (Array.isArray(el[f])) pts.push(el[f]);
  for (const el of members) for (const p of el.boundary || el.path || []) pts.push(p);
  const bb = pts.length ? bbox(pts) : { x0: 0, y0: 0, x1: 0, y1: 0 };
  const at = [Math.round((bb.x0 + bb.x1) / 2), Math.round((bb.y0 + bb.y1) / 2)];
  const counts = new Map();
  for (const el of members) if (el.levelId) counts.set(el.levelId, (counts.get(el.levelId) || 0) + 1);
  const lv = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || levelId;
  const type = doc.add({ kind: 'groupType', name, familyName: viewId ? 'Detail Group' : 'Model Group', detail: !!viewId, members: [] });
  const group = doc.add({ kind: 'group', typeId: type.id, levelId: lv, at, rotation: 0, ...(viewId ? { viewId } : {}) });
  for (const el of members) doc.update(el.id, { groupId: group.id });
  doc.update(type.id, { members: definitionOf(doc, doc.get(group.id)) });
  return doc.get(group.id);
}

/** Place a new instance of a group type. */
export function placeGroup(doc, type, at, rotationDeg, levelId, viewId = null) {
  const group = doc.add({ kind: 'group', typeId: type.id, levelId, at, rotation: rotationDeg || 0, ...(type.detail && viewId ? { viewId } : {}) });
  instantiate(doc, group, type.members || []);
  return group;
}

/** Remove a group instance, keeping its members as ordinary elements. */
export function ungroup(doc, groupId) {
  for (const el of membersOf(doc, groupId)) doc.update(el.id, { groupId: null });
  doc.remove(groupId);
}

/**
 * Store the edited instance's members as the type definition and rebuild
 * every other instance of the type. Returns the number of instances updated.
 */
export function propagateGroup(doc, groupId) {
  const group = doc.get(groupId);
  if (!group) return 0;
  const def = definitionOf(doc, group);
  doc.update(group.typeId, { members: def });
  let n = 0;
  for (const other of doc.all('group')) {
    if (other.id === groupId || other.typeId !== group.typeId) continue;
    deleteElements(doc, membersOf(doc, other.id).map((m) => m.id), { keepEmptyGroups: true });
    instantiate(doc, other, def);
    n++;
  }
  return n;
}

/** Replace the members of instances with those of another group type. */
export function swapGroupType(doc, groupIds, type) {
  for (const id of groupIds) {
    const g = doc.get(id);
    if (!g || g.kind !== 'group') continue;
    deleteElements(doc, membersOf(doc, id).map((m) => m.id), { keepEmptyGroups: true });
    doc.update(id, { typeId: type.id });
    instantiate(doc, doc.get(id), type.members || []);
  }
}
