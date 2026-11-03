// Range permissions (ECMA-376 Part 1 §17.13.7 range permissions: permEnd, permStart): the regions of a
// protected document that named editors or everyone may still change. They are zero-width markers
// kept beside bookmark markers in `paragraph.bookmarks` (flagged `perm`), so edits move them
// exactly as they move bookmarks and comment anchors.
import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const serialize = n => new XMLSerializer().serializeToString(n);
export const EDITOR_GROUPS = ['none', 'everyone', 'administrators', 'contributors', 'editors', 'owners', 'current'];

export const isPermissionElement = node => node?.namespaceURI === W && ['permStart', 'permEnd'].includes(node.localName);

/** A permission marker for range `id` at a paragraph-local offset. */
export function permissionMarker(id, edge, offset, order, { ed = null, edGrp = null, shell } = {}) {
  return { id: `perm:${id}`, permId: String(id), perm: true, edge, offset, order, bodyOrder: order, ...(edge === 'start' && ed ? { ed } : {}), ...(edge === 'start' && edGrp ? { edGrp } : {}), ...(shell ? { shell } : {}) };
}

/** Read a permStart/permEnd element as a marker. */
export function readPermissionMarker(node, offset, order, context = {}) {
  const edge = node.localName === 'permStart' ? 'start' : 'end';
  if (node.children.length || node.textContent.trim()) throw new UnsupportedDocumentError('permission marker content');
  for (const attr of [...node.attributes]) {
    if (attr.namespaceURI === XMLNS) continue;
    if (attr.namespaceURI !== W || !['id', 'displacedByCustomXml', ...(edge === 'start' ? ['ed', 'edGrp', 'colFirst', 'colLast'] : [])].includes(attr.localName)) throw new UnsupportedDocumentError(`permission attribute ${attr.name}`);
  }
  const id = node.getAttributeNS(W, 'id');
  if (!id) throw new UnsupportedDocumentError('a permission range without an identifier');
  const edGrp = node.getAttributeNS(W, 'edGrp');
  if (edGrp !== null && !EDITOR_GROUPS.includes(edGrp)) throw new UnsupportedDocumentError('an invalid permission editor group');
  // A range opened in a table cell may cover only some of its columns (§17.13.7.2 colFirst, colLast).
  const first = node.getAttributeNS(W, 'colFirst'), last = node.getAttributeNS(W, 'colLast');
  const columns = edge === 'start' && context.cellId && /^[+-]?\d+$/.test(first || '') && /^[+-]?\d+$/.test(last || '') ? { first: BigInt(first).toString(), last: BigInt(last).toString() } : null;
  return { ...permissionMarker(id, edge, offset, order, { ed: node.getAttributeNS(W, 'ed'), edGrp, shell: serialize(node) }), ...(columns ? { tableColumns: columns } : {}) };
}

/** Write a permission marker; a retained source element keeps its other attributes. */
export function writePermissionMarker(marker, doc) {
  const name = marker.edge === 'start' ? 'w:permStart' : 'w:permEnd';
  const node = marker.shell ? doc.importNode(parseXml(marker.shell).documentElement, true) : doc.createElementNS(W, name);
  node.setAttributeNS(W, 'w:id', marker.permId);
  if (marker.edge === 'start') {
    for (const [key, attr] of [['ed', 'w:ed'], ['edGrp', 'w:edGrp']]) {
      if (marker[key]) node.setAttributeNS(W, attr, marker[key]); else node.removeAttributeNS(W, attr.slice(2));
    }
  }
  return node;
}
