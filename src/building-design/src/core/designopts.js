/**
 * Design options: alternatives for part of the design (two entrance
 * canopies, three kitchen layouts) explored side by side in one project.
 *
 *   optionSet     { name }
 *   designOption  { setId, name, primary }   one primary option per set
 *   el.optionId   the option an element belongs to (missing: the main model)
 *   view.designOptions { [setId]: optionId }  what a view shows (default: primary)
 *
 * While an option is being edited, every view shows it, and new elements go
 * into it.
 */
import { categoryOf, CATEGORIES } from './catalog.js';
import { isView } from './doc.js';

let editing = null;

/** The option being edited (application state, not part of the document). */
export function setEditingOption(id) {
  editing = id || null;
}

export function editingOption() {
  return editing;
}

export function optionSets(doc) {
  return doc.all('optionSet');
}

export function optionsOf(doc, setId) {
  return doc.all('designOption').filter((o) => o.setId === setId);
}

export function primaryOf(doc, setId) {
  const list = optionsOf(doc, setId);
  return list.find((o) => o.primary) || list[0] || null;
}

/** Elements that can belong to an option: model elements, not datums or views. */
export function optionable(doc, el) {
  if (!el || el.viewId || isView(el) || el.kind === 'level' || el.kind === 'grid' || el.kind === 'link') return false;
  const cat = categoryOf(el, doc);
  return MODEL_CATS.has(cat) || el.kind === 'room';
}

const MODEL_CATS = new Set(CATEGORIES.filter((c) => c.model).map((c) => c.id));

/** The option of a set that a view shows. */
export function shownOption(doc, view, setId) {
  const ed = doc.get(editing);
  if (ed?.setId === setId) return ed.id;
  const chosen = doc.get(view?.designOptions?.[setId]);
  if (chosen?.kind === 'designOption' && chosen.setId === setId) return chosen.id;
  return primaryOf(doc, setId)?.id ?? null;
}

export function hiddenByOption(doc, view, el) {
  if (!el?.optionId) return false;
  const o = doc.get(el.optionId);
  if (o?.kind !== 'designOption') return false;
  return shownOption(doc, view, o.setId) !== o.id;
}

export function optionLabel(doc, id) {
  const o = doc.get(id);
  if (o?.kind !== 'designOption') return 'Main Model';
  const set = doc.get(o.setId);
  return `${set?.name ?? 'Set'}: ${o.name}${o.primary ? ' (primary)' : ''}`;
}

export function newOptionSet(doc, name) {
  const set = doc.add({ kind: 'optionSet', name });
  const opt = doc.add({ kind: 'designOption', setId: set.id, name: 'Option 1', primary: true });
  return { set, opt };
}

export function makePrimary(doc, id) {
  const o = doc.get(id);
  for (const x of optionsOf(doc, o.setId)) if (!!x.primary !== (x.id === id)) doc.update(x.id, { primary: x.id === id });
}

/** Delete an option and its elements. */
export function deleteOption(doc, id) {
  const o = doc.get(id);
  for (const el of doc.filter((x) => x.optionId === id)) doc.remove(el.id);
  doc.remove(id);
  const rest = optionsOf(doc, o.setId);
  if (rest.length && !rest.some((x) => x.primary)) doc.update(rest[0].id, { primary: true });
  if (!rest.length) doc.remove(o.setId);
}

/** Keep the primary option as part of the main model; delete the set's other options. */
export function acceptPrimary(doc, setId) {
  const primary = primaryOf(doc, setId);
  for (const o of optionsOf(doc, setId)) {
    if (o.id === primary?.id) continue;
    for (const el of doc.filter((x) => x.optionId === o.id)) doc.remove(el.id);
    doc.remove(o.id);
  }
  if (primary) {
    for (const el of doc.filter((x) => x.optionId === primary.id)) doc.update(el.id, { optionId: null });
    doc.remove(primary.id);
  }
  for (const v of doc.filter((x) => x.designOptions && setId in x.designOptions)) {
    const next = { ...v.designOptions };
    delete next[setId];
    doc.update(v.id, { designOptions: next });
  }
  doc.remove(setId);
}
