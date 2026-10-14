import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';
import { writeCommentMarker } from './docx-comments.js';
import { writePermissionMarker } from './docx-permissions.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const serialize = n => new XMLSerializer().serializeToString(n);

export function bookmarkReader() {
  let order = 0;
  return (node, offset, link, context = {}) => {
    const edge = node.localName === 'bookmarkStart' ? 'start' : 'end';
    if (node.children.length || node.textContent.trim()) throw new UnsupportedDocumentError('bookmark marker content');
    for (const attr of [...node.attributes]) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (attr.namespaceURI !== W || !['id', 'displacedByCustomXml', ...(edge === 'start' ? ['name', 'colFirst', 'colLast'] : [])].includes(attr.localName)) throw new UnsupportedDocumentError(`bookmark attribute ${attr.name}`);
    }
    const raw = node.getAttributeNS(W, 'id');
    if (!/^[+-]?\d+$/.test(raw || '')) throw new UnsupportedDocumentError('invalid bookmark identifier');
    if (edge === 'start' && !node.hasAttributeNS(W, 'name')) throw new UnsupportedDocumentError('missing bookmark name');
    if (node.hasAttributeNS(W, 'displacedByCustomXml') && !['next', 'prev'].includes(node.getAttributeNS(W, 'displacedByCustomXml'))) throw new UnsupportedDocumentError('invalid bookmark displacement');
    const first = node.getAttributeNS(W, 'colFirst'), last = node.getAttributeNS(W, 'colLast');
    if (first !== null || last !== null) {
      if (!/^[+-]?\d+$/.test(first || '') || !/^[+-]?\d+$/.test(last || '')) throw new UnsupportedDocumentError('incomplete or invalid bookmark columns');
    }
    return { id: BigInt(raw).toString(), edge, offset, order: order++, ...(edge === 'start' ? { name: node.getAttributeNS(W, 'name') } : {}), ...(first !== null && (context.cellId || context.tableId) ? { tableColumns: {first:BigInt(first).toString(),last:BigInt(last).toString()} } : {}), ...(link ? { linkId: link.id } : {}), shell: serialize(node) };
  };
}

export function writeBookmark(marker, doc) {
  if (marker.comment) return writeCommentMarker(marker, doc);
  if (marker.perm) return writePermissionMarker(marker, doc);
  const n = marker.shell ? doc.importNode(parseXml(marker.shell).documentElement, true) : doc.createElementNS(W, marker.edge === 'start' ? 'w:bookmarkStart' : 'w:bookmarkEnd');
  if (!marker.shell || BigInt(n.getAttributeNS(W, 'id')).toString() !== marker.id) n.setAttributeNS(W, 'w:id', marker.id);
  if (marker.edge === 'start') n.setAttributeNS(W, 'w:name', marker.name);
  if (marker.edge === 'start' && marker.tableColumns) for (const [key, attr] of [['first', 'colFirst'], ['last', 'colLast']]) {
    const value = marker.tableColumns[key];
    const old = n.getAttributeNS(W, attr);
    if (old === null || BigInt(old) !== BigInt(value)) n.setAttributeNS(W, 'w:' + attr, value);
  }
  return n;
}
