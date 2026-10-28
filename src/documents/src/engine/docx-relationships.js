import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

// A relationships part's entries, read once for each version of the part (its bytes, which are replaced,
// not changed, when the part is written). The editor's controls look parts up through the main document's
// relationships after every keystroke, and a document with hundreds of hyperlinks parsed them each time.
const readRelationships = new WeakMap();
/** The child elements of a relationships part's root: [{ namespaceURI, localName, attribute(name) }]. */
export function relationshipEntries(bytes) {
  let entries = bytes && typeof bytes === 'object' ? readRelationships.get(bytes) : undefined;
  if (!entries) {
    entries = Object.freeze([...parseXml(bytes).documentElement.children].map(node => {
      const attributes = new Map([...node.attributes].filter(a => !a.namespaceURI).map(a => [a.name, a.value]));
      return Object.freeze({ namespaceURI: node.namespaceURI, localName: node.localName, attribute: name => attributes.get(name) ?? null });
    }));
    if (bytes && typeof bytes === 'object') readRelationships.set(bytes, entries);
  }
  return entries;
}

// Resolve a singleton internal relationship from the supported main-document
// location. Per OPC, its base is the source part, not its Relationships part.
export function relatedPartPath(parts, kind, relationshipType = OFFICE_REL + kind) {
  const rels = parts['word/_rels/document.xml.rels'] ? relationshipEntries(parts['word/_rels/document.xml.rels']) : [];
  const links = rels.filter(n => n.namespaceURI === REL && n.localName === 'Relationship' && n.attribute('Type') === relationshipType);
  if (!links.length) return null;
  if (links.length !== 1 || ![null, 'Internal'].includes(links[0].attribute('TargetMode'))) throw new UnsupportedDocumentError(`duplicate or external ${kind} relationships`);
  const target = links[0].attribute('Target');
  if (!target || /[\\?#:\s]/.test(target) || target.startsWith('//') || /%(?![0-9a-f]{2})|%2f|%5c/i.test(target)) throw new UnsupportedDocumentError(`an invalid ${kind} target`);
  const path = [];
  for (const segment of (target.startsWith('/') ? target.slice(1) : 'word/' + target).split('/')) {
    if (segment === '..') path.pop();
    else if (segment !== '.') { if (!segment) throw new UnsupportedDocumentError(`an invalid ${kind} target`); path.push(segment); }
  }
  const name = path.join('/');
  if (!Object.hasOwn(parts, name)) throw new UnsupportedDocumentError(`a missing ${kind} part`);
  return name;
}
