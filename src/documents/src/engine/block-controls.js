import { controlContentSignature, contentControlRanges } from './content-controls.js';

// Determine ownership from the pre-edit ranges, before replacement strips
// temporary inline metadata. Every change touching an ancestor must be inside
// a nested inline control for that ancestor to survive the transaction.
export function inlineEditAncestors(paragraphs, edits) {
  const inline = contentControlRanges(paragraphs), groups = blockControlGroups(paragraphs).sort((a,b) => a.start - b.start);
  const touched = new Set(), outside = new Set(), active = new Map(); let next = 0;
  // Text replacements are disjoint. Sweep block intervals once instead of
  // checking every control against every match and every inline control.
  for (const edit of [...edits].sort((a,b) => a.start - b.start)) {
    for (const [id, group] of active) if (group.end <= edit.start) active.delete(id);
    while (next < groups.length && (edit.start === edit.end ? groups[next].start <= edit.start : groups[next].start < edit.end)) {
      const group = groups[next++]; if (group.end > edit.start) active.set(group.control.id, group);
    }
    let lo = 0, hi = inline.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (inline[mid].start <= edit.start) lo = mid + 1; else hi = mid; }
    const range = inline[lo - 1];
    const inside = range && edit.end <= range.end && (edit.end > edit.start || edit.start > range.start && edit.start < range.end);
    const ancestors = new Set(inside ? range.paragraph.blockControls?.map(c => c.id) : []);
    for (const id of active.keys()) { touched.add(id); if (!ancestors.has(id)) outside.add(id); }
  }
  return new Set([...touched].filter(id => !outside.has(id)));
}

export function blockControlGroups(paragraphs) {
  const groups = new Map(); let offset = 0;
  for (const paragraph of paragraphs) {
    const length = paragraph.runs.reduce((n, r) => n + r.text.length, 0);
    for (const control of paragraph.blockControls || []) {
      let group = groups.get(control.id);
      if (!group) {
        group = { control, paragraphs: [], start: offset, end: offset, contiguous: true };
        groups.set(control.id, group);
      } else if (group.end + 1 !== offset) group.contiguous = false;
      group.paragraphs.push(paragraph); group.end = offset + length;
    }
    offset += length + 1;
  }
  return [...groups.values()];
}

export function blockControlSignature(paragraphs, control) {
  // The nearest temporary wrapper owns the edit. Enclosing
  // temporary wrappers stay intact when a nested temporary wrapper is removed.
  // A digest, not the text: each paragraph inside keeps the control, so a signature holding every
  // paragraph's text grew with the square of the control's length (8,000 paragraphs ran out of memory).
  return digest(JSON.stringify(paragraphs.filter(p => p.blockControls?.at(-1)?.id === control.id).map(p => [p.id, p.cellId, controlContentSignature(p.runs)])));
}
// Two independent 32-bit FNV-1a style hashes and the length: equal contents give equal digests, and
// different contents practically never collide.
function digest(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; }
  return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

export function changedBlockControls(paragraphs, tables = [], groups = blockControlGroups(paragraphs)) {
  const present = new Set(groups.map(g => g.control.id));
  const changed = new Set(groups.filter(g => !g.contiguous || !g.control.persistent && g.control.signature !== blockControlSignature(g.paragraphs, g.control)).map(g => g.control.id));
  for (const table of tables) for (const control of table.blockControls || []) if (!present.has(control.id)) changed.add(control.id);
  return changed;
}

// Structural cell moves preserve an intact wrapper. Temporary wrappers require
// unchanged paragraph IDs/contents; persistent wrappers also survive prior edits.
// Ordinary text and formatting edits do not need this structural scan.
export function rehomeMovedBlockControls(paragraphs) {
  for (const group of blockControlGroups(paragraphs)) {
    const { control } = group, cellId = group.paragraphs[0].cellId;
    if (control.scope == null || control.scope === cellId || !cellId || !group.contiguous || group.paragraphs.some(p => p.cellId !== cellId)) continue;
    const originalOwner = group.paragraphs.map(p => ({ ...p, cellId: control.scope }));
    if (!control.persistent && control.signature !== blockControlSignature(originalOwner, control)) continue;
    const signature = blockControlSignature(group.paragraphs, control);
    for (const p of group.paragraphs) for (const item of p.blockControls || []) if (item.id === control.id) { item.scope = cellId; item.signature = signature; }
  }
}

