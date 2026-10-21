/**
 * Worksets: named groups of model elements that a team divides a project
 * into (shell, interiors, site...). Each view decides which worksets it
 * shows; new elements go into the active workset of whoever draws them.
 *
 *   workset        { name, visibleByDefault, shared? }  shared: levels and grids
 *   el.worksetId   the element's workset (missing: the first user workset)
 *   view.worksets  { [worksetId]: boolean }  per-view visibility overrides
 */
import { categoryOf } from './catalog.js';
import { isView } from './doc.js';

export const DATUM_KINDS = new Set(['level', 'grid', 'refPlane']);

export const WORKSET_COLORS = ['#2f80ed', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#00a3a3', '#c4a000', '#d6336c', '#5c7cfa', '#8d6e63'];

export function worksharingOn(doc) {
  return doc.count('workset') > 0;
}

export function worksets(doc) {
  return doc.all('workset');
}

/** Elements that belong to worksets: model elements and datums, not view-specific items. */
export function worksetable(doc, el) {
  if (!el || el.viewId || isView(el)) return false;
  if (DATUM_KINDS.has(el.kind)) return true;
  return !!categoryOf(el, doc) && !!el.levelId;
}

export function defaultWorkset(doc) {
  const all = worksets(doc);
  return all.find((w) => !w.shared) || all[0] || null;
}

export function worksetOf(doc, el) {
  const w = doc.get(el.worksetId);
  if (w?.kind === 'workset') return w;
  if (DATUM_KINDS.has(el.kind)) return worksets(doc).find((x) => x.shared) || defaultWorkset(doc);
  return defaultWorkset(doc);
}

/** Is the element hidden because its workset is turned off in the view? */
export function hiddenByWorkset(doc, view, el) {
  if (!view || !worksharingOn(doc) || !worksetable(doc, el)) return false;
  const w = worksetOf(doc, el);
  if (!w) return false;
  const v = view.worksets?.[w.id];
  return v === undefined ? w.visibleByDefault === false : !v;
}

export function worksetColor(doc, id) {
  const i = worksets(doc).findIndex((w) => w.id === id);
  return WORKSET_COLORS[(i < 0 ? 0 : i) % WORKSET_COLORS.length];
}

/** Turn on worksets: datums go to a shared workset, everything else to the first one. */
export function enableWorksharing(doc, firstName = 'Workset1') {
  if (worksharingOn(doc)) return;
  const shared = doc.add({ kind: 'workset', name: 'Shared Levels and Grids', visibleByDefault: true, shared: true });
  const first = doc.add({ kind: 'workset', name: firstName, visibleByDefault: true });
  for (const el of [...doc.items.values()]) if (worksetable(doc, el)) doc.update(el.id, { worksetId: DATUM_KINDS.has(el.kind) ? shared.id : first.id });
}

/** Remove a workset, moving its elements to another one. */
export function deleteWorkset(doc, id, moveTo) {
  for (const el of [...doc.items.values()]) if (el.worksetId === id) doc.update(el.id, { worksetId: moveTo });
  for (const v of doc.filter((x) => x.worksets && id in x.worksets)) {
    const next = { ...v.worksets };
    delete next[id];
    doc.update(v.id, { worksets: next });
  }
  doc.remove(id);
}
