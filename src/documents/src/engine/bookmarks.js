// Original zero-width bookmark model. Offsets are local to their paragraph;
// marker order breaks ties without imposing XML-style nesting on overlapping ranges.
import { columnBookmarkResolver, ColumnBookmarkRangeError } from './column-bookmarks.js';
import { rowGrid } from './tables.js';
export const sortedBookmarks = p => [...(p.bookmarks || [])].sort((a, b) => a.offset - b.offset || a.order - b.order);
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
const sameTableBoundary = (a, b) => a === b || !!a && !!b && a.tableId === b.tableId && a.rowId === b.rowId && a.cellId === b.cellId && a.side === b.side && a.beforeProperties === b.beforeProperties;

// A preview caller can exclude invalid IDs without rewriting source markers or
// discarding unrelated ranges. Editing callers retain strict validation.
export function bookmarkEntries(paragraphs, tables, onInvalid) {
  const entries = [], starts = new Map(), ends = new Set(); let at = 0;
  const invalid = new Set();
  const reject = (id, message) => {
    const error = new Error(message);
    if (!onInvalid) throw error;
    if (!invalid.has(id)) { invalid.add(id); onInvalid(id, error); }
  };
  for (const p of paragraphs) {
    const size = length(p);
    for (const marker of sortedBookmarks(p)) {
      if (marker.comment || marker.perm || invalid.has(marker.id)) continue;
      const limit = size + (marker.blockBoundary === 'after' ? 1 : 0);
      if (!Number.isInteger(marker.offset) || marker.offset < 0 || marker.offset > limit) { reject(marker.id, 'Invalid bookmark position.'); continue; }
      if (marker.edge === 'start') {
        if (starts.has(marker.id)) { reject(marker.id, 'Duplicate bookmark identifier.'); continue; }
        const entry = { id: marker.id, name: marker.name, start: at + marker.offset, startParagraph: p.id, startMarker: marker };
        starts.set(marker.id, entry); entries.push(entry);
      } else {
        const entry = starts.get(marker.id);
        if (!entry || ends.has(marker.id)) { reject(marker.id, 'A bookmark end must follow one matching start.'); continue; }
        ends.add(marker.id); Object.assign(entry, { end: at + marker.offset, endParagraph: p.id, endMarker: marker });
      }
    }
    at += size + 1;
  }
  for (const entry of entries) if (entry.end === undefined) reject(entry.id, 'A bookmark start is missing its end.');
  let resolve;
  if (tables) for (const entry of entries) if (!invalid.has(entry.id) && entry.startMarker.tableColumns && (entry.start !== entry.end || entry.startParagraph !== entry.endParagraph)) {
    try {
      const range = (resolve ||= columnBookmarkResolver(paragraphs, tables))(entry);
      if (range) entry.columnRange = range;
    } catch (error) {
      if (!(error instanceof ColumnBookmarkRangeError)) throw error;
      reject(entry.id, error.message);
    }
  }
  return entries.filter(entry => !invalid.has(entry.id));
}

export function checkedBookmarkName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name)) throw new Error('Use 1–40 letters, numbers or underscores, starting with a letter or underscore.');
  return name;
}

export function newBookmarkMarkers(paragraphs, name) {
  checkedBookmarkName(name);
  const entries = bookmarkEntries(paragraphs);
  if (entries.some(e => e.name === name)) throw new Error('A bookmark with that name already exists.');
  const ids = new Set(entries.map(e => e.id)); let id = 0;
  while (ids.has(String(id))) id++;
  const order = paragraphs.reduce((n, p) => (p.bookmarks || []).reduce((n, m) => Math.max(n, m.order), n), -1) + 1;
  return [{ id: String(id), edge: 'start', name, order }, { id: String(id), edge: 'end', order: order + 1 }];
}

