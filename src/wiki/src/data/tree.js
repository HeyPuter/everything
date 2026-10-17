/**
 * The page tree of one space, kept in the space's tree document:
 *
 *   pages: Y.Map<pageId, Y.Map>   one entry per page, with
 *     title, icon {name, color} | null, cover {color} | {asset} | null,
 *     parent (page id or null for the top level), order (fractional key),
 *     kind ('page' | 'database'), row (true for database rows),
 *     created, createdBy, updated, updatedBy, trashed (time) | null,
 *     fullWidth, smallText, locked
 *
 * Trashing marks only the page that was trashed; everything under it is
 * hidden with it and comes back when it is restored.
 */
import { Y, local } from './ydoc.js';
import { uid } from '../lib/ids.js';
import { keyBetween, compareOrder } from '../lib/order.js';

export const PAGE_FIELDS = ['title', 'icon', 'cover', 'parent', 'order', 'kind', 'row', 'created', 'createdBy', 'updated', 'updatedBy', 'trashed', 'trashedBy', 'fullWidth', 'smallText', 'locked'];

export function pagesOf(doc) {
  return doc.getMap('pages');
}

/** A plain snapshot of one page entry, or null. */
export function getPage(doc, id) {
  const m = pagesOf(doc).get(id);
  if (!(m instanceof Y.Map)) return null;
  const out = { id };
  for (const f of PAGE_FIELDS) {
    const v = m.get(f);
    if (v !== undefined) out[f] = v;
  }
  out.title ??= '';
  out.parent ??= null;
  out.kind ??= 'page';
  return out;
}

/**
 * Every page, and children by parent in order, derived from the tree and
 * rebuilt after each change instead of on every query. Reads made while a
 * transaction is open skip it, so they see the writes made so far.
 */
const indexes = new WeakMap();

function index(doc) {
  let st = indexes.get(doc);
  if (!st) {
    st = { built: null };
    // Every change runs in a transaction, and each one starts with this.
    doc.on('beforeTransaction', () => {
      st.built = null;
    });
    indexes.set(doc, st);
  }
  // Yjs sets _transaction while one is open (this may be the first read, so
  // no event said so); an index built then would miss the rest of it.
  if (doc._transaction) return buildIndex(doc);
  return (st.built ||= buildIndex(doc));
}

function buildIndex(doc) {
  const all = [];
  const children = new Map();
  for (const id of pagesOf(doc).keys()) {
    const p = getPage(doc, id);
    if (!p) continue;
    Object.freeze(p);
    all.push(p);
    const key = p.parent ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  for (const list of children.values()) list.sort(compareOrder);
  return { all, children };
}

/** Every page (shared, read-only snapshots). */
export function allPages(doc) {
  return index(doc).all.slice();
}

export function hasPage(doc, id) {
  return pagesOf(doc).get(id) instanceof Y.Map;
}

/** Children of a page (or of the top level), in order. */
export function childrenOf(doc, parent = null, { trashed = false, rows = false } = {}) {
  return (index(doc).children.get(parent) || []).filter((p) => (trashed || !p.trashed) && (rows || !p.row));
}

/** Pages from the top level down to this one (inclusive). */
export function ancestors(doc, id) {
  const chain = [];
  const seen = new Set();
  let p = getPage(doc, id);
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    chain.unshift(p);
    p = p.parent ? getPage(doc, p.parent) : null;
  }
  return chain;
}

/** This page and every page under it, rows included. */
export function descendants(doc, id) {
  const { children } = index(doc);
  const out = [];
  const stack = [id];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const c of children.get(cur) || []) stack.push(c.id);
  }
  return out;
}

/** Whether a page or any page above it is in the trash. */
export function isTrashed(doc, id) {
  return ancestors(doc, id).some((p) => p.trashed);
}

/** Pages that were trashed directly (their subpages go with them). */
export function trashedPages(doc) {
  return allPages(doc)
    .filter((p) => p.trashed && !(p.parent && isTrashed(doc, p.parent)))
    .sort((a, b) => b.trashed - a.trashed);
}

