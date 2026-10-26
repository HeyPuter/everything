// Mail merge in the DOCX package.
//
// - The main document's type, preview state and active record live in the
//   settings part's w:mailMerge element (ECMA-376 Part 1 §17.14). Elements
//   this editor does not manage (data source links, queries, ODSO mappings)
//   are kept as they are.
// - The recipient list, column matching and email options are stored inside
//   the document as a custom XML data storage part with its properties part
//   (Part 1 §15.2, relationship …/customXml) in the namespace below, so a reopened document has its list
//   without an external data source. Other consumers ignore the part.
// - mergeDocumentParts() produces a merged copy of a saved main document:
//   every copy of the body with merge fields replaced by their results.
import { strToU8, strFromU8 } from 'fflate';
import { parseXml } from './docx-xml.js';
import { relationshipPartPath, relativePartTarget } from './package-part-paths.js';
import { planMerge, MERGE_TYPES, fieldKeyword } from './merge-fields.js';
import { xmlAttributeText } from './text-limits.js';

export const MAIL_MERGE_NS = 'urn:puter-documents:mail-merge:1';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
const CUSTOM_XML = `${R}/customXml`, CUSTOM_PROPS = `${R}/customXmlProps`, SETTINGS = `${R}/settings`;
const PROPS_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';

/** Main document types (ST_MailMergeDocType) and how the ribbon names them. */
export const DOCUMENT_TYPES = [
  ['formLetters', 'Letters'], ['email', 'Email Messages'], ['envelopes', 'Envelopes'], ['mailingLabels', 'Labels'], ['catalog', 'Directory'],
];