// Update only the replaced paragraphs; surviving paragraphs retain both their
// source marker XML and IDs. At an insertion boundary, text stays outside ranges.
export function replaceBookmarkMarkers(oldParagraphs, replacements, start, end, inserted, discardedControl, discardContained = false) {
  const markers = []; let at = 0;
  for (const p of oldParagraphs) { for (const marker of p.bookmarks || []) markers.push({ ...marker, offset: at + marker.offset }); at += length(p) + 1; }
  if (!markers.length) { for (const p of replacements) delete p.bookmarks; return; }
  const starts = new Map(markers.filter(m => m.edge === 'start').map(m => [m.id, m.offset]));
  const pointIds = new Set(markers.filter(m => m.edge === 'end' && starts.get(m.id) === m.offset).map(m => m.id));
  const owned = discardedControl || discardContained ? new Set(markers.filter(m => discardContained || m.contentControlId === discardedControl).map(m => m.id)) : null;
  const discarded = owned ? new Set(markers.filter(m => m.edge === 'end' && owned.has(m.id) && starts.get(m.id) >= start && m.offset <= end).map(m => m.id)) : null;
  for (const p of replacements) delete p.bookmarks;
  for (const marker of markers) {
    if (discarded?.has(marker.id)) continue;
    let pos = marker.offset;
    // A replaced placeholder is discarded content. Its internal endpoints do
    // not capture the inserted value; bookmarks extending outside it survive.
    if (discardedControl && marker.contentControlId === discardedControl && pos >= start && pos <= end) pos = marker.edge === 'start' ? end : start;
    if (start === end) {
      // Editing permissions grow with text typed at either edge; bookmarks keep it outside.
      if (pos > start || pos === start && (marker.perm ? marker.edge === 'end' : marker.edge === 'start' || pointIds.has(marker.id))) pos += inserted;
    } else if (pos >= end) pos += inserted - (end - start);
    else if (pos > start) pos = start + (pointIds.has(marker.id) || marker.edge === 'end' ? inserted : 0);
    // A paragraph separator belongs to the preceding paragraph's end position.
    let index = 0;
    while (index < replacements.length - 1 && pos > length(replacements[index])) pos -= length(replacements[index++]) + 1;
    const size = length(replacements[index]);
    marker.offset = Math.max(0, Math.min(pos, size + (marker.blockBoundary === 'after' && pos === size + 1 ? 1 : 0)));
    if (!(marker.blockBoundary === 'before' && marker.offset === 0 || marker.blockBoundary === 'after' && marker.offset === size + 1)) { delete marker.blockBoundary; delete marker.blockTableId; delete marker.tableBoundary; }
    (replacements[index].bookmarks ||= []).push(marker);
  }
}

export function bookmarkStructureState(paragraphs, tables = []) {
  return { paragraphIds: paragraphs.map(p => p.id), tableRows: tables.map(t => ({ id: t.id, rows: t.rows.map(r => ({ id: r.id, cells: r.cells.map(c => c.id) })) })), entries: bookmarkEntries(paragraphs, tables).map(e => {
    const first = paragraphs.findIndex(p => p.id === e.startParagraph), last = paragraphs.findIndex(p => p.id === e.endParagraph);
    return { ...structuredClone(e), segments: paragraphs.slice(first, last + 1).map(p => ({ id: p.id, start: p.id === e.startParagraph ? e.startMarker.offset : 0, end: p.id === e.endParagraph ? e.endMarker.offset : length(p) })) };
  }) };
}

// Cell merges move paragraphs without replacing their text. Cell-owned markers
// follow that content; markers enclosing a whole table retain their outer scope.
export function normalizeBlockBookmarkScopes(paragraphs, tables) {
  const tableIds = new Set(tables.map(table => table.id)); let resolve;
  for (const p of paragraphs) for (const marker of p.bookmarks || []) {
    if (!marker.blockBoundary) continue;
    if (marker.blockTableId && tableIds.has(marker.blockTableId)) continue;
    const boundary = marker.tableBoundary && (resolve ||= tableBookmarkResolver(paragraphs, tables))(marker.tableBoundary);
    if (boundary?.paragraph === p && boundary.offset === marker.offset) continue;
    delete marker.tableBoundary;
    delete marker.blockTableId;
    marker.blockScope = p.cellId || null;
  }
}

// Table/row markers retain a structural boundary as well as an editable text
// position. Continuation cells contribute no editable paragraphs, so a boundary
// there shares the nearest preceding text position without moving its XML scope.
function bookmarkCellContent(paragraphs, tables) {
  const content = new Map(), parents = new Map();
  for (const table of tables) if (table.parentCellId) for (const row of table.rows) for (const cell of row.cells) parents.set(cell.id, table.parentCellId);
  for (const p of paragraphs) if (p.cellId) {
    // A nested paragraph contributes to each enclosing cell's text extent.
    // Keep the source order and guard malformed ownership from cycling.
    let id = p.cellId, depth = 0;
    while (id) {
      if (depth++ > tables.length) throw new Error('Cyclic table bookmark ownership.');
      const cell = content.get(id);
      if (cell) cell.last = p; else content.set(id, { first: p, last: p });
      id = parents.get(id);
    }
  }
  return content;
}

