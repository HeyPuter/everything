import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';

/**
 * Compress Pictures replaces pictures with smaller copies. Saving keeps every package part it did not
 * change, so the media a compressed picture no longer uses would otherwise stay in the file. For the
 * parts Compress released (and only those), drop relationships nothing references any more and then
 * the part itself, with its content-type override. A part still used anywhere is kept.
 */
const decode = bytes => typeof bytes === 'string' ? bytes
  : new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8').decode(bytes);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sourceOf(relsPath) {
  const match = /^(.*?)_rels\/([^/]+)\.rels$/.exec(relsPath);
  return match ? `${match[1]}${match[2]}` : null;
}
function resolve(sourcePart, target) {
  try { return decodeURIComponent(new URL(target, `https://docx.invalid/${sourcePart}`).pathname).slice(1); } catch { return null; }
}

export function pruneReleasedMedia(parts, released) {
  if (!released?.size) return;
  for (const path of released) {
    if (!parts[path]) continue;
    let used = false;
    for (const relsPath of Object.keys(parts).filter(p => p.endsWith('.rels'))) {
      const source = sourceOf(relsPath);
      if (source === null) continue;
      let rels;
      // Relationships that cannot be read might use the part: keep it.
      try { rels = parseXml(parts[relsPath]); } catch { used = true; continue; }
      let changed = false;
      for (const rel of [...rels.documentElement.children].filter(n => n.localName === 'Relationship')) {
        if (rel.getAttribute('TargetMode') === 'External' || resolve(source || '', rel.getAttribute('Target')) !== path) continue;
        const xml = parts[source] ? decode(parts[source]) : '';
        // Any attribute holding the id, in either quote style, counts as a use.
        if (new RegExp(`=\\s*(["'])${escape(rel.getAttribute('Id'))}\\1`).test(xml)) { used = true; continue; }
        rel.remove(); changed = true;
      }
      if (changed) parts[relsPath] = strToU8(new XMLSerializer().serializeToString(rels));
    }
    if (used) continue;
    delete parts[path];
    const types = parseXml(parts['[Content_Types].xml']);
    for (const node of [...types.documentElement.children]) if (node.localName === 'Override' && node.getAttribute('PartName') === `/${path}`) node.remove();
    parts['[Content_Types].xml'] = strToU8(new XMLSerializer().serializeToString(types));
  }
}

/*
 * Parts a removed drawing leaves. Saving keeps every package part it did not change, so a chart or picture the
 * user deleted, or replaced (Edit Chart Data writes a new chart part; Reset Picture shows the original again),
 * would otherwise stay in the file with its data: the chart part, its embedded workbook and its color and style
 * parts. For each story part this save rewrote, a picture or chart relationship its original XML used and its
 * new XML no longer does is removed (OPC, ECMA-376 Part 2 §9.3); then each part no relationship targets any more
 * goes, with its own relationships, the parts only it used, and their content-type overrides (§10.1.2.3).
 * Relationships the original XML never used, and parts anything else still targets, are kept as they were.
 * The saved copy is pruned; the package keeps its parts, so Undo after a save brings a drawing back whole.
 */
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_RELATIONSHIPS = new Set([`${R}/image`, `${R}/chart`, 'http://schemas.microsoft.com/office/2014/relationships/chartEx', 'http://schemas.microsoft.com/office/2007/relationships/hdphoto']);
const relationshipsOf = path => { const at = path.lastIndexOf('/'); return `${path.slice(0, at + 1)}_rels/${path.slice(at + 1)}.rels`; };
const serializeXml = doc => strToU8(new XMLSerializer().serializeToString(doc));
/*
 * Which of `ids` a part's text uses: an id is used when some piece of the text between quote marks equals it
 * (allowing spaces around it), so every attribute holding it counts, and a piece of text that happens to equal an
 * id only keeps a part. One pass over the quote marks that stops once every id is found; only pieces as short as
 * an id are compared, so a save of a long story part stays cheap. An original part's answers are kept per id.
 */