const serialize = node => new XMLSerializer().serializeToString(node);
const elements = (node, name, ns = W) => [...(node?.children || [])].filter(n => n.namespaceURI === ns && (!name || n.localName === name));
const child = (node, name, ns = W) => elements(node, name, ns)[0] || null;
const val = node => node?.getAttributeNS(W, 'val') ?? node?.getAttribute('w:val') ?? null;
const onOff = node => !!node && !['0', 'false', 'off'].includes(val(node) ?? '');
const save = (parts, path, doc) => { parts[path] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"')); };

function relationships(parts, source) {
  const path = relationshipPartPath(source);
  return { path, doc: parts[path] ? parseXml(parts[path]) : parseXml(`<Relationships xmlns="${REL}"/>`) };
}
const resolveTarget = (source, target) => {
  const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const piece of target.replace(/^\//, '').split('/')) { if (piece === '..') parts.pop(); else if (piece && piece !== '.') parts.push(piece); }
  return parts.join('/');
};
function settingsPath(parts) {
  const rels = relationships(parts, 'word/document.xml').doc;
  const link = elements(rels.documentElement, 'Relationship', REL).find(n => n.getAttribute('Type') === SETTINGS && n.getAttribute('TargetMode') !== 'External');
  return link ? resolveTarget('word/document.xml', link.getAttribute('Target')) : null;
}

/** The custom XML part holding this editor's mail merge data: { path, doc } or null. */
function dataPart(parts) {
  const rels = relationships(parts, 'word/document.xml').doc;
  for (const link of elements(rels.documentElement, 'Relationship', REL)) {
    if (link.getAttribute('Type') !== CUSTOM_XML || link.getAttribute('TargetMode') === 'External') continue;
    const path = resolveTarget('word/document.xml', link.getAttribute('Target'));
    if (!parts[path]) continue;
    try {
      const doc = parseXml(parts[path]);
      if (doc.documentElement.namespaceURI === MAIL_MERGE_NS) return { path, doc, id: link.getAttribute('Id') };
    } catch { /* Someone else's malformed data part is not ours to read. */ }
  }
  return null;
}

/** Read mail merge state from a package, or null when the document is not a merge main document and carries no list. */
export function readMailMerge(parts) {
  const path = settingsPath(parts);
  const settings = path && parts[path] ? parseXml(parts[path]).documentElement : null;
  const element = child(settings, 'mailMerge');
  const data = dataPart(parts);
  if (!element && !data) return null;
  const state = { type: null, activeRecord: 1, preview: false, subject: '', addressField: '', list: null, mapping: {}, source: null, email: { format: 'html' }, external: null };
  if (element) {
    const type = val(child(element, 'mainDocumentType'));
    state.type = DOCUMENT_TYPES.some(([id]) => id === type) ? type : type === 'fax' ? 'formLetters' : null;
    state.preview = onOff(child(element, 'viewMergedData'));
    const record = Number(val(child(element, 'activeRecord')));
    if (Number.isInteger(record) && record > 0) state.activeRecord = record;
    state.subject = val(child(element, 'mailSubject')) || '';
    state.addressField = val(child(element, 'addressFieldName')) || '';
    const query = val(child(element, 'query')), source = child(element, 'dataSource');
    if (source || query) {
      const id = source?.getAttributeNS(R, 'id');
      const rels = relationships(parts, path).doc;
      const link = id && elements(rels.documentElement, 'Relationship', REL).find(n => n.getAttribute('Id') === id);
      state.external = link?.getAttribute('Target') || query || 'an external data source';
    }
  }
  if (data) {
    const root = data.doc.documentElement, mm = name => [...root.children].find(n => n.namespaceURI === MAIL_MERGE_NS && n.localName === name);
    const columns = [...(mm('columns')?.children || [])].map(n => n.getAttribute('name') || '');
    if (columns.length) {
      const rows = [...(mm('records')?.children || [])].map(r => ({ values: columns.map((_, i) => r.children[i]?.textContent ?? ''), included: r.getAttribute('included') !== '0' }));
      const sort = [...(mm('sort')?.children || [])].map(n => ({ column: n.getAttribute('column'), descending: n.getAttribute('descending') === '1' })).filter(s => columns.includes(s.column));
      const filters = [...(mm('filters')?.children || [])].map(n => ({ column: n.getAttribute('column'), operator: n.getAttribute('operator'), value: n.getAttribute('value') || '', join: n.getAttribute('join') === 'or' ? 'or' : 'and' })).filter(f => columns.includes(f.column));
      state.list = { columns, rows, sort, filters };
    }
    for (const map of mm('mapping')?.children || []) if (map.getAttribute('field') && state.list?.columns.includes(map.getAttribute('column'))) state.mapping[map.getAttribute('field')] = map.getAttribute('column');
    const source = mm('source');
    if (source) state.source = { name: source.getAttribute('name') || '', kind: source.getAttribute('kind') || 'typed' };
    const email = mm('email');
    if (email) state.email = { to: email.getAttribute('to') || '', format: email.getAttribute('format') === 'text' ? 'text' : 'html' };
  }
  return state;
}

/** The custom XML document for a state's list, mapping and options. */
export function mailMergeDataXml(state) {
  const doc = parseXml(`<mm:mailMerge xmlns:mm="${MAIL_MERGE_NS}" version="1"/>`), root = doc.documentElement;
  // Recipient files can hold characters XML cannot (a vertical tab for a line break in a cell, a DOS
  // end-of-file mark); one written as it is would leave the part, and the list, unreadable.
  const add = (parent, name, attrs = {}, text = null) => {
    const node = doc.createElementNS(MAIL_MERGE_NS, `mm:${name}`);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, xmlAttributeText(v));
    if (text !== null) node.textContent = xmlAttributeText(text);
    parent.append(node); return node;
  };
  if (state.source) add(root, 'source', { kind: state.source.kind, name: state.source.name });
  const list = state.list;
  if (list) {
    const columns = add(root, 'columns');
    for (const name of list.columns) add(columns, 'column', { name });
    const records = add(root, 'records');
    for (const row of list.rows) {
      const record = add(records, 'record', { included: row.included === false ? '0' : '1' });
      list.columns.forEach((_, i) => add(record, 'value', {}, String(row.values[i] ?? '')));
    }
    if (list.sort?.length) { const sort = add(root, 'sort'); for (const s of list.sort) add(sort, 'key', { column: s.column, descending: s.descending ? '1' : '0' }); }
    if (list.filters?.length) { const filters = add(root, 'filters'); for (const f of list.filters) add(filters, 'filter', { column: f.column, operator: f.operator, value: f.value, join: f.join }); }
  }
  const mapping = Object.entries(state.mapping || {}).filter(([, column]) => column);
  if (mapping.length) { const node = add(root, 'mapping'); for (const [field, column] of mapping) add(node, 'map', { field, column }); }
  if (state.email?.to || state.email?.format === 'text') add(root, 'email', { to: state.email.to || '', format: state.email.format || 'html' });
  return doc;
}

const W_SETTINGS_ORDER = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge'];
// CT_MailMerge child order (§17.14).
const MAIL_MERGE_ORDER = ['mainDocumentType', 'linkToQuery', 'dataType', 'connectString', 'query', 'dataSource', 'headerSource', 'doNotSuppressBlankLines', 'destination', 'addressFieldName', 'mailSubject', 'mailAsAttachment', 'viewMergedData', 'activeRecord', 'checkErrors', 'odso'];

function ensureContentType(parts, partName, type) {
  const types = parseXml(parts['[Content_Types].xml']);
  const overrides = [...types.documentElement.children].filter(n => n.localName === 'Override');
  if (overrides.some(n => n.getAttribute('PartName') === partName)) return;
  const node = types.createElementNS(types.documentElement.namespaceURI || CT, 'Override');
  node.setAttribute('PartName', partName); node.setAttribute('ContentType', type);
  types.documentElement.append(node); save(parts, '[Content_Types].xml', types);
}
function removeContentType(parts, partName) {
  const types = parseXml(parts['[Content_Types].xml']);
  const node = [...types.documentElement.children].find(n => n.localName === 'Override' && n.getAttribute('PartName') === partName);
  if (node) { node.remove(); save(parts, '[Content_Types].xml', types); }
}
const hasDefaultXml = parts => [...parseXml(parts['[Content_Types].xml']).documentElement.children].some(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === 'xml');
const freshId = (doc, prefix) => { const ids = new Set(elements(doc.documentElement, 'Relationship', REL).map(n => n.getAttribute('Id'))); let i = 1; while (ids.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

/** Write the settings w:mailMerge element: the type, preview flag and active record. A null type removes it. */
function writeSettings(parts, state) {
  let path = settingsPath(parts);
  if (!path && !state?.type) return;
  let doc;
  if (path) doc = parseXml(parts[path]);
  else {
    path = 'word/settings.xml';
    for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/settings${i}.xml`;
    doc = parseXml(`<w:settings xmlns:w="${W}"/>`);
    const rels = relationships(parts, 'word/document.xml');
    const link = rels.doc.createElementNS(REL, 'Relationship');
    link.setAttribute('Id', freshId(rels.doc, 'rMailSettings')); link.setAttribute('Type', SETTINGS); link.setAttribute('Target', relativePartTarget('word/document.xml', path));
    rels.doc.documentElement.append(link); save(parts, rels.path, rels.doc);
    ensureContentType(parts, '/' + path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
  }
  const root = doc.documentElement;
  let element = child(root, 'mailMerge');
  const make = (name, value) => { const n = doc.createElementNS(W, `w:${name}`); if (value !== undefined) n.setAttributeNS(W, 'w:val', String(value)); return n; };
  if (!state?.type) { if (element) { element.remove(); save(parts, path, doc); } return; }
  if (!element) {
    element = make('mailMerge');
    const at = W_SETTINGS_ORDER.indexOf('mailMerge');
    root.insertBefore(element, [...root.children].find(n => n.namespaceURI !== W || !W_SETTINGS_ORDER.includes(n.localName) || W_SETTINGS_ORDER.indexOf(n.localName) > at) || null);
  }
  const place = (name, node) => {
    child(element, name)?.remove();
    if (!node) return;
    const at = MAIL_MERGE_ORDER.indexOf(name);
    element.insertBefore(node, [...element.children].find(n => MAIL_MERGE_ORDER.indexOf(n.localName) > at) || null);
  };
  place('mainDocumentType', make('mainDocumentType', state.type));
  // The list travels inside the document, in this editor's native format.
  if (!child(element, 'dataType')) place('dataType', make('dataType', 'native'));
  if (state.subject) place('mailSubject', make('mailSubject', state.subject)); else child(element, 'mailSubject')?.remove();
  if (state.email?.to) place('addressFieldName', make('addressFieldName', state.email.to)); else if (!state.external) child(element, 'addressFieldName')?.remove();
  place('viewMergedData', state.preview ? make('viewMergedData') : null);
  place('activeRecord', state.activeRecord > 1 || state.preview ? make('activeRecord', state.activeRecord) : null);
  save(parts, path, doc);
}

/** Write the recipient data part, creating, replacing or removing it. */
function writeDataPart(parts, state) {
  const existing = dataPart(parts);
  const wanted = !!(state && (state.list || Object.keys(state.mapping || {}).length || state.source || state.email?.to));
  if (!wanted) {
    if (!existing) return;
    const rels = relationships(parts, 'word/document.xml');
    elements(rels.doc.documentElement, 'Relationship', REL).find(n => n.getAttribute('Id') === existing.id)?.remove();
    save(parts, rels.path, rels.doc);
    const itemRels = relationshipPartPath(existing.path);
    if (parts[itemRels]) {
      for (const link of elements(parseXml(parts[itemRels]).documentElement, 'Relationship', REL)) {
        if (link.getAttribute('Type') !== CUSTOM_PROPS) continue;
        const props = resolveTarget(existing.path, link.getAttribute('Target'));
        delete parts[props]; removeContentType(parts, '/' + props);
      }
      delete parts[itemRels];
    }
    delete parts[existing.path]; removeContentType(parts, '/' + existing.path);
    return;
  }
  const doc = mailMergeDataXml(state);
  if (existing) { save(parts, existing.path, doc); return; }
  let n = 1;
  while (parts[`customXml/item${n}.xml`] || parts[`customXml/itemProps${n}.xml`]) n++;
  const item = `customXml/item${n}.xml`, props = `customXml/itemProps${n}.xml`;
  save(parts, item, doc);
  const guid = crypto.randomUUID ? crypto.randomUUID().toUpperCase() : '6F1C3E2A-4B7D-4E8F-9A0B-1C2D3E4F5A6B';
  parts[props] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{${guid}}" xmlns:ds="${DS}"><ds:schemaRefs><ds:schemaRef ds:uri="${MAIL_MERGE_NS}"/></ds:schemaRefs></ds:datastoreItem>`);
  parts[relationshipPartPath(item)] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${CUSTOM_PROPS}" Target="itemProps${n}.xml"/></Relationships>`);
  ensureContentType(parts, '/' + props, PROPS_TYPE);
  if (!hasDefaultXml(parts)) ensureContentType(parts, '/' + item, 'application/xml');
  const rels = relationships(parts, 'word/document.xml');
  const link = rels.doc.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', freshId(rels.doc, 'rMailMerge')); link.setAttribute('Type', CUSTOM_XML); link.setAttribute('Target', relativePartTarget('word/document.xml', item));
  rels.doc.documentElement.append(link); save(parts, rels.path, rels.doc);
}

/** Apply mail merge state to exported package parts (in place). */
export function writeMailMerge(parts, state) {
  writeSettings(parts, state);
  writeDataPart(parts, state);
  return parts;
}

/* ---- Merged output ---- */

const isW = (n, name) => n?.nodeType === 1 && n.namespaceURI === W && n.localName === name;
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
/** Descendants in document order. Markup-compatibility fallbacks repeat their choice's content and are skipped. */
function documentOrder(root) {
  const out = [];
  const walk = node => { for (const c of node.children) { if (c.namespaceURI === MC && c.localName === 'Fallback') continue; out.push(c); walk(c); } };
  walk(root); return out;
}

/**
 * Fields in body content, in document order: [{ code, type, simple?, begin, end, element, resultProperties }].
 * Fields nested in another field's instruction are part of that field's code; fields inside the
 * result of a merge field go with it.
 */
export function xmlMergeFields(nodes) {
  const fields = [], stack = [];
  const insideMergeResult = () => stack.some(f => f.phase === 'result' && MERGE_TYPES.has(fieldKeyword(f.code)));
  for (const top of nodes) for (const node of [top, ...documentOrder(top)]) {
    const active = stack.at(-1);
    if (isW(node, 'fldSimple')) {
      if (active?.phase === 'code') { active.code += `{${node.getAttributeNS(W, 'instr') || ''}}`; continue; }
      if (insideMergeResult()) continue;
      fields.push({ code: node.getAttributeNS(W, 'instr') || '', simple: true, element: node, resultProperties: child(child(node, 'r'), 'rPr') });
      continue;
    }
    if (isW(node, 'instrText')) { if (active?.phase === 'code') active.code += node.textContent; continue; }
    if (isW(node, 't') && active?.phase === 'result' && !active.resultProperties) { active.resultProperties = child(node.parentNode, 'rPr') || active.beginProperties; continue; }
    if (!isW(node, 'fldChar')) continue;
    const kind = node.getAttributeNS(W, 'fldCharType'), run = node.parentNode;
    if (kind === 'begin') {
      if (active?.phase === 'code') { active.code += '{'; active.depth++; continue; }
      stack.push({ code: '', phase: 'code', depth: 0, begin: run, beginProperties: child(run, 'rPr') });
    } else if (kind === 'separate') {
      if (active?.depth) continue;
      if (active) active.phase = 'result';
    } else if (kind === 'end') {
      if (active?.depth) { active.depth--; active.code += '}'; continue; }
      if (!active) continue;
      stack.pop();
      active.end = run;
      if (!insideMergeResult()) fields.push({ code: active.code, begin: active.begin, end: run, resultProperties: active.resultProperties || active.beginProperties });
    }
  }
  // Complex fields close after the fields nested in their results; restore document order.
  const position = new Map(nodes.flatMap(n => [n, ...documentOrder(n)]).map((n, i) => [n, i]));
  return fields.map(f => ({ ...f, type: fieldKeyword(f.code) })).sort((a, b) => position.get(a.element || a.begin) - position.get(b.element || b.begin));
}

/** Result runs for merged text: line breaks as w:br, tabs as w:tab. */
function resultRuns(doc, text, properties) {
  // A recipient's line break may be a vertical tab or CR; characters XML cannot hold go.
  text = xmlAttributeText(text);
  if (!text) return [];
  const run = doc.createElementNS(W, 'w:r');
  if (properties) run.append(properties.cloneNode(true));
  text.split('\n').forEach((line, i) => {
    if (i) run.append(doc.createElementNS(W, 'w:br'));
    line.split('\t').forEach((piece, j) => {
      if (j) run.append(doc.createElementNS(W, 'w:tab'));
      if (!piece) return;
      const t = doc.createElementNS(W, 'w:t'); t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); t.textContent = piece; run.append(t);
    });
  });
  return [run];
}

const paragraphOf = node => { while (node && !isW(node, 'p')) node = node.parentNode; return node; };

/**
 * Replace one field in place with its result text; `all` is the content in document order. Top-level
 * nodes the replacement removes are added to `dropped` (they have no parent to be removed from).
 */
function replaceField(doc, field, text, all, dropped) {
  if (field.simple) { field.element.replaceWith(...resultRuns(doc, text, field.resultProperties)); return; }
  const span = all.slice(all.indexOf(field.begin), all.indexOf(field.end) + 1);
  const first = paragraphOf(field.begin), last = paragraphOf(field.end);
  for (const n of resultRuns(doc, text, field.resultProperties)) field.begin.parentNode.insertBefore(n, field.begin);
  // Runs (and simple fields) between the delimiters go, also those in a paragraph, hyperlink or other
  // wrapper within them; bookmarks and other markup stay.
  for (const n of span) if (isW(n, 'r') || isW(n, 'fldSimple')) n.remove();
  // A result over several paragraphs (an address block saved with its lines as paragraphs) holds their
  // marks: the paragraphs within it go, and what follows the field joins the paragraph it starts in,
  // ended by the mark after the field.
  if (!first || !last || first === last || first.parentNode !== last.parentNode) return;
  const drop = node => { if (node.parentNode) node.remove(); else dropped.add(node); };
  for (const n of span) if (n.parentNode === first.parentNode && n !== last && (isW(n, 'p') || isW(n, 'tbl'))) drop(n);
  for (const n of [...last.children]) if (!isW(n, 'pPr')) first.append(n);
  child(first, 'pPr')?.remove();
  const marks = child(last, 'pPr');
  if (marks) first.prepend(marks);
  drop(last);
}

/**
 * Merge a saved main document: one copy of the body per planned copy, separated by section breaks
 * (or run together for a directory). Returns { parts, copies } for a new, ordinary document.
 */
export function mergeDocumentParts(sourceParts, { data, mapping = {}, answers = {}, type = 'formLetters', onIssue } = {}) {
  const parts = { ...sourceParts };
  const doc = parseXml(parts['word/document.xml']);
  const body = child(doc.documentElement, 'body');
  const finalSection = child(body, 'sectPr');
  const template = [...body.children].filter(n => n !== finalSection);
  const codes = xmlMergeFields(template).map(f => f.code);
  const plan = planMerge(codes, { data, mapping, answers, onIssue });
  if (!plan.length) throw new Error('No recipients are left to merge. Check the recipient list and any Skip Record If rules.');
  for (const n of template) n.remove();
  // A note belongs to one reference (§17.11.14, §17.11.7): each later copy gets copies of the notes it refers to.
  // Sharing them, every letter's reference pointed at the first letter's note.
  const notes = [['footnotes', 'footnote', 'footnoteReference'], ['endnotes', 'endnote', 'endnoteReference']].map(([kind, name, reference]) => {
    const link = elements(relationships(parts, 'word/document.xml').doc.documentElement, 'Relationship', REL).find(n => n.getAttribute('Type') === `${R}/${kind}` && n.getAttribute('TargetMode') !== 'External');
    const path = link && resolveTarget('word/document.xml', link.getAttribute('Target'));
    if (!path || !parts[path]) return null;
    const part = parseXml(parts[path]), byId = new Map(elements(part.documentElement, name).map(n => [n.getAttributeNS(W, 'id'), n]));
    return { path, part, byId, reference, next: Math.max(0, ...[...byId.keys()].map(Number).filter(Number.isFinite)) + 1, changed: false };
  }).filter(Boolean);
  const copyNote = (kind, e) => {
    const source = kind.byId.get(e.getAttributeNS(W, 'id')); if (!source) return;
    const note = source.cloneNode(true), id = String(kind.next++);
    note.setAttributeNS(W, 'w:id', id);
    for (const n of documentOrder(note)) {
      if (['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd'].some(name => isW(n, name)) || isW(n, 'r') && child(n, 'commentReference')) n.remove();
      else for (const attr of [...n.attributes]) if (['paraId', 'textId'].includes(attr.localName) && attr.namespaceURI?.includes('wordml')) n.removeAttributeNode(attr);
    }
    kind.part.documentElement.append(note); e.setAttributeNS(W, 'w:id', id); kind.changed = true;
  };
  const output = [];
  plan.forEach((copy, index) => {
    const nodes = template.map(n => n.cloneNode(true));
    const fields = xmlMergeFields(nodes), all = nodes.flatMap(n => [n, ...documentOrder(n)]), dropped = new Set();
    fields.forEach((field, i) => { if (copy.results[i] !== null && copy.results[i] !== undefined) replaceField(doc, field, copy.results[i], all, dropped); });
    if (dropped.size) nodes.splice(0, nodes.length, ...nodes.filter(n => !dropped.has(n)));
    if (index) for (const n of nodes) for (const e of [n, ...documentOrder(n)]) {
      // Later copies drop bookmarks and comment anchors whose ids and names must stay unique.
      if (['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd'].some(name => isW(e, name))) e.remove();
      else if (isW(e, 'r') && child(e, 'commentReference')) e.remove();
      else for (const kind of notes) if (isW(e, kind.reference)) copyNote(kind, e);
    }
    const last = index === plan.length - 1;
    if (!last && type !== 'catalog') {
      const tail = nodes.at(-1);
      const section = finalSection ? finalSection.cloneNode(true) : null;
      if (section) {
        const typeNode = child(section, 'type'); if (typeNode) typeNode.setAttributeNS(W, 'w:val', 'nextPage');
        let paragraph = isW(tail, 'p') && !child(child(tail, 'pPr'), 'sectPr') ? tail : null;
        if (!paragraph) { paragraph = doc.createElementNS(W, 'w:p'); nodes.push(paragraph); }
        let pPr = child(paragraph, 'pPr');
        if (!pPr) { pPr = doc.createElementNS(W, 'w:pPr'); paragraph.prepend(pPr); }
        const change = child(pPr, 'pPrChange');
        pPr.insertBefore(section, change);
      } else {
        const p = doc.createElementNS(W, 'w:p'), r = doc.createElementNS(W, 'w:r'), br = doc.createElementNS(W, 'w:br');
        br.setAttributeNS(W, 'w:type', 'page'); r.append(br); p.append(r); nodes.push(p);
      }
    }
    output.push(...nodes);
  });
  for (const n of output) body.insertBefore(n, finalSection);
  // Ids that must be unique in the whole document.
  let drawing = 1;
  for (const e of documentOrder(doc.documentElement)) {
    if (e.localName === 'docPr' && e.hasAttribute('id')) e.setAttribute('id', String(drawing++));
    for (const attr of [...e.attributes]) if (['paraId', 'textId'].includes(attr.localName) && attr.namespaceURI?.includes('wordml')) e.removeAttributeNode(attr);
  }
  save(parts, 'word/document.xml', doc);
  for (const kind of notes) if (kind.changed) save(parts, kind.path, kind.part);
  // The result is an ordinary document: no merge settings and no recipient list.
  writeMailMerge(parts, null);
  return { parts, copies: plan };
}

/** Text of a merged part, for tests and email bodies. */
export const partText = bytes => [...parseXml(bytes).getElementsByTagNameNS(W, 'p')].map(p => [...p.getElementsByTagNameNS(W, '*')].map(n => n.localName === 't' ? n.textContent : n.localName === 'br' ? '\n' : n.localName === 'tab' ? '\t' : '').join('')).join('\n');
export { strFromU8 };
