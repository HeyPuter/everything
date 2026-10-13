// Adding and removing editing-permission ranges (§17.13.6) as undoable model edits.
import { permissionMarker } from './docx-permissions.js';
import { permissionRanges, nextPermissionId } from './protection.js';

const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
function locate(paragraphs, position) {
  let at = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const size = length(paragraphs[index]);
    if (position <= at + size || index === paragraphs.length - 1) return { index, offset: Math.max(0, Math.min(position - at, size)) };
    at += size + 1;
  }
  return { index: 0, offset: 0 };
}
const order = paragraphs => paragraphs.reduce((n, p) => (p.bookmarks || []).reduce((m, marker) => Math.max(m, marker.order ?? -1, marker.bodyOrder ?? -1), n), -1) + 1;

/** Add a range [start, end] that `editor` (a name or e-mail) or a group ('everyone') may edit. Returns its id. */
export function addPermissionRange(model, start, end, { ed = null, edGrp = null } = {}) {
  if (!ed && !edGrp) throw new Error('Choose who may edit this part.');
  const existing = permissionRanges(model.paragraphs).find(r => r.start === start && r.end === end && (r.ed || null) === (ed || null) && (r.edGrp || null) === (edGrp || null));
  if (existing) return existing.id;
  model.checkpoint();
  const id = nextPermissionId(model.paragraphs), n = order(model.paragraphs);
  const first = locate(model.paragraphs, start), last = locate(model.paragraphs, end);
  (model.paragraphs[first.index].bookmarks ||= []).push(permissionMarker(id, 'start', first.offset, n, { ed, edGrp }));
  (model.paragraphs[last.index].bookmarks ||= []).push(permissionMarker(id, 'end', last.offset, n + 1));
  model.didChange();
  return id;
}

/** Remove the ranges whose ids are given; returns the count removed. */
export function removePermissionRanges(model, ids) {
  const gone = new Set(ids.map(String));
  if (!model.paragraphs.some(p => p.bookmarks?.some(m => m.perm && gone.has(m.permId)))) return 0;
  model.checkpoint();
  for (const p of model.paragraphs) if (p.bookmarks?.some(m => m.perm && gone.has(m.permId))) {
    p.bookmarks = p.bookmarks.filter(m => !(m.perm && gone.has(m.permId)));
    if (!p.bookmarks.length) delete p.bookmarks;
  }
  model.didChange();
  return gone.size;
}
