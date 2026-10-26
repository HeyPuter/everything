// Space ops for books: element edits are path writes; whole-page replacements carry the page version.
import { orderKeys } from '../../shared/order.js';
import { SINGLE_KINDS } from './constants.js';
import { stored } from './model.js';

const SINGLE_ORDER = 'V';
const elementPath = (eid, field) => (field ? `els.${eid}.${field}` : `els.${eid}`);

/** Page fields from `{layout, els, bg}`; empty parts are left out. */
export function pageFields(book, kind, order, { layout, els, bg } = {}) {
  const clean = Object.fromEntries(Object.entries(els ?? {}).map(([eid, item]) => [eid, stored(item)]));
  return { book, kind, order, ...(layout ? { layout } : {}), ...(bg ? { bg } : {}), ...(Object.keys(clean).length ? { els: clean } : {}) };
}

/** Creates a book with its single pages and `spreads` (`[{layout, els}]`). `singles` maps a kind to `{layout, els}`. */
export function createBookOps(ops, fields, { singles = {}, spreads = [] } = {}) {
  const create = ops.create('book', fields);
  const list = [create];
  for (const kind of SINGLE_KINDS) list.push(ops.create('bookPage', pageFields(create.id, kind, SINGLE_ORDER, singles[kind])));
  orderKeys(spreads.length).forEach((order, index) => list.push(ops.create('bookPage', pageFields(create.id, 'spread', order, spreads[index]))));
  return { id: create.id, ops: list };
}

/** Missing single pages of a book, recreated empty. */
export const singleOps = (ops, book, kinds) => kinds.map((kind) => ops.create('bookPage', pageFields(book, kind, SINGLE_ORDER)));

/** Field changes on one element: `undefined` removes a field. */
export function elementChange(ops, pageId, eid, changes) {
  const set = {};
  const unset = [];
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) unset.push(elementPath(eid, field));
    else set[elementPath(eid, field)] = value;
  }
  return ops.patch('bookPage', pageId, { set, unset });
}

/** Several elements' field changes on one page in one op: `{<eid>: {field: value}}`. */
export function elementsChange(ops, pageId, changes) {
  const set = {};
  const unset = [];
  for (const [eid, fields] of Object.entries(changes)) {
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) unset.push(elementPath(eid, field));
      else set[elementPath(eid, field)] = value;
    }
  }
  return ops.patch('bookPage', pageId, { set, unset });
}

export const addElements = (ops, pageId, els) => ops.patch('bookPage', pageId, {
  set: Object.fromEntries(Object.entries(els).map(([eid, item]) => [elementPath(eid), stored(item)])),
});
export const removeElements = (ops, pageId, ids) => ops.patch('bookPage', pageId, { unset: ids.map((eid) => elementPath(eid)) });

/** Replaces a page's elements (and layout); with `base` a concurrent edit parks a conflict instead of being lost. */
export function replacePage(ops, pageId, { layout, els, bg }, { base = true } = {}) {
  const clean = Object.fromEntries(Object.entries(els ?? {}).map(([eid, item]) => [eid, stored(item)]));
  const set = {};
  const unset = [];
  if (Object.keys(clean).length) set.els = clean; else unset.push('els');
  if (layout) set.layout = layout; else unset.push('layout');
  if (bg !== undefined) { if (bg) set.bg = bg; else unset.push('bg'); }
  return ops.patch('bookPage', pageId, { set, unset }, { base });
}

/** The same ops without `base`, for undo history (a redo is a plain edit). */
export const withoutBase = (list) => list.map(({ base: _base, ...op }) => op);
