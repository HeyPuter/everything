// Page order: spreads sit between the first and last page by fractional `order`; single pages never move.
import { orderBetween, orderKeys } from '../../shared/order.js';
import { BOOK_LIMITS } from './constants.js';

const keyOf = (page) => page?.order ?? null;

/** The `order` that puts a spread at `to` among `spreads` (book order) after removing it from `from`. */
export function moveOrder(spreads, from, to) {
  if (from === to || from < 0 || from >= spreads.length) return null;
  const rest = spreads.filter((_, index) => index !== from);
  const index = Math.max(0, Math.min(rest.length, to));
  return between(keyOf(rest[index - 1]), keyOf(rest[index]));
}

/** `count` order keys for new spreads inserted at `index` (0 = right after the first page). */
export function insertOrders(spreads, index, count = 1) {
  const at = Math.max(0, Math.min(spreads.length, index));
  return keysBetween(count, keyOf(spreads[at - 1]), keyOf(spreads[at]));
}

/** Room left for spreads in a book. */
export const spreadRoom = (spreads) => Math.max(0, BOOK_LIMITS.spreads - spreads.length);

// Two members moving spreads at once can leave equal or crossed keys; fall back to keys after the left one.
function between(left, right) {
  if (left !== null && right !== null && left >= right) return orderBetween(left, null);
  return orderBetween(left, right);
}
function keysBetween(count, left, right) {
  if (left !== null && right !== null && left >= right) return orderKeys(count, left, null);
  return orderKeys(count, left, right);
}

/** A spread copied with fresh element ids, for "Duplicate". */
export function duplicateFields(page, { makeId, order }) {
  const els = Object.fromEntries(Object.values(page.els ?? {}).map((item) => [makeId(), structuredClone(item)]));
  return { book: page.book, kind: page.kind, order, ...(page.layout ? { layout: page.layout } : {}), ...(page.bg ? { bg: page.bg } : {}), ...(Object.keys(els).length ? { els } : {}) };
}

/** Index of the spread a sheet index points to, or -1 for single pages. */
export function spreadIndex(shape, sheetIndex) {
  const page = shape.sheets[sheetIndex]?.page;
  return page?.kind === 'spread' ? shape.spreads.findIndex((item) => item.id === page.id) : -1;
}
