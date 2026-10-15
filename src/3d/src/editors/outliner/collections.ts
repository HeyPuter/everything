// Collection editing used by the Outliner: create, duplicate, delete, visibility and view-layer
// flags, isolation and the numbered "hide collection" shortcut. Pure document functions.
import type { CollectionData, DocumentData } from '../../data/types';
import { newCollection } from '../../data/defaults';
import { uniqueName, deleteObjects, duplicateObject } from '../../ops/object';
import { ancestorCollections, collectionsInOrder, descendantCollections, objectsInside, parentCollection } from './tree';

export type CollectionFlag = 'exclude' | 'hide' | 'hide_viewport' | 'hide_render' | 'hide_select' | 'holdout' | 'indirect_only';

/** Add a new collection inside `parent`; returns its id. */
export function addCollection(doc: DocumentData, parent: string, name = 'Collection'): string {
  const c = newCollection(uniqueName(doc, name, 'collections'));
  doc.collections[c.id] = c;
  (doc.collections[parent] ?? doc.collections[doc.scene.collection]).children.push(c.id);
  return c.id;
}

/**
 * Duplicate a collection with its child collections and objects. `linked` shares object data
 * between the copies; otherwise object data is copied too. Returns the new collection id.
 */
export function duplicateCollection(doc: DocumentData, id: string, linked: boolean): string | null {
  const src = doc.collections[id];
  if (!src || id === doc.scene.collection) return null;
  const obMap = new Map<string, string>();
  const copyTree = (c: CollectionData): string => {
    const n = newCollection(uniqueName(doc, c.name, 'collections'));
    const { id: nid, name } = n;
    Object.assign(n, structuredClone({ ...c, objects: [], children: [] }), {
      id: nid,
      name,
    });
    doc.collections[nid] = n;
    for (const oid of [...c.objects]) {
      const ob = doc.objects[oid];
      if (!ob) continue;
      let cid = obMap.get(oid);
      if (!cid) {
        const copy = duplicateObject(doc, ob, linked);
        // duplicateObject links the copy wherever the original lives; it belongs to the new collection only
        for (const cc of Object.values(doc.collections)) if (cc.id !== nid) cc.objects = cc.objects.filter((x) => x !== copy.id);
        cid = copy.id;
        obMap.set(oid, cid);
      }
      if (!n.objects.includes(cid)) n.objects.push(cid);
    }
    for (const ch of c.children) if (doc.collections[ch]) n.children.push(copyTree(doc.collections[ch]));
    return nid;
  };
  const nid = copyTree(src);
  // keep parenting between duplicated objects
  for (const newId of obMap.values()) {
    const o = doc.objects[newId];
    if (o.parent && obMap.has(o.parent)) o.parent = obMap.get(o.parent)!;
    for (const m of o.modifiers) for (const k of Object.keys(m)) if (typeof m[k] === 'string' && obMap.has(m[k] as string)) m[k] = obMap.get(m[k] as string);
    for (const k of o.constraints) if (k.target && obMap.has(k.target as string)) k.target = obMap.get(k.target as string)!;
  }
  const parent = parentCollection(doc, id) ?? doc.collections[doc.scene.collection];
  const at = parent.children.indexOf(id);
  parent.children.splice(at < 0 ? parent.children.length : at + 1, 0, nid);
  return nid;
}

/**
 * Delete collections. Without `hierarchy` the children and objects move up to the parent;
 * with it, child collections and objects that are not linked elsewhere are deleted as well.
 */
