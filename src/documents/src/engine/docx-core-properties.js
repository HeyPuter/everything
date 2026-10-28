import { strToU8 } from 'fflate';
import { parseXml, setContentTypeOverride } from './docx-xml.js';

/**
 * Package core properties (ECMA-376 Part 2, §11 "Core Properties"): the document's title, subject,
 * author, keywords and dates, stored in the part the package relationship of type
 * …/metadata/core-properties names (usually docProps/core.xml).
 *
 * Reading never fails a document: a missing or malformed part reads as no properties. Writing
 * changes only the elements whose values changed and keeps every other element, attribute and
 * namespace of the part as it was.
 */

export const CORE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
export const CORE_TYPE = 'application/vnd.openxmlformats-package.core-properties+xml';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const DCTERMS = 'http://purl.org/dc/terms/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

/** Property key → [namespace, prefix, local name]. Dates are W3CDTF (§11.1, dcterms:created / modified). */
export const CORE_FIELDS = {
  title: [DC, 'dc', 'title'],
  subject: [DC, 'dc', 'subject'],
  creator: [DC, 'dc', 'creator'],
  keywords: [CP, 'cp', 'keywords'],
  description: [DC, 'dc', 'description'],
  category: [CP, 'cp', 'category'],
  contentStatus: [CP, 'cp', 'contentStatus'],
  lastModifiedBy: [CP, 'cp', 'lastModifiedBy'],
  revision: [CP, 'cp', 'revision'],
  created: [DCTERMS, 'dcterms', 'created'],
  modified: [DCTERMS, 'dcterms', 'modified'],
};
const DATE_FIELDS = new Set(['created', 'modified']);
/** The longest value written for one property; the schema sets no limit, a dialog field does. */
const MAX_LENGTH = 4096;

const serialize = node => new XMLSerializer().serializeToString(node);
const decode = bytes => bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : String(bytes);

// The part name the package's core-properties relationship targets, whether or not the part exists, or null.
function coreTarget(parts) {
  if (!parts['_rels/.rels']) return null;
  let rels;
  try { rels = parseXml(parts['_rels/.rels']); } catch { return null; }
  const link = [...rels.documentElement.children].find(n => n.localName === 'Relationship' && n.getAttribute('Type') === CORE_REL && n.getAttribute('TargetMode') !== 'External');
  const target = link?.getAttribute('Target');
  if (!target || /[\\?#:]/.test(target)) return null;
  const path = target.replace(/^\//, '').split('/').filter(s => s && s !== '.');
  return path.length && !path.includes('..') ? path.join('/') : null;
}

/** The core-properties part named by the package relationships, or null. */
export function corePropertiesPath(parts) {
  const path = coreTarget(parts);
  return path && Object.hasOwn(parts, path) ? path : null;
}

/** { title, subject, creator, keywords, … } as strings; properties the part lacks are ''. */
export function readCoreProperties(parts) {
  const result = Object.fromEntries(Object.keys(CORE_FIELDS).map(key => [key, '']));
  const path = corePropertiesPath(parts);
  if (!path) return result;
  let doc;
  try { doc = parseXml(parts[path]); } catch { return result; }
  for (const [key, [ns, , local]] of Object.entries(CORE_FIELDS)) {
    const node = [...doc.documentElement.children].find(n => n.namespaceURI === ns && n.localName === local);
    if (node) result[key] = node.textContent.trim();
  }
  return result;
}

/** A W3CDTF timestamp to the second, as desktop word processors write it. */
export const w3cdtf = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Values cleaned for the part: strings without control characters, trimmed, bounded. */
export function cleanCoreValue(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').trim().slice(0, MAX_LENGTH);
}

/**
 * Write a patch of properties into the package, creating the part (and its relationship and content
 * type) when the package has none. An empty string removes that property's element. Elements not in
 * the patch are left exactly as they were. Returns the path written.
 */
export function writeCoreProperties(parts, patch) {
  const entries = Object.entries(patch || {}).filter(([key]) => Object.hasOwn(CORE_FIELDS, key));
  if (!entries.length) return corePropertiesPath(parts);
  let path = corePropertiesPath(parts);
  if (!path) path = createCorePart(parts);
  const doc = parseXml(parts[path]);
  const root = doc.documentElement;
  let changed = false;
  for (const [key, raw] of entries) {
    const [ns, prefix, local] = CORE_FIELDS[key];
    const value = cleanCoreValue(raw);
    let node = [...root.children].find(n => n.namespaceURI === ns && n.localName === local);
    if (!value) { if (node) { node.remove(); changed = true; } continue; }
    if (node && node.textContent === value) continue;
    if (!node) {
      node = doc.createElementNS(ns, `${root.lookupPrefix(ns) || prefix}:${local}`);
      if (!root.lookupPrefix(ns) && root.getAttribute(`xmlns:${prefix}`) === null) root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, ns);
      root.append(node);
    }
    if (DATE_FIELDS.has(key)) {
      // §11.1: dcterms:created and dcterms:modified carry xsi:type="dcterms:W3CDTF".
      if (root.getAttribute('xmlns:xsi') === null && !root.lookupPrefix(XSI)) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xsi', XSI);
      const xsi = root.lookupPrefix(XSI) || 'xsi', terms = root.lookupPrefix(DCTERMS) || 'dcterms';
      node.setAttributeNS(XSI, `${xsi}:type`, `${terms}:W3CDTF`);
    }
    node.textContent = value;
    changed = true;
  }
  if (changed) parts[path] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
  return path;
}

function createCorePart(parts) {
  const empty = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="${DC}" xmlns:dcterms="${DCTERMS}" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="${XSI}"></cp:coreProperties>`);
  const types = parseXml(parts['[Content_Types].xml']);
  // A package holds one core-properties relationship (Part 2 §8.3): one left without its part gets the part.
  const dangling = coreTarget(parts);
  if (dangling) {
    parts[dangling] = empty;
    setContentTypeOverride(types, `/${dangling}`, CORE_TYPE);
    parts['[Content_Types].xml'] = strToU8(serialize(types));
    return dangling;
  }
  let path = 'docProps/core.xml';
  for (let n = 2; Object.hasOwn(parts, path); n++) path = `docProps/core${n}.xml`;
  parts[path] = empty;
  const rels = parseXml(parts['_rels/.rels']);
  const ids = new Set([...rels.documentElement.children].map(n => n.getAttribute('Id')));
  let id = 'rIdCore'; for (let n = 2; ids.has(id); n++) id = `rIdCore${n}`;
  const rel = rels.createElementNS(PKG_REL, 'Relationship');
  rel.setAttribute('Id', id); rel.setAttribute('Type', CORE_REL); rel.setAttribute('Target', path);
  rels.documentElement.append(rel);
  parts['_rels/.rels'] = strToU8(serialize(rels));
  setContentTypeOverride(types, `/${path}`, CORE_TYPE);
  parts['[Content_Types].xml'] = strToU8(serialize(types));
  return path;
}

/** Whether a package's core part decodes as text (for tests and diagnostics). */
export const corePartText = parts => { const path = corePropertiesPath(parts); return path ? decode(parts[path]) : null; };