export function tableBookmarkResolver(paragraphs, tables) {
  const content = bookmarkCellContent(paragraphs, tables), positions = new Map();
  for (const table of tables) {
    const cells = table.rows.flatMap(row => row.cells);
    const first = content.get(cells.find(cell => content.has(cell.id))?.id)?.first;
    if (!first) continue;
    let previous;
    const position = scope => ({ paragraph: previous || first, offset: previous ? length(previous) + 1 : 0, blockBoundary: previous ? 'after' : 'before', blockScope: scope });
    const rows = new Map(); positions.set(table.id, rows);
    for (const row of table.rows) {
      const entry = { before: position(table.id), cells: new Map() }; rows.set(row.id, entry);
      for (const cell of row.cells) {
        const before = position(row.id);
        previous = content.get(cell.id)?.last || previous;
        entry.cells.set(cell.id, { before, after: position(row.id) });
      }
      entry.after = position(table.id);
    }
  }
  return boundary => {
    const row = positions.get(boundary.tableId)?.get(boundary.rowId);
    return (boundary.cellId ? row?.cells.get(boundary.cellId) : row)?.[boundary.side] || null;
  };
}

// Deleting a structural neighbor leaves its boundary beside the closest
// surviving sibling, including when that sibling is an empty continuation.
function tableBoundaryRebaser(tables, oldTables = []) {
  const current = new Map(tables.map(t => [t.id, new Map(t.rows.map(r => [r.id, new Set(r.cells.map(c => c.id))]))]));
  const old = new Map(oldTables.map(t => [t.id, { ids: t.rows.map(r => r.id), rows: new Map(t.rows.map(r => [r.id, r.cells])) }]));
  const insertionEdges = new WeakMap();
  const afterInsertion = (ids, previous, id) => {
    let edges = insertionEdges.get(ids);
    if (!edges) {
      edges = new Map(); insertionEdges.set(ids, edges);
      const existing = new Set(previous); let inserted;
      // A boundary stays immediately before the original following content.
      // Cache the last inserted sibling after each old one in a single pass.
      for (const currentId of [...ids.keys()].reverse()) {
        if (existing.has(currentId)) {
          if (inserted) edges.set(currentId, inserted);
          inserted = undefined;
        } else inserted ??= currentId;
      }
    }
    return edges.get(id);
  };
  const neighbor = (ids, previous, id, side) => {
    const cut = previous.indexOf(id) + (side === 'after' ? 1 : 0);
    const before = previous.slice(0, cut).findLast(id => ids.has(id));
    const after = previous.slice(cut).find(id => ids.has(id));
    return before ? { id: before, side: 'after' } : after ? { id: after, side: 'before' } : null;
  };
  return boundary => {
    const rows = current.get(boundary.tableId), source = old.get(boundary.tableId);
    if (!rows || !source) return boundary;
    const cells = rows.get(boundary.rowId);
    if (!cells) {
      const next = neighbor(rows, source.ids, boundary.rowId, boundary.side);
      return next ? { tableId: boundary.tableId, rowId: next.id, side: next.side } : boundary;
    }
    if (boundary.cellId && !cells.has(boundary.cellId)) {
      const next = neighbor(cells, source.rows.get(boundary.rowId), boundary.cellId, boundary.side);
      if (next) return { ...boundary, cellId: next.id, side: next.side };
    }
    if (boundary.side === 'after') {
      const next = boundary.cellId ? afterInsertion(cells, source.rows.get(boundary.rowId), boundary.cellId) : afterInsertion(rows, source.ids, boundary.rowId);
      if (next) return { ...boundary, [boundary.cellId ? 'cellId' : 'rowId']: next };
    }
    return boundary;
  };
}

