import { strToU8 } from 'fflate';
import { elementChildren, parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';
import { checkedHyperlinkTarget, hyperlinkId, internalHyperlink } from './hyperlinks.js';
import { relationshipPartPath } from './package-part-paths.js';
import { relationshipEntries, relationshipRoot } from './docx-relationships.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const serialize = n => new XMLSerializer().serializeToString(n);
const children = n => elementChildren(n);
const relationships = (parts, path) => parts[path] ? parseXml(parts[path]) : parseXml(`<Relationships xmlns="${REL}"/>`);

export function hyperlinkReader(parts, sourcePart = 'word/document.xml') {
  const path = relationshipPartPath(sourcePart);
  let root, byId;
  return node => {
    if ([...node.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) throw new UnsupportedDocumentError('text outside hyperlink runs');
    for (const attr of [...node.attributes]) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (attr.namespaceURI === R && attr.localName === 'id') continue;
      if (attr.namespaceURI === W && ['anchor', 'docLocation', 'history', 'tgtFrame', 'tooltip'].includes(attr.localName)) continue;
      throw new UnsupportedDocumentError(`hyperlink attribute ${attr.name}`);
    }
    const sourceId = node.getAttributeNS(R, 'id');
    if (node.hasAttributeNS(R, 'id') && !sourceId) throw new UnsupportedDocumentError('empty hyperlink relationship identifier');
    if (node.getAttributeNS(W, 'docLocation')) throw new UnsupportedDocumentError('hyperlink document locations');
    const history = node.getAttributeNS(W, 'history');
    if (node.hasAttributeNS(W, 'history') && !['true', 'false', '1', '0', 'on', 'off'].includes(history)) throw new UnsupportedDocumentError('invalid hyperlink history');
    const common = { id: hyperlinkId(), shell: serialize(node.cloneNode(false)), tooltip: node.getAttributeNS(W, 'tooltip') || '', history: ['true', '1', 'on'].includes(history) };
    if (!sourceId) return { ...common, anchor: node.hasAttributeNS(W, 'anchor') ? node.getAttributeNS(W, 'anchor') : null };
    // The relationships part is read once (relationshipEntries) and indexed: a document with
    // hundreds of links would otherwise scan every relationship for each link.
    if (!byId) {
      const bytes = parts[path] || `<Relationships xmlns="${REL}"/>`;
      root = relationshipRoot(bytes); byId = new Map();
      for (const r of relationshipEntries(bytes)) {
        const id = r.attribute('Id');
        if (byId.has(id)) byId.get(id).push(r); else byId.set(id, [r]);
      }
    }
    if (root.namespaceURI !== REL || root.localName !== 'Relationships') throw new UnsupportedDocumentError('invalid hyperlink relationships part');
    const matches = byId.get(sourceId) || [];
    const rel = matches[0];
    if (matches.length !== 1 || rel.namespaceURI !== REL || rel.localName !== 'Relationship' || rel.attribute('Type') !== `${R}/hyperlink` || rel.attribute('TargetMode') !== 'External') throw new UnsupportedDocumentError('missing, duplicate or unsupported hyperlink relationship');
    // Part 2 relationships permit any URI reference. A destination the editor
    // cannot open (a relative or file path, unescaped spaces) is kept verbatim.
    const target = rel.attribute('Target');
    let retainedTarget = false;
    try { checkedHyperlinkTarget(target); } catch { retainedTarget = true; }
    return { ...common, target, sourceId, ...(retainedTarget ? { retainedTarget } : {}) };
  };
}

// Source fragments can contain generated prefixes whose declarations are scoped
// to siblings. Rebind every link, including unchanged paragraphs, before output.
export function bindHyperlinkNamespaces(doc) {
  const nodes = [...doc.getElementsByTagNameNS(W, 'hyperlink')]; if (!nodes.length) return;
  let prefix = 'r'; while (doc.documentElement.lookupNamespaceURI(prefix) && doc.documentElement.lookupNamespaceURI(prefix) !== R) prefix += 'Link';
  doc.documentElement.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, R);
  for (const node of nodes) {
    if (!node.hasAttributeNS(R, 'id')) continue;
    const id = node.getAttributeNS(R, 'id');
    node.removeAttributeNS(R, 'id'); node.setAttributeNS(R, `${prefix}:id`, id);
  }
}

// Called after image/style writers, so their newly allocated relationships survive.
export function hyperlinkWriter(parts, paragraphs, doc, sourcePart = 'word/document.xml') {
  const path = relationshipPartPath(sourcePart);
  const links = paragraphs.flatMap(p => [...p.runs.filter(r => r.link&&!r.link.fieldId).map(r => r.link), ...(p.fieldMarkers||[]).filter(m=>m.link&&!m.link.fieldId).map(m=>m.link)]);
  if (!links.length) return () => { throw new Error('Missing hyperlink.'); };
  const rels = relationships(parts, path), entries = children(rels.documentElement), byTarget = new Map(), ids = new Set(entries.map(r => r.getAttribute('Id')));
  for (const r of entries) if (r.namespaceURI === REL && r.localName === 'Relationship' && r.getAttribute('Type') === `${R}/hyperlink` && r.getAttribute('TargetMode') === 'External') byTarget.set(r.getAttribute('Target'), r.getAttribute('Id'));
  const relationFor = new Map(); let changed = false, number = 0;
  for (const link of links) {
    if (internalHyperlink(link)) continue;
    if (!link.retainedTarget) checkedHyperlinkTarget(link.target);
    else if (typeof link.target !== 'string' || !link.target) throw new Error('Missing hyperlink target.');
    const original = entries.find(r => r.getAttribute('Id') === link.sourceId);
    let id = original?.getAttribute('Type') === `${R}/hyperlink` && original.getAttribute('TargetMode') === 'External' && original.getAttribute('Target') === link.target ? link.sourceId : byTarget.get(link.target);
    if (!id) {
      do { id = `rLink${++number}`; } while (ids.has(id)); ids.add(id);
      const r = rels.createElementNS(REL, 'Relationship');
      for (const [key, value] of Object.entries({ Id: id, Type: `${R}/hyperlink`, Target: link.target, TargetMode: 'External' })) r.setAttribute(key, value);
      rels.documentElement.append(r); byTarget.set(link.target, id); changed = true;
    }
    relationFor.set(link, id);
  }
  if (changed) parts[path] = strToU8(serialize(rels));
  return link => {
    const node = link.shell ? doc.importNode(parseXml(link.shell).documentElement, false) : doc.createElementNS(W, 'w:hyperlink');
    if(!link.shell){if(link.tooltip)node.setAttributeNS(W,'w:tooltip',link.tooltip);if(link.frame)node.setAttributeNS(W,'w:tgtFrame',link.frame);}
    if (internalHyperlink(link)) {
      node.removeAttributeNS(R, 'id');
      if (link.anchor === null) node.removeAttributeNS(W, 'anchor'); else node.setAttributeNS(W, 'w:anchor', link.anchor);
    } else node.setAttributeNS(R, 'r:id', relationFor.get(link));
    return node;
  };
}