const originalUses = new WeakMap();
function usedIds(bytes, ids, cache = false) {
  const known = cache && typeof bytes === 'object' ? originalUses.get(bytes) || new Map() : null;
  if (known && !originalUses.has(bytes)) originalUses.set(bytes, known);
  const used = new Set(), left = new Set();
  for (const id of ids) { if (known?.has(id)) { if (known.get(id)) used.add(id); } else left.add(id); }
  if (left.size) {
    let min = Infinity, max = 0;
    for (const id of left) { min = Math.min(min, id.length); max = Math.max(max, id.length); }
    const text = decode(bytes), quote = /["']/g, space = c => c === 32 || c === 9 || c === 10 || c === 13;
    const found = new Set();
    let prev = -1, match;
    while (found.size < left.size && (match = quote.exec(text))) {
      const at = match.index, length = at - prev - 1;
      if (length >= min && length <= 256 && (length <= max || space(text.charCodeAt(prev + 1)) || space(text.charCodeAt(at - 1)))) {
        const piece = text.slice(prev + 1, at), id = left.has(piece) ? piece : left.has(piece.trim()) ? piece.trim() : null;
        if (id !== null) found.add(id);
      }
      prev = at;
    }
    for (const id of left) { const yes = found.has(id); if (yes) used.add(id); known?.set(id, yes); }
  }
  return used;
}
// The picture and chart relationships of a relationship part, read once per version of its bytes.
const drawingLists = new WeakMap();
function drawingRelationships(bytes) {
  if (typeof bytes === 'object' && drawingLists.has(bytes)) return drawingLists.get(bytes);
  const list = [...parseXml(bytes).documentElement.children]
    .filter(n => n.localName === 'Relationship' && n.getAttribute('Id') && n.getAttribute('TargetMode') !== 'External' && DRAWING_RELATIONSHIPS.has(n.getAttribute('Type')))
    .map(n => n.getAttribute('Id'));
  if (typeof bytes === 'object') drawingLists.set(bytes, list);
  return list;
}

export function pruneDroppedParts(parts, original) {
  const keyOf = path => { if (!path) return null; if (Object.hasOwn(parts, path)) return path; const lower = path.toLowerCase(); return Object.keys(parts).find(k => k.toLowerCase() === lower) || null; };
  const dropped = new Set();
  for (const relsPath of Object.keys(parts)) {
    if (!relsPath.endsWith('.rels')) continue;
    const source = sourceOf(relsPath);
    if (!source || !parts[source] || !original[source] || parts[source] === original[source]) continue;
    let ids;
    try { ids = drawingRelationships(parts[relsPath]); } catch { continue; }
    // An id with characters XML escapes is kept rather than matched against its escaped form.
    ids = ids.filter(id => !/[&<>"']/.test(id));
    if (!ids.length) continue;
    let gone;
    try { const before = usedIds(original[source], ids, true), after = usedIds(parts[source], before); gone = new Set([...before].filter(id => !after.has(id))); } catch { continue; }
    if (!gone.size) continue;
    const rels = parseXml(parts[relsPath]);
    for (const rel of [...rels.documentElement.children]) {
      if (rel.localName !== 'Relationship' || !gone.has(rel.getAttribute('Id'))) continue;
      rel.remove();
      const target = keyOf(resolve(source, rel.getAttribute('Target')));
      if (target) dropped.add(target);
    }
    parts[relsPath] = serializeXml(rels);
  }
  if (!dropped.size) return;
  // The internal targets of every relationship part left, read once; a part leaving takes its own with it.
  const targets = new Map();
  for (const relsPath of Object.keys(parts)) {
    if (!relsPath.endsWith('.rels')) continue;
    const source = sourceOf(relsPath);
    let rels;
    // Relationships that cannot be read might target anything: keep every part.
    try { rels = parseXml(parts[relsPath]); } catch { return; }
    targets.set(relsPath, [...rels.documentElement.children].filter(n => n.localName === 'Relationship' && n.getAttribute('TargetMode') !== 'External')
      .map(n => resolve(source || '', n.getAttribute('Target'))?.toLowerCase()).filter(Boolean));
  }
  const targeted = path => { const lower = path.toLowerCase(); for (const list of targets.values()) if (list.includes(lower)) return true; return false; };
  const removed = [], queue = [...dropped];
  while (queue.length) {
    const path = keyOf(queue.shift());
    if (!path || path.endsWith('.rels') || path === '[Content_Types].xml' || targeted(path)) continue;
    const own = keyOf(relationshipsOf(path));
    if (own) { queue.push(...(targets.get(own) || [])); targets.delete(own); delete parts[own]; }
    delete parts[path]; removed.push(path);
  }
  if (!removed.length) return;
  const names = new Set(removed.map(path => `/${path}`.toLowerCase()));
  const types = parseXml(parts['[Content_Types].xml']);
  for (const node of [...types.documentElement.children]) if (node.localName === 'Override' && names.has((node.getAttribute('PartName') || '').toLowerCase())) node.remove();
  parts['[Content_Types].xml'] = serializeXml(types);
}
