// Restoring a saved version into an open document (a document edited together restores in place, as one
// change). The version's body is read from its own package: pictures, charts, drawings and objects keep the
// relationship ids of that package (ECMA-376 Part 2 §9.3), and note references the notes of that package.
// Written into the open document's package, an id it lacks, or one that names another part there, leaves a
// broken or different picture, and a note reference with no note.
import { relationshipEntries, relatedPartPath } from './docx-relationships.js';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAIN_RELS = 'word/_rels/document.xml.rels';
// Relationship ids an object's retained XML names (r:embed, r:link, r:id, r:pict and a diagram's parts), and the
// ids the image model keeps beside it.
const REFERENCES = [/:(?:embed|link|id|pict|dm|lo|qs|cs)=\\"([^"\\]+)\\"/g, /"(?:relId|fallbackRelId)":"([^"\\]+)"/g];

const sameBytes = (a, b) => a === b || !!a && !!b && a.length === b.length && a.every((byte, i) => byte === b[i]);
function relationships(parts) {
  const out = new Map();
  try { for (const n of parts[MAIN_RELS] ? relationshipEntries(parts[MAIN_RELS]) : []) if (n.namespaceURI === REL && n.localName === 'Relationship') out.set(n.attribute('Id'), n); }
  catch { /* An unreadable relationships part names nothing. */ }
  return out;
}
function partPath(target) {
  const path = [];
  for (const segment of (target.startsWith('/') ? target.slice(1) : `word/${target}`).split('/')) {
    if (segment === '..') path.pop(); else if (segment && segment !== '.') path.push(segment);
  }
  return path.join('/');
}
const relsOf = path => path.replace(/([^/]+)$/, '_rels/$1.rels');

/** Whether the relationship `id` of package `from` means the same in package `to`: its type and target, and an internal target's bytes and relationships. */
function sameRelationship(id, from, to) {
  const a = from.rels.get(id), b = to.rels.get(id);
  if (!a || !b) return false;
  for (const name of ['Type', 'Target', 'TargetMode']) if ((a.attribute(name) || '') !== (b.attribute(name) || '')) return false;
  if (a.attribute('TargetMode') === 'External') return true;
  const path = partPath(a.attribute('Target') || '');
  return sameBytes(from.parts[path], to.parts[path]) && sameBytes(from.parts[relsOf(path)], to.parts[relsOf(path)]);
}

/**
 * What of the body of package `version` (its paragraphs and tables) would not mean the same written into package
 * `current`: { relationships: ids of objects whose parts differ or are missing there, notes: whether it has note
 * references and the notes differ }. Hyperlinks are written from their targets, so they always carry over.
 */
export function unportableContent(version, current) {
  const from = { rels: relationships(version.parts || {}), parts: version.parts || {} }, to = { rels: relationships(current.parts || {}), parts: current.parts || {} };
  const ids = new Set();
  let notes = false;
  const visit = run => {
    if (run.noteMark) notes = true;
    if (!run.image && !run.vml && !run.math && !run.field && !run.bodySymbol) return;
    const { link, ...content } = run, text = JSON.stringify(content);
    for (const pattern of REFERENCES) for (const match of text.matchAll(pattern)) if (from.rels.has(match[1])) ids.add(match[1]);
  };
  for (const p of version.paragraphs || []) for (const run of p.runs) visit(run);
  const relationshipsOut = [...ids].filter(id => !sameRelationship(id, from, to));
  const notesDiffer = notes && ['footnotes', 'endnotes'].some(kind => {
    let a = null, b = null;
    try { a = relatedPartPath(version.parts || {}, kind); } catch { return true; }
    try { b = relatedPartPath(current.parts || {}, kind); } catch { return true; }
    return a !== b || !sameBytes(a && version.parts[a], b && current.parts[b]);
  });
  return relationshipsOut.length || notesDiffer ? { relationships: relationshipsOut, notes: notesDiffer } : null;
}