// A merge converts each persistent cell wrapper to a block wrapper.
// Its original paragraphs stay owned; content from neighbors must not be
// absorbed. The serializer replaces sdtContent, so the property shell survives.
export function mergeCellControls(paragraphs, cells, owner) {
  for (const group of blockControlGroups(paragraphs)) {
    const { control } = group;
    if (!control.persistent || control.kind !== 'cell' || !cells.has(control.scope)) continue;
    const signature = blockControlSignature(group.paragraphs, control);
    for (const p of group.paragraphs) for (const item of p.blockControls || []) if (item.id === control.id) {
      item.kind = 'block'; item.scope = owner; item.signature = signature;
    }
  }
}

export function unwrapChangedBlockControls(paragraphs, tables, preserved = new Set()) {
  const groups = blockControlGroups(paragraphs);
  if (groups.some(g => g.control.persistent && !g.contiguous)) throw new Error('This edit would divide a persistent block content control.');
  const changed = changedBlockControls(paragraphs, tables, groups);
  for (const group of groups) if (group.control.persistent && group.control.placeholder && group.control.signature !== blockControlSignature(group.paragraphs, group.control)) {
    for (const p of group.paragraphs) for (const control of p.blockControls || []) if (control.id === group.control.id) control.placeholder = false;
  }
  for (const id of preserved) changed.delete(id);
  if (!changed.size && !preserved.size) return;
  for (const item of [...paragraphs, ...tables]) if (item.blockControls) {
    item.blockControls = item.blockControls.filter(c => !changed.has(c.id));
    if (!item.blockControls.length) delete item.blockControls;
  }
  // Contents exposed by removal of an inner wrapper now belong to its parent.
  const signatures = new Map(blockControlGroups(paragraphs).map(group => [group.control.id, blockControlSignature(group.paragraphs, group.control)]));
  for (const item of [...paragraphs, ...tables]) for (const control of item.blockControls || []) control.signature = signatures.get(control.id);
}


// Plan boundary changes before mutation. Outer paragraph marks are retained for
// multi-paragraph controls, but a surviving single paragraph becomes inline.
// Nested controls and scoped markers need their own ownership conversion.
export function persistentBlockBoundary(paragraphs, start, end, text = '', groups = blockControlGroups(paragraphs)) {
  if (start === end) return;
  const crossings = groups.filter(g => g.control.persistent &&
    end >= g.start && start <= g.end && !(g.start <= start && end <= g.end) &&
    !(start <= g.start && end > g.end));
  if (!crossings.length) return;
  const fail = () => { throw new Error('Editing across this persistent block control boundary is not supported yet.'); };
  if (crossings.length !== 1) return fail();
  const g = crossings[0], side = start < g.start ? 'start' : 'end';
  if (g.control.placeholder && (side === 'start' ? end > g.start && end < g.end : start > g.start && start < g.end))
    throw new Error('Cannot partially replace a placeholder across its content control boundary.');
  const emptied = side === 'start' && end === g.end;
  if (emptied && g.control.placeholderBookmarks?.some(markers => markers.length)) return fail();
  if (g.control.kind === 'cell' || g.control.plainText || g.control.placeholderParagraphs?.length > 1 ||
      g.paragraphs.some(p => p.blockControls.length !== 1 || p.bookmarks?.length || p.fieldMarkers?.length || p.runs.some(r => r.contentControl))) return fail();
  // Crossing deeper internal paragraph boundaries needs additional native
  // ownership evidence.
  const firstLength = g.paragraphs[0].runs.reduce((n,r) => n+r.text.length,0);
  const lastLength = g.paragraphs.at(-1).runs.reduce((n,r) => n+r.text.length,0);
  if (!emptied && (side === 'start' ? end > g.start + firstLength : start < g.end - lastLength)) return fail();
  return { ...g, side, keepBlock: !emptied && g.paragraphs.length > 1 };
}

export function persistentBlockReplacement(paragraphs, start, end, boundaryId, allGroups = blockControlGroups(paragraphs)) {
  const groups = allGroups.filter(g => g.control.persistent);
  for (const g of groups) {
    if (start === end || end < g.start || start > g.end) continue;
    const inside = g.start <= start && end <= g.end;
    const covers = start <= g.start && end > g.end;
    if (!inside && !covers && g.control.id !== boundaryId) throw new Error('Editing across a persistent block control boundary is not supported yet.');
  }
  return groups.filter(g => g.start <= start && end <= g.end).at(-1);
}