function orderAt(doc, parent, { before = null, after = null } = {}) {
  const sibs = childrenOf(doc, parent, { rows: true });
  let lo = '';
  let hi = '';
  if (after) {
    const i = sibs.findIndex((p) => p.id === after);
    if (i >= 0) {
      lo = sibs[i].order || '';
      hi = sibs[i + 1]?.order || '';
    }
  } else if (before) {
    const i = sibs.findIndex((p) => p.id === before);
    if (i >= 0) {
      hi = sibs[i].order || '';
      lo = sibs[i - 1]?.order || '';
    }
  } else {
    lo = sibs.at(-1)?.order || '';
  }
  if (lo && hi && lo >= hi) hi = '';
  return keyBetween(lo, hi);
}

/** Adds a page. Returns its id. */
export function addPage(doc, { id = uid(), parent = null, title = '', kind = 'page', icon = null, row = false, before = null, after = null, by = null, extra = {} } = {}) {
  // Read before the transaction opens, while the tree index is current.
  const order = orderAt(doc, parent, { before, after });
  local(doc, () => {
    const m = new Y.Map();
    const now = Date.now();
    const fields = { title, icon, cover: null, parent, order, kind, created: now, createdBy: by, updated: now, updatedBy: by, trashed: null, ...extra };
    if (row) fields.row = true;
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    pagesOf(doc).set(id, m);
  });
  return id;
}

/** Changes fields of a page; stamps who changed it and when. */
export function updatePage(doc, id, patch, by = null) {
  const m = pagesOf(doc).get(id);
  if (!(m instanceof Y.Map)) return false;
  local(doc, () => {
    for (const [k, v] of Object.entries(patch)) {
      if (!PAGE_FIELDS.includes(k)) continue;
      if (m.get(k) !== v) m.set(k, v);
    }
    m.set('updated', Date.now());
    if (by) m.set('updatedBy', by);
  });
  return true;
}

/** Marks a page as edited (its content changed). */
export function touchPage(doc, id, by = null) {
  const m = pagesOf(doc).get(id);
  if (!(m instanceof Y.Map)) return;
  local(doc, () => {
    m.set('updated', Date.now());
    if (by) m.set('updatedBy', by);
  });
}

/** Whether moving page id under target would put it inside itself. */
export function wouldCycle(doc, id, target) {
  if (!target) return false;
  return ancestors(doc, target).some((p) => p.id === id);
}

/** Moves a page under a new parent, before or after a sibling (or last). */
export function movePage(doc, id, parent = null, { before = null, after = null } = {}) {
  if (!hasPage(doc, id) || id === parent || wouldCycle(doc, id, parent)) return false;
  if (parent && !hasPage(doc, parent)) return false;
  const m = pagesOf(doc).get(id);
  const order = orderAt(doc, parent, { before: before === id ? null : before, after: after === id ? null : after });
  local(doc, () => {
    m.set('parent', parent);
    m.set('order', order);
  });
  return true;
}

export function trashPage(doc, id, by = null) {
  const m = pagesOf(doc).get(id);
  if (!(m instanceof Y.Map)) return false;
  local(doc, () => {
    m.set('trashed', Date.now());
    m.set('trashedBy', by);
  });
  return true;
}

/** Restores a trashed page; it moves to the top level if its parent is gone. */
export function restorePage(doc, id) {
  const m = pagesOf(doc).get(id);
  if (!(m instanceof Y.Map)) return false;
  local(doc, () => {
    m.set('trashed', null);
    const parent = m.get('parent');
    if (parent && (!hasPage(doc, parent) || isTrashed(doc, parent))) {
      m.set('parent', null);
      m.set('order', orderAt(doc, null));
    }
  });
  return true;
}

/** Deletes a page and everything under it for good. Returns the deleted ids. */
export function deletePage(doc, id) {
  const ids = descendants(doc, id);
  local(doc, () => {
    for (const d of ids) pagesOf(doc).delete(d);
  });
  return ids;
}

/** The plain text a page is known by. */
export function displayTitle(page) {
  return (page?.title || '').trim() || 'Untitled';
}
