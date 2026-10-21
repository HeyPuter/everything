/**
 * Revisions: a numbered list of changes issued with the drawings. Revision
 * clouds mark what changed in a view; a sheet's title block lists every
 * revision clouded on the sheet or in the views placed on it.
 *
 *   revision { seq, number, date, description, issuedTo, issuedBy, issued }
 */

export function newRevision(doc) {
  const seq = doc.all('revision').reduce((m, r) => Math.max(m, +r.seq || 0), 0) + 1;
  return { kind: 'revision', seq, number: String(seq), date: new Date().toISOString().slice(0, 10), description: `Revision ${seq}`, issuedTo: '', issuedBy: '', issued: false };
}

export function revisionsInOrder(doc) {
  return doc.all('revision').sort((a, b) => (+a.seq || 0) - (+b.seq || 0));
}

/** Revisions clouded on a sheet or in the views placed on it, in order. */
export function revisionsOnSheet(doc, sheet) {
  const views = new Set([sheet.id]);
  for (const vp of doc.all('viewport')) if (vp.viewId === sheet.id) views.add(vp.placedId);
  const ids = new Set();
  for (const c of doc.all('revisionCloud')) if (views.has(c.viewId) && c.revisionId) ids.add(c.revisionId);
  return revisionsInOrder(doc).filter((r) => ids.has(r.id));
}
