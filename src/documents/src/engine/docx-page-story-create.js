// Creating a header or footer part (ECMA-376 Part 1 §17.10.1–§17.10.5) for a
// document that has none of that kind. The part, its relationship and content
// type are added at once; the section reference is written on export.
import { strToU8 } from 'fflate';
import { parseXml, setContentTypeOverride } from './docx-xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const serialize = node => new XMLSerializer().serializeToString(node);

/** Add an empty header or footer part to `parts`; returns { path, id }. */
export function createPageStoryPart(parts, kind) {
  if (!['header', 'footer'].includes(kind)) throw new Error('Only headers and footers can be created.');
  let n = 1; while (Object.hasOwn(parts, `word/${kind}${n}.xml`)) n++;
  const path = `word/${kind}${n}.xml`, root = kind === 'header' ? 'hdr' : 'ftr';
  parts[path] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="${W}" xmlns:r="${R}"><w:p/></w:${root}>`);
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parseXml(parts[relPath] || `<Relationships xmlns="${REL}"/>`);
  const ids = new Set([...rels.documentElement.children].map(node => node.getAttribute('Id')));
  let i = 1; while (ids.has(`rId${kind}${i}`)) i++;
  const id = `rId${kind}${i}`, link = rels.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', id); link.setAttribute('Type', `${R}/${kind}`); link.setAttribute('Target', path.slice('word/'.length));
  rels.documentElement.append(link);
  parts[relPath] = strToU8(serialize(rels));
  const types = parseXml(parts['[Content_Types].xml']);
  setContentTypeOverride(types, '/' + path, `${TYPE}${kind}+xml`);
  parts['[Content_Types].xml'] = strToU8(serialize(types));
  return { path, id };
}

/** Reference created stories from their section's properties (the first by default); later sections inherit them. */
export function writeCreatedStoryReferences(sectionNodes, references) {
  if (!sectionNodes.length || !references.length) return;
  const root = sectionNodes[0].ownerDocument.documentElement;
  if (root.lookupNamespaceURI('r') === null) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', R);
  for (const { kind, id, variant = 'default', section = 0 } of [...references].reverse()) {
    const target = sectionNodes[Math.min(section, sectionNodes.length - 1)];
    const existing = [...target.children].some(n => n.namespaceURI === W && n.localName === `${kind}Reference` && n.getAttributeNS(W, 'type') === variant);
    if (existing) continue;
    const ref = target.ownerDocument.createElementNS(W, `w:${kind}Reference`);
    ref.setAttributeNS(W, 'w:type', variant); ref.setAttributeNS(R, 'r:id', id);
    target.prepend(ref);
  }
}

/** Set or clear titlePg (§17.6.19) in the given sections, keeping CT_SectPr order. */
export function writeTitlePages(sectionNodes, flags, order) {
  for (const [index, on] of flags) {
    const section = sectionNodes[index];
    if (!section) continue;
    const existing = [...section.children].find(n => n.namespaceURI === W && n.localName === 'titlePg');
    if (!on) { existing?.remove(); continue; }
    if (existing) { existing.removeAttributeNS(W, 'val'); continue; }
    const node = section.ownerDocument.createElementNS(W, 'w:titlePg');
    section.insertBefore(node, [...section.children].find(n => order.indexOf(n.localName) > order.indexOf('titlePg')) || null);
  }
}

/** Write each section's page numbering (§17.6.12 pgNumType): fmt and start, keeping other attributes. */
export function writePageNumbering(sectionNodes, values, order) {
  for (const [index, value] of values) {
    const section = sectionNodes[index];
    if (!section) continue;
    let node = [...section.children].find(n => n.namespaceURI === W && n.localName === 'pgNumType');
    if (!value) { if (node) { node.removeAttributeNS(W, 'fmt'); node.removeAttributeNS(W, 'start'); if (!node.attributes.length) node.remove(); } continue; }
    if (!node) {
      node = section.ownerDocument.createElementNS(W, 'w:pgNumType');
      section.insertBefore(node, [...section.children].find(n => order.indexOf(n.localName) > order.indexOf('pgNumType')) || null);
    }
    if (value.format && value.format !== 'decimal') node.setAttributeNS(W, 'w:fmt', value.format); else node.removeAttributeNS(W, 'fmt');
    if (Number.isInteger(value.start)) node.setAttributeNS(W, 'w:start', String(value.start)); else node.removeAttributeNS(W, 'start');
    if (!node.attributes.length) node.remove();
  }
}

// CT_Settings elements that precede evenAndOddHeaders (§17.15.1.35).
const BEFORE_EVEN_ODD = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView', 'trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme', 'styleLockQFSet', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone', 'doNotHyphenateCaps', 'showEnvelope', 'summaryLength', 'clickAndTypeStyle', 'defaultTableStyle'];
/** Set or clear evenAndOddHeaders in a parsed settings document; returns whether it changed. */
export function writeEvenAndOdd(settings, on) {
  const root = settings.documentElement;
  const existing = [...root.children].find(n => n.namespaceURI === W && n.localName === 'evenAndOddHeaders');
  if (!!existing === !!on) return false;
  if (!on) { existing.remove(); return true; }
  const node = settings.createElementNS(W, 'w:evenAndOddHeaders');
  root.insertBefore(node, [...root.children].find(n => !(n.namespaceURI === W && BEFORE_EVEN_ODD.includes(n.localName))) || null);
  return true;
}

/** Create word/footnotes.xml with the standard separator notes (§17.11.23) when the package has none; returns its path. */
export function createFootnotesPart(parts) {
  let path = 'word/footnotes.xml', n = 1;
  while (Object.hasOwn(parts, path)) path = `word/footnotes${n++}.xml`;
  const separator = (type, id, mark) => `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${mark}/></w:r></w:p></w:footnote>`;
  parts[path] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}" xmlns:r="${R}">${separator('separator', -1, 'separator')}${separator('continuationSeparator', 0, 'continuationSeparator')}</w:footnotes>`);
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parseXml(parts[relPath] || `<Relationships xmlns="${REL}"/>`);
  const ids = new Set([...rels.documentElement.children].map(node => node.getAttribute('Id')));
  let i = 1; while (ids.has(`rIdFootnotes${i}`)) i++;
  const link = rels.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', `rIdFootnotes${i}`); link.setAttribute('Type', `${R}/footnotes`); link.setAttribute('Target', path.slice('word/'.length));
  rels.documentElement.append(link);
  parts[relPath] = strToU8(serialize(rels));
  const types = parseXml(parts['[Content_Types].xml']);
  setContentTypeOverride(types, '/' + path, `${TYPE}footnotes+xml`);
  parts['[Content_Types].xml'] = strToU8(serialize(types));
  return path;
}
