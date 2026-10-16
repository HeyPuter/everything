// Background scenes ("sets"): a scene can show another scene's objects behind its own, in the
// viewport and in renders, without them being selectable. Dependency-free so the depsgraph and
// the render scene can use it.
import type { DocumentData, ID } from '../data/types';

/** Master collections (objects + child collections) of the active scene's background set chain. */
export function backgroundSetRoots(doc: DocumentData): { objects: ID[]; children: ID[] }[] {
  const out: { objects: ID[]; children: ID[] }[] = [];
  const seen = new Set<ID>([doc.scene.id ?? '']);
  let id = doc.scene.background_set ?? null;
  while (id && !seen.has(id) && out.length < 16) {
    seen.add(id);
    const sc = doc.scenes?.[id];
    if (!sc?.master_collection) break;
    out.push(sc.master_collection);
    id = sc.background_set ?? null;
  }
  return out;
}

declare module '../data/types' {
  interface SceneData {
    /** scene shown behind this one (its objects render but can't be selected) */
    background_set?: ID | null;
  }
}
