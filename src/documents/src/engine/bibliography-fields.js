// The bibliography custom XML part (ECMA-376 Part 1 §22.5, §22.6) and the
// CITATION/BIBLIOGRAPHY fields (§17.16.5.8, §17.16.5.7) whose cached results
// this editor generates from it. The part is found through the main document's
// customXml relationships; a new one gets its item properties part (§22.5.2.1).
import { strToU8, strFromU8 } from 'fflate';
import { parseXml } from './docx-xml.js';
import { bodyFieldRanges } from './body-fields.js';
import { BIB_NS, newGuid, parseSources, serializeSources, parseCitation, citationInstruction, bibliographyInstruction } from './bibliography.js';
import { CITATION_STYLES, DEFAULT_STYLE, citationContext, formatBibliography, formatCitation } from './citation-styles.js';
import { fieldsOfType, newBodyField, setFieldInstruction, writeBlockField, writeInlineField } from './generated-fields.js';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CUSTOM_XML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CUSTOM_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps';
const DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
const DOCUMENT_RELS = 'word/_rels/document.xml.rels';
const serialize = node => new XMLSerializer().serializeToString(node);
const resolve = (base, target) => {
  const path = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) { if (segment === '..') path.pop(); else if (segment && segment !== '.') path.push(segment); }
  return path.join('/');
};

/** Paths of the main document's custom XML items. */
export function customXmlItems(parts) {
  if (!parts[DOCUMENT_RELS]) return [];
  const rels = parseXml(parts[DOCUMENT_RELS]).documentElement;
  return [...rels.children].filter(n => n.getAttribute('Type') === CUSTOM_XML && n.getAttribute('TargetMode') !== 'External').map(n => resolve('word/document.xml', n.getAttribute('Target'))).filter(path => Object.hasOwn(parts, path));
}

/** The bibliography part: { path, data } (data from parseSources), or null when the document has none. */
export function readBibliographyPart(parts) {
  for (const path of customXmlItems(parts)) {
    let root;
    try { root = parseXml(parts[path]).documentElement; } catch { continue; }
    if (root.namespaceURI === BIB_NS && root.localName === 'Sources') return { path, data: parseSources(strFromU8(parts[path])) };
  }
  return null;
}

function addOverride(parts, partName, type) {
  const types = parseXml(parts['[Content_Types].xml']), root = types.documentElement;
  if ([...root.children].some(n => n.localName === 'Override' && n.getAttribute('PartName') === partName)) return;
  const override = types.createElementNS(root.namespaceURI, 'Override');
  override.setAttribute('PartName', partName); override.setAttribute('ContentType', type);
  root.append(override);
  if (![...root.children].some(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === 'xml')) {
    const xmlDefault = types.createElementNS(root.namespaceURI, 'Default');
    xmlDefault.setAttribute('Extension', 'xml'); xmlDefault.setAttribute('ContentType', 'application/xml');
    root.prepend(xmlDefault);
  }
  parts['[Content_Types].xml'] = strToU8(serialize(types));
}