export function deleteCollections(doc: DocumentData, ids: string[], hierarchy: boolean): number {
  let n = 0;
  for (const id of ids) {
    const c = doc.collections[id];
    if (!c || id === doc.scene.collection) continue;
    const parent = parentCollection(doc, id) ?? doc.collections[doc.scene.collection];
    if (hierarchy) {
      const doomed = [id, ...descendantCollections(doc, id)];
      const objs = new Set(objectsInside(doc, id));
      for (const cid of doomed) delete doc.collections[cid];
      for (const cc of Object.values(doc.collections)) cc.children = cc.children.filter((x) => !doomed.includes(x));
      for (const o of [...objs]) if (Object.values(doc.collections).some((x) => x.objects.includes(o))) objs.delete(o);
      deleteObjects(doc, objs);
    } else {
      const at = parent.children.indexOf(id);
      const keep = c.children.filter((x) => !parent.children.includes(x));
      parent.children.splice(at, 1, ...keep);
      for (const o of c.objects) if (!parent.objects.includes(o)) parent.objects.push(o);
      delete doc.collections[id];
      for (const cc of Object.values(doc.collections)) cc.children = cc.children.filter((x) => x !== id);
    }
    n++;
  }
  return n;
}

export function setCollectionFlag(doc: DocumentData, ids: string[], flag: CollectionFlag, value: boolean) {
  for (const id of ids) {
    const c = doc.collections[id];
    if (c && id !== doc.scene.collection) (c as unknown as Record<string, boolean>)[flag] = value;
  }
}

/** Hide (eye) every collection except `id`, its parents and its children. */
export function isolateCollection(doc: DocumentData, id: string) {
  const keep = new Set([id, ...ancestorCollections(doc, id), ...descendantCollections(doc, id)]);
  for (const c of collectionsInOrder(doc)) c.hide = !keep.has(c.id);
}

/** Show or hide everything inside a collection: child collections and objects. */
export function setInsideHidden(doc: DocumentData, id: string, hidden: boolean) {
  for (const cid of descendantCollections(doc, id)) doc.collections[cid].hide = hidden;
  for (const oid of objectsInside(doc, id)) {
    doc.objects[oid].hide = hidden;
    if (hidden) doc.objects[oid].select = false;
  }
}

/** Show a collection, also un-hiding its parents so it actually becomes visible. */
export function showCollection(doc: DocumentData, id: string) {
  for (const a of [...ancestorCollections(doc, id), id]) if (a !== doc.scene.collection) doc.collections[a].hide = false;
}

/**
 * Numbered collection visibility (1…0 keys): isolate the n-th collection (depth-first order),
 * or with `extend` toggle it while keeping the others as they are.
 */
export function hideCollectionByIndex(doc: DocumentData, index: number, extend: boolean): boolean {
  const list = collectionsInOrder(doc).filter((c) => !c.exclude);
  const target = list[index - 1];
  if (!target) return false;
  if (extend) {
    if (target.hide) showCollection(doc, target.id);
    else target.hide = true;
  } else isolateCollection(doc, target.id);
  return true;
}

/** Move collection `moving` into `target` (or before / after it in its parent). */
export function moveCollection(doc: DocumentData, moving: string, target: string, where: 'INTO' | 'BEFORE' | 'AFTER'): boolean {
  if (moving === doc.scene.collection || !doc.collections[moving] || !doc.collections[target]) return false;
  if (moving === target) return false;
  const host = where === 'INTO' ? target : parentCollection(doc, target)?.id;
  if (!host) return false;
  // no cycles: the destination may not be inside the moving collection
  if (host === moving || descendantCollections(doc, moving).includes(host)) return false;
  for (const c of Object.values(doc.collections)) c.children = c.children.filter((x) => x !== moving);
  const kids = doc.collections[host].children;
  if (where === 'INTO') kids.push(moving);
  else {
    const at = kids.indexOf(target);
    kids.splice(where === 'BEFORE' ? at : at + 1, 0, moving);
  }
  return true;
}

/** Move (or link) objects into a collection. Moving removes them from every other collection. */
export function moveObjectsToCollection(doc: DocumentData, ids: string[], target: string, link: boolean) {
  const t = doc.collections[target];
  if (!t) return;
  for (const id of ids) {
    if (!doc.objects[id]) continue;
    if (!link) for (const c of Object.values(doc.collections)) if (c.id !== target) c.objects = c.objects.filter((x) => x !== id);
    if (!t.objects.includes(id)) t.objects.push(id);
  }
}