// Bookmarks follow surviving content when cells move or disappear. A discontiguous
// result becomes the smallest contiguous range enclosing that content.
export function repairStructuralBookmarks(paragraphs, state, tables = [], changedTableId) {
  const present = new Map();
  for (const p of paragraphs) for (const m of p.bookmarks || []) present.set(`${m.id}:${m.edge}`, { p, m });
  const indices = new Map(paragraphs.map((p, i) => [p.id, i]));
  const oldIndices = new Map((state.paragraphIds || []).map((id, i) => [id, i]));
  // Prefix/suffix extrema detect moved content at each edge in constant time.
  const prefixMax = [-Infinity], suffixMin = []; suffixMin[paragraphs.length] = Infinity;
  for (const p of paragraphs) prefixMax.push(Math.max(prefixMax.at(-1), oldIndices.get(p.id) ?? -Infinity));
  for (let i = paragraphs.length - 1; i >= 0; i--) suffixMin[i] = Math.min(suffixMin[i + 1], oldIndices.get(paragraphs[i].id) ?? Infinity);
  let resolve, rebase, cellContents;
  for (const entry of state.entries) {
    if (entry.columnRange) {
      if (!changedTableId || entry.columnRange.tableId === changedTableId || !present.has(`${entry.id}:start`) || !present.has(`${entry.id}:end`))
        repairColumnBookmark(paragraphs, tables, state, entry, present);
      continue;
    }
    let first, last, firstIndex = Infinity, lastIndex = -Infinity;
    for (const segment of entry.segments) {
      const index = indices.get(segment.id);
      if (index < firstIndex) { first = segment; firstIndex = index; }
      if (index > lastIndex) { last = segment; lastIndex = index; }
    }
    if (!first) continue;
    for (const edge of ['start', 'end']) {
      const segment = edge === 'start' ? first : last;
      let p = paragraphs[indices.get(segment.id)], offset = segment[edge];
      let marker = entry[edge + 'Marker'];
      const table = marker.blockTableId && tables.find(t => t.id === marker.blockTableId);
      if (marker.tableBoundary) {
        const next = (rebase ||= tableBoundaryRebaser(tables, state.tableRows))(marker.tableBoundary);
        if (next !== marker.tableBoundary) marker = { ...marker, tableBoundary: next };
      }
      if (table) {
        cellContents ||= bookmarkCellContent(paragraphs, tables);
        const contents = table.rows.flatMap(row => row.cells.map(cell => cellContents.get(cell.id))).filter(Boolean);
        p = marker.blockBoundary === 'before' ? contents[0].first : contents.at(-1).last;
        offset = marker.blockBoundary === 'before' ? 0 : length(p) + 1;
      }
      let boundary = marker.tableBoundary && (resolve ||= tableBookmarkResolver(paragraphs, tables))(marker.tableBoundary);
      // A merge can move existing content across a physical row/cell edge.
      // Preserve the text range in that case; inserted cells alone can extend
      // the structural edge because their new paragraphs have no old side.
      const oldCut = oldIndices.get(entry[edge + 'Paragraph']) + (marker.blockBoundary === 'after' ? 1 : 0);
      const newCut = boundary && indices.get(boundary.paragraph.id) + (boundary.blockBoundary === 'after' ? 1 : 0);
      const crossed = boundary && (prefixMax[newCut] >= oldCut || suffixMin[newCut] < oldCut);
      if (crossed) boundary = null;
      if (boundary) { p = boundary.paragraph; offset = boundary.offset; }
      const old = present.get(`${entry.id}:${edge}`);
      if (!crossed && old?.p === p && old.m.offset === offset && (!boundary || old.m.blockBoundary === boundary.blockBoundary) && sameTableBoundary(old.m.tableBoundary, marker.tableBoundary)) continue;
      if (old) old.p.bookmarks = old.p.bookmarks.filter(m => m !== old.m);
      const next = { ...marker, offset, ...(boundary ? { blockBoundary: boundary.blockBoundary, blockScope: boundary.blockScope } : {}) };
      if (crossed) delete next.tableBoundary;
      (p.bookmarks ||= []).push(next);
    }
  }
}