/** Write `data` ({ style, styleName, sources }) to the bibliography part, creating it when needed; returns its path. */
export function writeBibliographyPart(parts, data) {
  const existing = readBibliographyPart(parts);
  const text = serializeSources(data);
  if (existing) {
    if (strFromU8(parts[existing.path]) !== text) parts[existing.path] = strToU8(text);
    return existing.path;
  }
  let n = 1; while (Object.hasOwn(parts, `customXml/item${n}.xml`) || Object.hasOwn(parts, `customXml/itemProps${n}.xml`)) n++;
  const item = `customXml/item${n}.xml`, props = `customXml/itemProps${n}.xml`;
  parts[item] = strToU8(text);
  const guid = newGuid();
  parts[props] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="${guid}" xmlns:ds="${DS}"><ds:schemaRefs><ds:schemaRef ds:uri="${BIB_NS}"/></ds:schemaRefs></ds:datastoreItem>`);
  parts[`customXml/_rels/item${n}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${CUSTOM_PROPS}" Target="itemProps${n}.xml"/></Relationships>`);
  const rels = parseXml(parts[DOCUMENT_RELS] || `<Relationships xmlns="${REL}"/>`);
  const ids = new Set([...rels.documentElement.children].map(node => node.getAttribute('Id')));
  let i = 1; while (ids.has(`rIdCustomXml${i}`)) i++;
  const link = rels.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', `rIdCustomXml${i}`); link.setAttribute('Type', CUSTOM_XML); link.setAttribute('Target', `../${item}`);
  rels.documentElement.append(link);
  parts[DOCUMENT_RELS] = strToU8(serialize(rels));
  addOverride(parts, `/${props}`, 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml');
  return item;
}

/* ---- Fields ---- */
/** Style id for a part's stored style (its SelectedStyle/StyleName), else the default. */
export function styleOf(data) {
  const text = `${data?.style || ''} ${data?.styleName || ''}`.toLowerCase();
  return Object.keys(CITATION_STYLES).find(id => new RegExp(`(^|[^a-z])${id}([^a-z]|$)`).test(text)) || DEFAULT_STYLE;
}

/** CITATION fields with their parsed instruction, in document order. */
export function citationFields(paragraphs) {
  return bodyFieldRanges(paragraphs).filter(r => r.field.type === 'CITATION').map(r => ({ ...r, citation: parseCitation(r.field.instruction) })).filter(r => r.citation);
}
/** Point the citations of source `from` at its new tag `to` (a source's tag was changed); returns how many changed. */
export function renameCitedTag(doc, from, to) {
  const same = tag => String(tag).toLowerCase() === String(from).toLowerCase();
  let changed = 0;
  for (const { field } of citationFields(doc.paragraphs).filter(r => r.citation.tags.some(same))) {
    const range = citationFields(doc.paragraphs).find(r => r.field.id === field.id);
    const citation = { ...range.citation, tags: range.citation.tags.map(tag => same(tag) ? to : tag) };
    if (setFieldInstruction(doc, range, citationInstruction({ ...citation, lcid: citation.lcid || '1033' }))) changed++;
  }
  return changed;
}
/** Tags in order of first citation. */
export const citedTags = paragraphs => [...new Set(citationFields(paragraphs).flatMap(r => r.citation.tags))];

const byTag = (sources, tag) => sources.find(s => s.tag.toLowerCase() === String(tag).toLowerCase()) || null;
/** The runs a citation shows in `style`. */
export function citationRuns(citation, sources, style, context) {
  const entries = citation.tags.map((tag, i) => ({ tag, source: byTag(sources, tag), ...(i === 0 ? citation : {}), tags: undefined }));
  return formatCitation(style, entries, context);
}

const sameRuns = (doc, range, runs) => doc.text.slice(range.start, range.end) === runs.map(r => r.text).join('');

/** Refresh every CITATION result for `sources` in `style`; returns the number of changed fields. */
/**
 * Rewrite a field's result with `write()` and return where `selection` is now in the text. Writing a result
 * leaves the caret at its end; an update put the caret at the end of the last field it rewrote, so the
 * citation inserted next landed there.
 */
function selectionAfter(doc, selection, range, write) {
  const length = doc.text.length;
  write();
  const delta = doc.text.length - length, end = range.end + delta;
  const keep = position => position >= range.end ? position + delta : position > range.start ? Math.min(position, end) : position;
  return { anchor: keep(selection.anchor), focus: keep(selection.focus) };
}

export function updateCitations(doc, sources, style) {
  const context = citationContext(style, sources, citedTags(doc.paragraphs));
  let changed = 0;
  const fields = citationFields(doc.paragraphs);
  let selection = { ...doc.selection };
  for (let i = fields.length - 1; i >= 0; i--) {
    const range = citationFields(doc.paragraphs)[i];
    if (range.field.locked) continue;
    const runs = citationRuns(range.citation, sources, style, context);
    if (sameRuns(doc, range, runs)) continue;
    selection = selectionAfter(doc, selection, range, () => writeInlineField(doc, { existing: range, runs }));
    changed++;
  }
  if (changed) doc.select(selection.anchor, selection.focus);
  return changed;
}

/** Insert a citation of `citation` ({ tags, pages, … }) at the caret. */
export function insertCitation(doc, citation, sources, style) {
  const field = newBodyField(citationInstruction({ lcid: '1033', ...citation }));
  // A citation typed straight after a word gets a space before it, as one would type it.
  const at = doc.range[0];
  if (/[\p{L}\p{N}]/u.test(doc.text[at - 1] || '')) { doc.select(at, doc.range[1]); doc.replaceUntracked(' ', { checkpoint: false }); }
  const context = citationContext(style, sources, [...citedTags(doc.paragraphs), ...citation.tags]);
  const range = writeInlineField(doc, { field, runs: citationRuns(parseCitation(field.instruction), sources, style, context) });
  // IEEE numbers follow citation order, so earlier numbers can shift.
  if (style === 'ieee') updateCitations(doc, sources, style);
  return range;
}

/** The rows a bibliography result shows. */
export function bibliographyRows(doc, sources, style) {
  const entries = formatBibliography(style, sources, citedTags(doc.paragraphs));
  const numbered = CITATION_STYLES[style]?.numbered;
  const format = numbered ? { indentLeft: 640, firstLine: -640, spaceBefore: 0, spaceAfter: 6 } : { indentLeft: 720, firstLine: -720, spaceBefore: 0, spaceAfter: 6 };
  if (!entries.length) return [{ style: 'Bibliography', runs: [{ text: 'There are no sources in the current document.' }], format: { indentLeft: 0, firstLine: 0, spaceAfter: 6 } }];
  return entries.map(entry => ({ style: 'Bibliography', runs: entry.runs, format, ...(numbered ? { always: { tabs: [{ position: 640, alignment: 'left', leader: 'none' }] } } : {}) }));
}

/** Rebuild every BIBLIOGRAPHY result; returns the number rebuilt. */
export function updateBibliographies(doc, sources, style) {
  let count = 0;
  let selection = { ...doc.selection };
  for (let i = fieldsOfType(doc.paragraphs, 'BIBLIOGRAPHY').length - 1; i >= 0; i--) {
    const existing = fieldsOfType(doc.paragraphs, 'BIBLIOGRAPHY')[i];
    if (existing.field.locked || !existing.whole) continue;
    const rows = bibliographyRows(doc, sources, style);
    const current = doc.paragraphs.slice(existing.first, existing.last + 1).map(p => p.runs.map(r => r.text).join('')).join('\n');
    if (current === rows.map(r => r.runs.map(x => x.text).join('')).join('\n')) continue;
    selection = selectionAfter(doc, selection, existing, () => writeBlockField(doc, { existing, rows }));
    count++;
  }
  if (count) doc.select(selection.anchor, selection.focus);
  return count;
}

/** Insert a bibliography at the caret, with an optional heading paragraph above it. */
export function insertBibliography(doc, sources, style, { heading = null } = {}) {
  const before = heading ? [{ style: 'Heading 1', runs: [{ text: heading }], format: { spaceBefore: 12, spaceAfter: 6, keepNext: true }, run: { fontSize: 16, bold: true } }] : [];
  return writeBlockField(doc, { field: newBodyField(bibliographyInstruction()), rows: bibliographyRows(doc, sources, style), before });
}

/** Turn a citation or bibliography into plain text: its markers go, its result stays. */
export function convertToText(doc, range) {
  doc.checkpoint();
  for (const p of doc.paragraphs) if (p.fieldMarkers?.some(m => m.field.id === range.field.id)) {
    p.fieldMarkers = p.fieldMarkers.filter(m => m.field.id !== range.field.id);
    if (!p.fieldMarkers.length) delete p.fieldMarkers;
  }
  doc.didChange();
  return true;
}
