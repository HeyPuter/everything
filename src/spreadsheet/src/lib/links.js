/**
 * The app's own addresses. Documents open at #/edit/<path>; adding
 * ?range=Sheet!A1:B9 opens the file with those cells selected, which is what
 * "Copy link to this range" hands out. #/file/<uid> opens a file by its id,
 * which is what a shared spreadsheet's link hands out: the people it is shared
 * with reach it at an address of their own, not at the owner's path; with
 * ?range= it opens at those cells (a comment's link in a mention email).
 */

import { quoteSheet } from '../core/refs.js';
import { rangeName } from '../core/cell.js';
import { parseLiveHash } from '../collab/protocol.js';

/** The route a location hash names: { route: 'home' | 'new' | 'sample' | 'template' | 'edit' | 'file' | 'live', path?, id?, range?, server?, room?, token? }. */
export function parseAppHash(hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const base = q >= 0 ? h.slice(0, q) : h;
  const params = new URLSearchParams(q >= 0 ? h.slice(q + 1) : '');
  try {
    // Opening the app lands in a new sheet; the list has its own address.
    if (base === '' || base === 'new') return { route: 'new' };
    if (base === 'home') return { route: 'home' };
    if (base.startsWith('edit/')) {
      const path = decodeURIComponent(base.slice(5));
      // "#/edit/" names no file; like any other address that opens nothing, it lands on the list.
      if (path) return { route: 'edit', path, range: params.get('range') || null };
    }
    if (base === 'sample') return { route: 'sample' };
    if (base.startsWith('template/')) return { route: 'template', id: decodeURIComponent(base.slice(9)) };
    // A shared workbook: #/live/<room>?server=…&invite=… (see collab/protocol.js).
    if (base.startsWith('live/')) {
      const live = parseLiveHash(h.startsWith('#') ? h : `#/${h}`);
      if (live) return { route: 'live', ...live };
    }
    if (base.startsWith('file/')) {
      const id = decodeURIComponent(base.slice(5));
      if (id) return { route: 'file', id, range: params.get('range') || null };
    }
  } catch { /* An incomplete or malformed encoded address falls back to the home screen. */ }
  return { route: 'home' };
}

/** The hash that opens a file, optionally at a "Sheet!A1:B2" range. */
export function editHash(path, range = null) {
  return `#/edit/${encodeURIComponent(path)}${range ? `?range=${encodeURIComponent(range)}` : ''}`;
}

/** A full address that opens `path` with the range on `sheetName` selected. */
export function rangeLink({ origin, pathname }, path, sheetName, range) {
  return `${origin}${pathname}${editHash(path, `${quoteSheet(sheetName)}!${rangeName(range)}`)}`;
}

/**
 * A full address that opens the file with this id, wherever the drive of whoever follows it shows it; with
 * `range` ("Sheet1!B4"), at those cells.
 */
export function fileLink({ origin, pathname }, uid, range = null) {
  return `${origin}${pathname}#/file/${encodeURIComponent(uid)}${range ? `?range=${encodeURIComponent(range)}` : ''}`;
}
