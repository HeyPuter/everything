// Comments part (ECMA-376 Part 1 §17.13.4) and the [MS-DOCX] commentsExtended
// companion for replies and resolved state. Bodies are read as plain
// paragraphs; an unchanged comment keeps its original XML when saved.
import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';
import { UnsupportedDocumentError } from './errors.js';
import { commentMarker } from './comments.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const W16CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
const W16CEX = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
export const COMMENTS_EXTENDED_REL = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended';
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENTS_EXTENDED_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml';
const serialize = node => new XMLSerializer().serializeToString(node);
const elements = node => [...(node?.children || [])];
const wChildren = (node, name) => elements(node).filter(n => n.namespaceURI === W && n.localName === name);

function paragraphText(p) {
  let text = '';
  const walk = node => {
    for (const n of elements(node)) {
      if (n.namespaceURI !== W) { walk(n); continue; }
      if (['pPr', 'rPr', 'delText', 'instrText', 'annotationRef', 'del', 'moveFrom'].includes(n.localName)) continue;
      if (n.localName === 't') text += n.textContent;
      else if (n.localName === 'tab') text += '\t';
      else if (n.localName === 'br' || n.localName === 'cr') text += '\n';
      else if (n.localName === 'noBreakHyphen') text += '‑';
      else walk(n);
    }
  };
  walk(p);
  return text;
}

/** Comments in the package as plain records, or [] when it has none. */
export function readComments(parts) {
  const path = relatedPartPath(parts, 'comments', COMMENTS_REL);
  if (!path) return [];
  const root = parseXml(parts[path]).documentElement;
  if (root.namespaceURI !== W || root.localName !== 'comments') throw new UnsupportedDocumentError('an invalid comments part');
  let extended = new Map();
  try {
    const extPath = relatedPartPath(parts, 'commentsExtended', COMMENTS_EXTENDED_REL);
    if (extPath) for (const ex of parseXml(parts[extPath]).getElementsByTagNameNS(W15, 'commentEx')) {
      const paraId = ex.getAttributeNS(W15, 'paraId');
      if (paraId) extended.set(paraId.toUpperCase(), { parent: ex.getAttributeNS(W15, 'paraIdParent')?.toUpperCase() || null, done: ['1', 'true', 'on'].includes(ex.getAttributeNS(W15, 'done') || '') });
    }
  } catch { extended = new Map(); } // Replies and resolved state are optional companions.
  const comments = [], byPara = new Map(), seen = new Set();
  for (const node of wChildren(root, 'comment')) {
    const raw = node.getAttributeNS(W, 'id');
    if (!/^[+-]?\d+$/.test(raw || '')) throw new UnsupportedDocumentError('an invalid comment identifier');
    const id = BigInt(raw).toString();
    if (seen.has(id)) throw new UnsupportedDocumentError('duplicate comment identifiers');
    seen.add(id);
    const paragraphs = elements(node).filter(n => n.namespaceURI === W && n.localName === 'p');
    const text = paragraphs.map(paragraphText).join('\n');
    const paraId = paragraphs.at(-1)?.getAttributeNS(W14, 'paraId')?.toUpperCase() || null;
    const comment = { id, author: node.getAttributeNS(W, 'author') || '', initials: node.getAttributeNS(W, 'initials') || '', date: node.getAttributeNS(W, 'date') || '', text, done: false, parentId: null, paraId, sourceId: id, sourceText: text };
    if (paraId) byPara.set(paraId, comment);
    comments.push(comment);
  }
  for (const comment of comments) {
    const ex = comment.paraId && extended.get(comment.paraId);
    if (!ex) continue;
    comment.done = ex.done;
    const parent = ex.parent && byPara.get(ex.parent);
    if (parent && parent !== comment) comment.parentId = parent.id;
  }
  return comments;
}

/** A new random paragraph identifier below 0x80000000, as §w14:paraId requires. */
export function newParaId(used = new Set()) {
  let id;
  do id = Math.floor(Math.random() * 0x7fffffff).toString(16).toUpperCase().padStart(8, '0');
  while (used.has(id) || id === '00000000');
  used.add(id);
  return id;
}

