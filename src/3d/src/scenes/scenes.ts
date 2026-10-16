// Multiple scenes in one document. `doc.scene` is always the active scene, so the rest of the
// app reads it directly; the other scenes wait in `doc.scenes` with their master collection
// tucked into the scene record. Objects and collections are shared: a collection or object can
// be linked into several scenes. Switching swaps the records (and the active view layer's
// collection flags, which live on the shared collections).
import type { CollectionData, DocumentData, ID, ObjectData, SceneData } from '../data/types';
import { defaultScene, newCollection, uid } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { applyLiveFlags, captureLiveFlags, collectionTree, ensureViewLayers } from './viewlayers';
import type { LayerCollectionFlags } from './types';

export type SceneNewType = 'NEW' | 'EMPTY' | 'LINK_COPY' | 'FULL_COPY';

/** Give every scene of the document an id (older files have a single scene without one). */
export function ensureSceneIds(doc: DocumentData) {
  doc.scene.id ??= uid('sc');
  if (doc.scenes) for (const [id, s] of Object.entries(doc.scenes)) s.id = id;
}

/** Id of the active scene. */
export function activeSceneId(doc: DocumentData): ID {
  ensureSceneIds(doc);
  return doc.scene.id!;
}

/** Every scene of the document: the active one first, the others by name. */
export function allScenes(doc: DocumentData): SceneData[] {
  ensureSceneIds(doc);
  const others = Object.values(doc.scenes ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  return [doc.scene, ...others];
}

/** Scenes sorted by name (selector menus). */
export function scenesByName(doc: DocumentData): SceneData[] {
  return [...allScenes(doc)].sort((a, b) => a.name.localeCompare(b.name));
}

export function sceneById(doc: DocumentData, id: ID | null | undefined): SceneData | null {
  if (!id) return null;
  ensureSceneIds(doc);
  return doc.scene.id === id ? doc.scene : (doc.scenes?.[id] ?? null);
}

export function sceneByName(doc: DocumentData, name: string | null | undefined): SceneData | null {
  if (!name) return null;
  return allScenes(doc).find((s) => s.name === name) ?? null;
}

/** Master collection of a scene (inactive scenes keep theirs in the scene record). */
export function masterCollection(doc: DocumentData, scene: SceneData): CollectionData | null {
  return scene === doc.scene ? (doc.collections[scene.collection] ?? null) : (scene.master_collection ?? null);
}

/** Collections in a scene's tree (master collection included). */
export function sceneCollections(doc: DocumentData, scene: SceneData): Set<ID> {
  const m = masterCollection(doc, scene);
  return m ? collectionTree(doc, scene.collection, m) : new Set();
}

/** Objects linked into a scene (anywhere in its collection tree). */
export function sceneObjects(doc: DocumentData, scene: SceneData): Set<ID> {
  const out = new Set<ID>();
  const m = masterCollection(doc, scene);
  if (!m) return out;
  for (const id of m.objects) out.add(id);
  for (const cid of sceneCollections(doc, scene)) if (cid !== scene.collection) for (const id of doc.collections[cid]?.objects ?? []) out.add(id);
  return out;
}

/** Names of the scenes an object is linked into. */
export function scenesOfObject(doc: DocumentData, id: ID): SceneData[] {
  return allScenes(doc).filter((s) => sceneObjects(doc, s).has(id));
}

/** Unique scene name. */
export function uniqueSceneName(doc: DocumentData, base: string, except?: SceneData): string {
  const names = new Set(allScenes(doc).filter((s) => s !== except).map((s) => s.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** Drop references of a scene to data that no longer exists (e.g. objects deleted while it was inactive). */
function sanitizeScene(doc: DocumentData, scene: SceneData) {
  const m = doc.collections[scene.collection];
  if (m) {
    m.objects = m.objects.filter((id) => !!doc.objects[id]);
    m.children = m.children.filter((id) => !!doc.collections[id]);
  }
  if (scene.camera && !doc.objects[scene.camera]) scene.camera = null;
  if (scene.world && !doc.worlds[scene.world]) scene.world = null;
  if (scene.active_object && !doc.objects[scene.active_object]) scene.active_object = null;
}

/** Make scene `id` the active scene. Returns false when it already is or does not exist. */
export function activateScene(doc: DocumentData, id: ID): boolean {
  ensureSceneIds(doc);
  const cur = doc.scene;
  if (cur.id === id) return false;
  const next = doc.scenes?.[id];
  if (!next) return false;
  // park the current scene: its active layer's collection flags and its master collection
  ensureViewLayers(cur);
  cur.stashed_flags = captureLiveFlags(doc);
  const master = doc.collections[cur.collection];
  if (master) {
    cur.master_collection = master;
    delete doc.collections[cur.collection];
  }
  doc.scenes ??= {};
  doc.scenes[cur.id!] = cur;
  delete doc.scenes[id];
  // bring in the next one
  if (next.master_collection) {
    doc.collections[next.collection] = next.master_collection;
    delete next.master_collection;
  } else if (!doc.collections[next.collection]) {
    const c = newCollection('Scene Collection');
    c.id = next.collection;
    doc.collections[c.id] = c;
  }
  doc.scene = next;
  sanitizeScene(doc, next);
  ensureViewLayers(next);
  applyLiveFlags(doc, next.stashed_flags ?? {});
  delete next.stashed_flags;
  return true;
}

/** Run `fn` with another scene temporarily active (the previous scene is restored afterwards). */
export function withScene<T>(doc: DocumentData, id: ID, fn: () => T): T {
  const prev = activeSceneId(doc);
  if (prev === id || !activateScene(doc, id)) return fn();
  try {
    return fn();
  } finally {
    activateScene(doc, prev);
  }
}

/** Async variant of `withScene` (renders of another scene). */
export async function withSceneAsync<T>(doc: DocumentData, id: ID, fn: () => Promise<T>): Promise<T> {
  const prev = activeSceneId(doc);
  if (prev === id || !activateScene(doc, id)) return fn();
  try {
    return await fn();
  } finally {
    activateScene(doc, prev);
  }
}

/** Scene settings copied by "Copy Settings" and the copies (everything but the content). */
function copySettings(src: SceneData): SceneData {
  const sc = cloneShared(src);
  delete sc.master_collection;
  delete sc.stashed_flags;
  return sc;
}

/**
 * Create a scene and make it active:
 * - NEW: default settings, empty, no world or camera
 * - EMPTY ("Copy Settings"): the active scene's settings, empty
 * - LINK_COPY: the settings plus the same collections and objects (linked, not copied)
 * - FULL_COPY: the settings plus copies of the collections, objects, their data and the world
 * Returns the new scene.
 */
export function newScene(doc: DocumentData, type: SceneNewType, dup?: { duplicateObject: (doc: DocumentData, ob: ObjectData, linked: boolean, mats?: Map<string, string>) => ObjectData; uniqueName: (doc: DocumentData, base: string, kind?: 'collections' | 'objects') => string }): SceneData {
  ensureSceneIds(doc);
  const cur = doc.scene;
  const curMaster = doc.collections[cur.collection];
  const master = newCollection('Scene Collection');
  let sc: SceneData;
  let flags: Record<ID, LayerCollectionFlags> = {};
  if (type === 'NEW') {
    sc = defaultScene(master.id, null as unknown as ID);
    sc.world = null;
    sc.view_layers = [{ name: 'ViewLayer' }];
  } else {
    sc = copySettings(cur);
    sc.collection = master.id;
    sc.active_object = null;
    sc.custom = {};
    delete sc.custom_ui;
    delete (sc as { asset_data?: unknown }).asset_data;
    ensureViewLayers(sc);
    const liveFlags = captureLiveFlags(doc);
    if (type === 'EMPTY') {
      sc.camera = null;
      sc.world = null;
      sc.timeline_markers = [];
      sc.keying_sets = [];
      sc.rigidbody_world = null;
      sc.sequence_editor = null;
      for (const l of sc.view_layers!) if (l.stored) l.stored.collections = {};
    } else if (type === 'LINK_COPY') {
      master.objects = [...(curMaster?.objects ?? [])];
      master.children = [...(curMaster?.children ?? [])];
      flags = liveFlags;
    } else {
      // full copy: duplicate the collection tree, objects (with their data) and the world
      const obMap = new Map<ID, ID>();
      const colMap = new Map<ID, ID>();
      const mats = new Map<string, string>();
      const copyObject = (oid: ID): ID | null => {
        const ob = doc.objects[oid];
        if (!ob || !dup) return null;
        let id = obMap.get(oid);
        if (!id) {
          const copy = dup.duplicateObject(doc, ob, false, mats);
          // the copy is linked where the original is; it belongs to the copied collections only
          for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((x) => x !== copy.id);
          copy.select = ob.select;
          id = copy.id;
          obMap.set(oid, id);
        }
        return id;
      };
      const copyTree = (cid: ID): ID | null => {
        const c = doc.collections[cid];
        if (!c || !dup) return null;
        const prev = colMap.get(cid);
        if (prev) return prev;
        const n = newCollection(dup.uniqueName(doc, c.name, 'collections'));
        const { id: nid, name } = n;
        Object.assign(n, cloneShared({ ...c, objects: [], children: [] }), { id: nid, name });
        delete (n as { asset_data?: unknown }).asset_data;
        doc.collections[nid] = n;
        colMap.set(cid, nid);
        for (const o of [...c.objects]) {
          const id = copyObject(o);
          if (id && !n.objects.includes(id)) n.objects.push(id);
        }
        for (const ch of c.children) {
          const id = copyTree(ch);
          if (id) n.children.push(id);
        }
        return nid;
      };
      for (const o of [...(curMaster?.objects ?? [])]) {
        const id = copyObject(o);
        if (id) master.objects.push(id);
      }
      for (const ch of curMaster?.children ?? []) {
        const id = copyTree(ch);
        if (id) master.children.push(id);
      }
      // references between the copies (parents, modifier / constraint targets, instanced collections)
      const remap = (v: unknown) => (typeof v === 'string' ? (obMap.get(v) ?? colMap.get(v) ?? v) : v);
      for (const nid of obMap.values()) {
        const o = doc.objects[nid];
        if (o.parent && obMap.has(o.parent)) o.parent = obMap.get(o.parent)!;
        for (const m of o.modifiers) for (const k of Object.keys(m)) if (k !== 'id') m[k] = remap(m[k]);
        for (const k of o.constraints) if (k.target) k.target = remap(k.target) as ID;
        if (o.instance_collection) o.instance_collection = remap(o.instance_collection) as ID;
        if (o.light_linking) {
          if (o.light_linking.receiver_collection) o.light_linking.receiver_collection = remap(o.light_linking.receiver_collection) as ID;
          if (o.light_linking.blocker_collection) o.light_linking.blocker_collection = remap(o.light_linking.blocker_collection) as ID;
        }
      }
      for (const nid of colMap.values()) {
        const c = doc.collections[nid];
        if (c.light_linking) c.light_linking = Object.fromEntries(Object.entries(c.light_linking).map(([k, v]) => [remap(k) as string, v]));
      }
      if (sc.camera) sc.camera = obMap.get(sc.camera) ?? sc.camera;
      for (const mk of sc.timeline_markers) if (mk.camera) mk.camera = obMap.get(mk.camera) ?? mk.camera;
      if (cur.active_object) sc.active_object = obMap.get(cur.active_object) ?? null;
      if (sc.world && doc.worlds[sc.world]) {
        const w = cloneShared(doc.worlds[sc.world]);
        w.id = uid('wo');
        w.name = uniqueIn(Object.values(doc.worlds).map((x) => x.name), w.name);
        delete (w as { asset_data?: unknown }).asset_data;
        doc.worlds[w.id] = w;
        sc.world = w.id;
      }
      for (const [k, v] of Object.entries(liveFlags)) {
        const n = colMap.get(k);
        if (n) flags[n] = v;
      }
      for (const l of sc.view_layers!)
        if (l.stored) l.stored.collections = Object.fromEntries(Object.entries(l.stored.collections).flatMap(([k, v]) => (colMap.has(k) ? [[colMap.get(k)!, v]] : [])));
    }
  }
  sc.id = uid('sc');
  sc.name = uniqueSceneName(doc, cur.name);
  sc.master_collection = master;
  sc.stashed_flags = flags;
  doc.scenes ??= {};
  doc.scenes[sc.id] = sc;
  activateScene(doc, sc.id);
  return sc;
}

function uniqueIn(names: string[], base: string): string {
  const set = new Set(names);
  if (!set.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!set.has(n)) return n;
  }
}

/**
 * Delete a scene (a document keeps at least one). Deleting the active scene activates the next
 * one by name. Objects that are no longer linked into any scene or collection are removed.
 * Returns false when the scene can't be deleted.
 */
export function deleteScene(doc: DocumentData, id: ID): boolean {
  const scenes = allScenes(doc);
  if (scenes.length < 2) return false;
  const target = sceneById(doc, id);
  if (!target) return false;
  if (target === doc.scene) {
    const sorted = scenesByName(doc);
    const i = sorted.indexOf(target);
    const next = sorted[i + 1] ?? sorted[i - 1];
    activateScene(doc, next.id!);
  }
  const removed = doc.scenes![id];
  delete doc.scenes![id];
  // objects of the deleted scene's master collection that nothing else links
  const linked = new Set<ID>();
  for (const c of Object.values(doc.collections)) for (const o of c.objects) linked.add(o);
  for (const s of Object.values(doc.scenes ?? {})) for (const o of s.master_collection?.objects ?? []) linked.add(o);
  const gone = new Set((removed.master_collection?.objects ?? []).filter((o) => !linked.has(o) && doc.objects[o]));
  for (const o of gone) delete doc.objects[o];
  if (gone.size) {
    doc.object_order = doc.object_order.filter((o) => !gone.has(o));
    for (const ob of Object.values(doc.objects)) if (ob.parent && gone.has(ob.parent)) ob.parent = null;
  }
  return true;
}

/** Rename a scene (names are unique; sequencer Scene strips follow the new name). */
export function renameScene(doc: DocumentData, scene: SceneData, name: string): string {
  const old = scene.name;
  const n = uniqueSceneName(doc, name.trim().slice(0, 63) || 'Scene', scene);
  scene.name = n;
  if (old !== n)
    for (const s of allScenes(doc)) {
      const visit = (list: { scene?: string; strips?: unknown[] }[] | undefined) => {
        for (const st of list ?? []) {
          if (st.scene === old) st.scene = n;
          visit(st.strips as never);
        }
      };
      visit(s.sequence_editor?.strips as never);
    }
  return n;
}

/** Collections of every scene, including the master collections of inactive scenes. */
export function allSceneMasters(doc: DocumentData): CollectionData[] {
  return allScenes(doc)
    .map((s) => masterCollection(doc, s))
    .filter((c): c is CollectionData => !!c);
}

/** Whether an object is linked into an inactive scene's master collection. */
export function linkedInInactiveScene(doc: DocumentData, id: ID): boolean {
  return Object.values(doc.scenes ?? {}).some((s) => s.master_collection?.objects.includes(id));
}

/** Whether a collection is a child of an inactive scene's master collection. */
export function childOfInactiveScene(doc: DocumentData, id: ID): boolean {
  return Object.values(doc.scenes ?? {}).some((s) => s.master_collection?.children.includes(id));
}