function repairColumnBookmark(paragraphs, tables, state, entry, present) {
  const range = entry.columnRange, table = tables.find(t => t.id === range.tableId);
  const remove = () => {
    for (const edge of ['start', 'end']) {
      const old = present.get(`${entry.id}:${edge}`);
      if (old) old.p.bookmarks = old.p.bookmarks.filter(m => m !== old.m);
    }
  };
  if (!table) { remove(); return; }
  const rowIds = new Set(range.rowIds);
  if (state.insertedRow?.tableId === table.id && rowIds.has(state.insertedRow.after)) rowIds.add(state.insertedRow.id);
  const rows = table.rows.filter(row => rowIds.has(row.id));
  if (!rows.length) { remove(); return; }
  let first = range.first, end = range.end;
  const edit = state.gridEdit;
  if (edit?.tableId === table.id) {
    const rebase = value => value >= edit.position + edit.removed ? value + edit.inserted - edit.removed : Math.min(value, edit.position);
    first = rebase(first); end = rebase(end);
  }
  if (first >= end && !range.empty) { remove(); return; }
  const firstGrid = rowGrid(rows[0]), covered = firstGrid.filter(c => c.column < end && c.end > first);
  if (!covered.length && !range.empty) { remove(); return; }
  const columns = range.empty ? entry.startMarker.tableColumns : { first: String(covered[0].index), last: String(covered.at(-1).index) };
  const content = bookmarkCellContent(paragraphs, tables);
  const boundaryResolver = tableBookmarkResolver(paragraphs, tables);
  remove();
  for (const edge of ['start', 'end']) {
    const row = edge === 'start' ? rows[0] : rows.at(-1), cell = edge === 'start' ? row.cells[0] : row.cells.at(-1);
    const cellContent = content.get(cell.id);
    const p = cellContent?.[edge === 'start' ? 'first' : 'last'];
    const marker = { ...entry[edge + 'Marker'] };
    for (const key of ['linkId', 'blockTableId', 'tableBoundary', 'contentControlId', 'blockControls']) delete marker[key];
    if (edge === 'start') marker.tableColumns = columns;
    if (p) {
      marker.offset = edge === 'start' ? 0 : length(p) + 1;
      marker.blockBoundary = edge === 'start' ? 'before' : 'after';
      marker.blockScope = cell.id;
      if (p.blockControls) marker.blockControls = p.blockControls;
      (p.bookmarks ||= []).push(marker);
    } else {
      marker.tableBoundary = { tableId: table.id, rowId: row.id, side: edge === 'start' ? 'before' : 'after' };
      const at = boundaryResolver(marker.tableBoundary);
      if (!at) throw new Error('A column bookmark endpoint has no table boundary.');
      Object.assign(marker, { offset: at.offset, blockBoundary: at.blockBoundary, blockScope: at.blockScope });
      (at.paragraph.bookmarks ||= []).push(marker);
    }
  }
}

// Split runs only for XML emission, never for layout/shaping. Markers may sit
// inside hyperlink wrappers and never occupy a text or picture position.
export function bookmarkInlineEvents(p, fieldMarkers = [], proofMarkers = []) {
  const bookmarks = sortedBookmarks(p).filter(m => !(m.blockBoundary === 'before' && m.offset === 0 || m.blockBoundary === 'after' && m.offset === length(p) + 1));
  const annotations = fieldMarkers.length || proofMarkers.length;
  const markers = annotations ? [...bookmarks.map(marker=>({offset:marker.offset,order:marker.bodyOrder??marker.order,marker})), ...fieldMarkers.map(fieldMarker=>({offset:fieldMarker.offset,order:fieldMarker.order,fieldMarker})), ...proofMarkers.map(proofMarker=>({offset:proofMarker.offset,order:proofMarker.order,proofMarker}))].sort((a,b)=>a.offset-b.offset || (a.order??0)-(b.order??0)) : bookmarks, events = []; let at = 0, index = 0;
  const markerEvent = marker => !annotations ? { marker } : marker.proofMarker ? { proofMarker: marker.proofMarker } : marker.fieldMarker ? { fieldMarker: marker.fieldMarker } : { marker: marker.marker };
  for (const run of p.runs) {
    const end = at + run.text.length; let from = at;
    while (index < markers.length && markers[index].offset <= end) {
      const marker = markers[index++];
      if (marker.offset > from) events.push({ run: { ...run, text: run.text.slice(from - at, marker.offset - at) } });
      events.push(markerEvent(marker)); from = marker.offset;
    }
    if (from < end) events.push({ run: { ...run, text: run.text.slice(from - at) } });
    else if (!run.text && run.contentControl) events.push({ run });
    at = end;
  }
  while (index < markers.length) { events.push(markerEvent(markers[index++])); }
  return events;
}