function ensureRelationship(parts, path, type, contentType) {
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parseXml(parts[relPath] || `<Relationships xmlns="${REL}"/>`);
  const links = elements(rels.documentElement).filter(n => n.getAttribute('Type') === type);
  if (!links.length) {
    const ids = new Set(elements(rels.documentElement).map(n => n.getAttribute('Id')));
    let n = 1; while (ids.has(`rId${n}`)) n++;
    const link = rels.createElementNS(REL, 'Relationship');
    link.setAttribute('Id', `rId${n}`); link.setAttribute('Type', type); link.setAttribute('Target', path.replace(/^word\//, ''));
    rels.documentElement.append(link);
    parts[relPath] = strToU8(serialize(rels));
  }
  const types = parseXml(parts['[Content_Types].xml']);
  if (!elements(types.documentElement).some(n => n.localName === 'Override' && n.getAttribute('PartName') === '/' + path)) {
    const override = types.createElementNS(types.documentElement.namespaceURI || CT, 'Override');
    override.setAttribute('PartName', '/' + path); override.setAttribute('ContentType', contentType);
    types.documentElement.append(override);
    parts['[Content_Types].xml'] = strToU8(serialize(types));
  }
}

const unchanged = c => c.sourceId !== undefined && c.text === c.sourceText;
const write = (parts, path, doc) => { parts[path] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"')); };

/**
 * Write `comments` into the package parts. `initial` is the JSON of the comments as opened;
 * when nothing changed the source parts stay byte-for-byte untouched.
 */
export function writeComments(parts, comments = [], initial = '[]') {
  if (JSON.stringify(comments) === initial) return;
  let path = null;
  try { path = relatedPartPath(parts, 'comments', COMMENTS_REL); } catch { path = null; }
  if (!path && !comments.length) return;
  path ||= 'word/comments.xml';
  const doc = parts[path] ? parseXml(parts[path]) : parseXml(`<w:comments xmlns:w="${W}" xmlns:w14="${W14}" xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w14 w15"/>`);
  const root = doc.documentElement;
  if (!root.lookupNamespaceURI('w14')) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:w14', W14);
  // Unchanged comments keep their source elements (moved, not reserialized).
  const sources = new Map();
  for (const node of wChildren(root, 'comment')) { node.remove(); try { sources.set(BigInt(node.getAttributeNS(W, 'id')).toString(), node); } catch { /* skipped */ } }
  const make = name => doc.createElementNS(W, `w:${name}`);
  const used = new Set(comments.map(c => c.paraId).filter(Boolean));
  const paraIds = new Map();
  let authored = false;
  for (const comment of comments) {
    let node;
    if (unchanged(comment) && sources.has(comment.sourceId)) {
      node = sources.get(comment.sourceId); sources.delete(comment.sourceId);
      for (const [attr, key] of [['author', 'author'], ['initials', 'initials'], ['date', 'date']]) {
        if (comment[key]) node.setAttributeNS(W, `w:${attr}`, comment[key]); else node.removeAttributeNS(W, attr);
      }
    } else {
      authored = true;
      node = make('comment');
      node.setAttributeNS(W, 'w:author', comment.author || 'Author');
      if (comment.date) node.setAttributeNS(W, 'w:date', comment.date);
      if (comment.initials) node.setAttributeNS(W, 'w:initials', comment.initials);
      const lines = comment.text.split('\n');
      for (const [i, line] of lines.entries()) {
        const p = make('p'), pPr = make('pPr'), style = make('pStyle');
        style.setAttributeNS(W, 'w:val', 'CommentText'); pPr.append(style); p.append(pPr);
        if (i === 0) {
          const r = make('r'), rPr = make('rPr'), rStyle = make('rStyle');
          rStyle.setAttributeNS(W, 'w:val', 'CommentReference'); rPr.append(rStyle); r.append(rPr, make('annotationRef')); p.append(r);
        }
        for (const piece of line.split(/(\t)/)) {
          if (!piece) continue;
          const r = make('r');
          if (piece === '\t') r.append(make('tab'));
          else { const t = make('t'); t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); t.textContent = piece; r.append(t); }
          p.append(r);
        }
        node.append(p);
      }
    }
    node.setAttributeNS(W, 'w:id', comment.id);
    const last = elements(node).filter(n => n.namespaceURI === W && n.localName === 'p').at(-1);
    if (last) {
      let paraId = last.getAttributeNS(W14, 'paraId')?.toUpperCase();
      if (!paraId || (comment.paraId && comment.paraId !== paraId)) {
        paraId = comment.paraId || newParaId(used);
        last.setAttributeNS(W14, 'w14:paraId', paraId);
      }
      paraIds.set(comment.id, paraId);
    }
    root.append(node);
  }
  write(parts, path, doc);
  ensureRelationship(parts, path, COMMENTS_REL, COMMENTS_TYPE);
  writeCompanions(parts, comments, paraIds);
  if (authored) ensureCommentStyles(parts);
}

/**
 * New comments use the paragraph style CommentText and the character style CommentReference (Word's
 * built-in "annotation text" and "annotation reference"). Add Word's definitions of the ones a styles
 * part lacks; existing definitions are left as they are. A package without a styles part keeps none.
 */
function ensureCommentStyles(parts) {
  let path = null;
  try { path = relatedPartPath(parts, 'styles'); } catch { path = null; }
  if (!path || !parts[path]) return;
  const doc = parseXml(parts[path]), root = doc.documentElement;
  if (root.namespaceURI !== W || root.localName !== 'styles') return;
  const styles = wChildren(root, 'style'), has = (type, id) => styles.some(s => s.getAttributeNS(W, 'type') === type && s.getAttributeNS(W, 'styleId') === id);
  const defaultId = type => styles.find(s => s.getAttributeNS(W, 'type') === type && ['1', 'true', 'on'].includes(s.getAttributeNS(W, 'default')))?.getAttributeNS(W, 'styleId');
  const missing = [];
  if (!has('paragraph', 'CommentText')) missing.push(['paragraph', 'CommentText', 'annotation text', defaultId('paragraph'), '<w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>']);
  if (!has('character', 'CommentReference')) missing.push(['character', 'CommentReference', 'annotation reference', defaultId('character'), '<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>']);
  if (!missing.length) return;
  for (const [type, id, name, basedOn, formatting] of missing) {
    const xml = `<w:style xmlns:w="${W}" w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn.replace(/[&<"]/g, c => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;' })[c])}"/>` : ''}<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>${formatting}</w:style>`;
    root.append(doc.importNode(parseXml(xml).documentElement, true));
  }
  write(parts, path, doc);
}

function writeCompanions(parts, comments, paraIds) {
  let extPath = null;
  try { extPath = relatedPartPath(parts, 'commentsExtended', COMMENTS_EXTENDED_REL); } catch { extPath = null; }
  const needed = comments.some(c => c.parentId || c.done);
  if (extPath || needed) {
    extPath ||= 'word/commentsExtended.xml';
    // The reader ignores an unreadable companion, so the model holds every reply
    // and resolved state the document has; regenerate the part from it.
    const fresh = () => parseXml(`<w15:commentsEx xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w15"/>`);
    let doc;
    try { doc = parts[extPath] ? parseXml(parts[extPath]) : fresh(); } catch { doc = fresh(); }
    const root = doc.documentElement;
    for (const node of [...root.getElementsByTagNameNS(W15, 'commentEx')]) node.remove();
    for (const comment of comments) {
      const paraId = paraIds.get(comment.id); if (!paraId) continue;
      const ex = doc.createElementNS(W15, 'w15:commentEx');
      ex.setAttributeNS(W15, 'w15:paraId', paraId);
      const parent = comment.parentId && paraIds.get(comment.parentId);
      if (parent) ex.setAttributeNS(W15, 'w15:paraIdParent', parent);
      ex.setAttributeNS(W15, 'w15:done', comment.done ? '1' : '0');
      root.append(ex);
    }
    write(parts, extPath, doc);
    ensureRelationship(parts, extPath, COMMENTS_EXTENDED_REL, COMMENTS_EXTENDED_TYPE);
  }
  // Durable-ID and extensible companions refer to paragraph identifiers. Drop
  // entries for removed comments; consumers regenerate missing ones on save.
  const live = new Set(paraIds.values());
  for (const [file, ns, tag] of [['word/commentsIds.xml', W16CID, 'commentId'], ['word/commentsExtensible.xml', W16CEX, 'commentExtensible']]) {
    if (!parts[file]) continue;
    try {
      const doc = parseXml(parts[file]);
      let changed = false;
      for (const node of [...doc.getElementsByTagNameNS(ns, tag)]) {
        const id = (node.getAttributeNS(ns, 'paraId') || '').toUpperCase();
        if (tag === 'commentId' ? !live.has(id) : false) { node.remove(); changed = true; }
      }
      if (tag === 'commentExtensible') {
        // Extensible entries are keyed by durable ID; keep those still listed in commentsIds.
        const ids = parts['word/commentsIds.xml'] ? new Set([...parseXml(parts['word/commentsIds.xml']).getElementsByTagNameNS(W16CID, 'commentId')].map(n => n.getAttributeNS(W16CID, 'durableId'))) : null;
        if (ids) for (const node of [...doc.getElementsByTagNameNS(ns, tag)]) if (!ids.has(node.getAttributeNS(ns, 'durableId'))) { node.remove(); changed = true; }
      }
      if (changed) write(parts, file, doc);
    } catch { /* A malformed optional companion is left as it was. */ }
  }
}

/** Write a comment marker as its WordprocessingML element(s). An end marker carries its reference run. */
export function writeCommentMarker(marker, doc) {
  const make = name => doc.createElementNS(W, `w:${name}`);
  const node = make(marker.edge === 'start' ? 'commentRangeStart' : 'commentRangeEnd');
  node.setAttributeNS(W, 'w:id', marker.commentId);
  if (marker.edge === 'start') return node;
  const fragment = doc.createDocumentFragment();
  const r = make('r'), rPr = make('rPr'), style = make('rStyle'), reference = make('commentReference');
  style.setAttributeNS(W, 'w:val', 'CommentReference'); rPr.append(style);
  reference.setAttributeNS(W, 'w:id', marker.commentId);
  r.append(rPr, reference);
  fragment.append(node, r);
  return fragment;
}

/** Read a commentRangeStart/End element as a comment marker. */
export function readCommentMarker(node, offset, order) {
  const raw = node.getAttributeNS(W, 'id');
  if (!/^[+-]?\d+$/.test(raw || '')) throw new UnsupportedDocumentError('an invalid comment range identifier');
  return commentMarker(BigInt(raw).toString(), node.localName === 'commentRangeStart' ? 'start' : 'end', offset, order);
}
