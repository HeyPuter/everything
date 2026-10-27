// Footnote and endnote properties and parts (ECMA-376 Part 1 §17.11): the
// document-wide CT_FtnDocProps/CT_EdnDocProps in settings (§17.11.11,
// §17.11.12), their pos, numFmt, numStart and numRestart children
// (§17.11.21, §17.11.17, §17.11.20, §17.11.19), and the notes parts with their
// separator notes (§17.11.15, §17.11.23).
import { strToU8 } from 'fflate';
import { parseXml, setContentTypeOverride } from './docx-xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const serialize = node => new XMLSerializer().serializeToString(node);
const child = (node, name) => node ? [...node.children].find(n => n.namespaceURI === W && n.localName === name) || null : null;
const value = node => node?.getAttributeNS(W, 'val') || null;

export const NOTE_DEFAULTS = {
  footnote: { position: 'pageBottom', format: 'decimal', start: 1, restart: 'continuous' },
  endnote: { position: 'docEnd', format: 'lowerRoman', start: 1, restart: 'continuous' },
};
export const NOTE_POSITIONS = { footnote: ['pageBottom', 'beneathText'], endnote: ['docEnd', 'sectEnd'] };
export const NOTE_RESTARTS = { footnote: ['continuous', 'eachSect', 'eachPage'], endnote: ['continuous', 'eachSect'] };
export const NOTE_FORMATS = ['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', 'chicago'];

/** Note settings from a settings-level footnotePr/endnotePr element (or null for defaults). */
export function readNoteSettings(node, kind = 'footnote') {
  const defaults = NOTE_DEFAULTS[kind];
  const start = value(child(node, 'numStart')), restart = value(child(node, 'numRestart')), position = value(child(node, 'pos'));
  return {
    format: value(child(node, 'numFmt')) || defaults.format,
    start: start && /^\d+$/.test(start) ? Number(start) : 1,
    restart: NOTE_RESTARTS[kind].includes(restart) ? restart : 'continuous',
    position: NOTE_POSITIONS[kind].includes(position) ? position : defaults.position,
  };
}

// CT_Settings children that follow footnotePr/endnotePr (§17.15.1.78): new note properties go before them.
const AFTER_NOTES = new Set(['compat', 'docVars', 'rsids', 'mathPr', 'attachedSchema', 'themeFontLang', 'clrSchemeMapping', 'doNotIncludeSubdocsInStats', 'doNotAutoCompressPictures', 'forceUpgrade', 'captions', 'readModeInkLockDown', 'smartTagType', 'schemaLibrary', 'shapeDefaults', 'doNotEmbedSmartTags', 'decimalSymbol', 'listSeparator']);

/**
 * Write note properties into a parsed settings document. `separators` are the separator note ids of the
 * notes part, referenced when the element is created. Returns whether anything changed.
 */
export function writeNoteSettings(settings, kind, values, separators = []) {
  const root = settings.documentElement, name = `${kind}Pr`;
  let node = child(root, name);
  const before = serialize(root);
  if (!node) {
    node = settings.createElementNS(W, `w:${name}`);
    const following = kind === 'footnote' ? new Set(['endnotePr', ...AFTER_NOTES]) : AFTER_NOTES;
    root.insertBefore(node, [...root.children].find(n => n.namespaceURI !== W || following.has(n.localName)) || null);
    for (const id of separators) { const ref = settings.createElementNS(W, `w:${kind}`); ref.setAttributeNS(W, 'w:id', String(id)); node.append(ref); }
  }
  const order = ['pos', 'numFmt', 'numStart', 'numRestart'];
  const wanted = { pos: values.position, numFmt: values.format, numStart: values.start === undefined ? undefined : String(values.start), numRestart: values.restart };
  for (const key of order) {
    if (wanted[key] === undefined) continue;
    let element = child(node, key);
    if (!element) {
      element = settings.createElementNS(W, `w:${key}`);
      const next = [...node.children].find(n => n.namespaceURI !== W || !order.includes(n.localName) || order.indexOf(n.localName) > order.indexOf(key));
      node.insertBefore(element, next || null);
    }
    element.setAttributeNS(W, 'w:val', wanted[key]);
  }
  return serialize(root) !== before;
}

/** Ids of the separator notes (non-normal types) in a notes part. */
export function separatorIds(parts, path, kind) {
  if (!path || !parts[path]) return [];
  const doc = parseXml(parts[path]);
  return [...doc.documentElement.children].filter(n => n.namespaceURI === W && n.localName === kind && ['separator', 'continuationSeparator'].includes(n.getAttributeNS(W, 'type'))).map(n => n.getAttributeNS(W, 'id'));
}

/** Create word/footnotes.xml or word/endnotes.xml with the standard separator notes; returns its path. */
export function createNotesPart(parts, kind) {
  const plural = `${kind}s`;
  let path = `word/${plural}.xml`, n = 1;
  while (Object.hasOwn(parts, path)) path = `word/${plural}${n++}.xml`;
  const separator = (type, id, mark) => `<w:${kind} w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${mark}/></w:r></w:p></w:${kind}>`;
  parts[path] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${plural} xmlns:w="${W}" xmlns:r="${R}">${separator('separator', -1, 'separator')}${separator('continuationSeparator', 0, 'continuationSeparator')}</w:${plural}>`);
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parseXml(parts[relPath] || `<Relationships xmlns="${REL}"/>`);
  const ids = new Set([...rels.documentElement.children].map(node => node.getAttribute('Id')));
  const prefix = `rId${kind[0].toUpperCase()}${kind.slice(1)}s`;
  let i = 1; while (ids.has(`${prefix}${i}`)) i++;
  const link = rels.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', `${prefix}${i}`); link.setAttribute('Type', `${R}/${plural}`); link.setAttribute('Target', path.slice('word/'.length));
  rels.documentElement.append(link);
  parts[relPath] = strToU8(serialize(rels));
  const types = parseXml(parts['[Content_Types].xml']);
  setContentTypeOverride(types, '/' + path, `${TYPE}${plural}+xml`);
  parts['[Content_Types].xml'] = strToU8(serialize(types));
  return path;
}
