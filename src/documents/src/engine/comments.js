// Original comment model. A comment's anchor is a pair of zero-width markers
// kept beside bookmark markers in `paragraph.bookmarks` (flagged `comment`), so
// every edit that moves bookmarks moves comment ranges the same way. The
// comment bodies live in `model.comments`, outside the text position space.
// Marker ids are prefixed so they never collide with bookmark ids.
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);

export const isCommentMarker = marker => !!marker?.comment;
export const commentMarker = (commentId, edge, offset, order) => ({ id: `comment:${commentId}`, commentId, comment: true, edge, offset, order, bodyOrder: order });

/** Comment anchors as { id, start, end } absolute positions, in document order. */
export function commentAnchors(paragraphs) {
  const found = new Map(); let at = 0;
  for (const p of paragraphs) {
    for (const marker of p.bookmarks || []) {
      if (!marker.comment) continue;
      const entry = found.get(marker.commentId) || { id: marker.commentId };
      const position = at + Math.min(marker.offset, length(p));
      if (marker.edge === 'start') entry.start = position; else entry.end = position;
      found.set(marker.commentId, entry);
    }
    at += length(p) + 1;
  }
  const anchors = [];
  for (const entry of found.values()) {
    if (entry.start === undefined && entry.end === undefined) continue;
    entry.start ??= entry.end; entry.end ??= entry.start;
    if (entry.end < entry.start) [entry.start, entry.end] = [entry.end, entry.start];
    anchors.push(entry);
  }
  return anchors.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The next unused numeric comment identifier, from `floor` up. */
export function nextCommentId(comments, floor = 0) {
  const used = new Set(comments.map(c => c.id)); let id = floor;
  while (used.has(String(id))) id++;
  return String(id);
}

/** The next marker order after every bookmark and comment marker. */
function nextOrder(paragraphs) {
  return paragraphs.reduce((n, p) => (p.bookmarks || []).reduce((m, marker) => Math.max(m, marker.order ?? -1, marker.bodyOrder ?? -1), n), -1) + 1;
}

/** Locate an absolute position as { index, offset } (a separator belongs to the earlier paragraph). */
function locateIn(paragraphs, position) {
  let at = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const size = length(paragraphs[index]);
    if (position <= at + size || index === paragraphs.length - 1) return { index, offset: Math.max(0, Math.min(position - at, size)) };
    at += size + 1;
  }
  return { index: 0, offset: 0 };
}

/** Insert start/end markers for comment `id` around [start, end]. */
export function addCommentMarkers(paragraphs, id, start, end) {
  const order = nextOrder(paragraphs);
  const first = locateIn(paragraphs, start), last = locateIn(paragraphs, end);
  (paragraphs[first.index].bookmarks ||= []).push(commentMarker(id, 'start', first.offset, order));
  (paragraphs[last.index].bookmarks ||= []).push(commentMarker(id, 'end', last.offset, order + 1));
}

/** Remove every marker of the given comment identifiers. */
export function removeCommentMarkers(paragraphs, ids) {
  const gone = new Set(ids);
  for (const p of paragraphs) if (p.bookmarks?.some(m => m.comment && gone.has(m.commentId))) {
    p.bookmarks = p.bookmarks.filter(m => !(m.comment && gone.has(m.commentId)));
    if (!p.bookmarks.length) delete p.bookmarks;
  }
}

/** A comment and all of its replies, depth first. */
export function commentThread(comments, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const c of comments) if (c.parentId === ids[i] && !ids.includes(c.id)) ids.push(c.id);
  return ids;
}

/** Initials for a display name: the first letter of each word. */
export function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return '';
  return (words.length === 1 ? [...words[0]].slice(0, 2).join('') : words.slice(0, 3).map(w => [...w][0]).join('')).toLocaleUpperCase();
}

/** Validate comment text: plain paragraphs separated by line feeds. */
export function checkedCommentText(text) {
  if (typeof text !== 'string') throw new Error('Comment text must be text.');
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  if (clean.length > 32000) throw new Error('Comments can hold up to 32,000 characters.');
  return clean;
}
