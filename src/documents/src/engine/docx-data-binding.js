import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
// Besides custom XML parts, bindings map the document properties: Word exposes the core and
// extended properties parts as stores (the built-in store IDs of document-property controls).
const STORES = new Set([CUSTOM, 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties']);
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const fail = reason => { throw new UnsupportedDocumentError(`content-control data bindings with ${reason}`); };

function customXmlDocuments(parts) {
  const targets = new Set();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!name.endsWith('.rels')) continue;
    const location = /^(?:(.*)\/)?_rels\/([^/]*)\.rels$/.exec(name);
    if (!location) continue;
    for (const link of parseXml(bytes).documentElement.children) {
      if (link.namespaceURI !== REL || link.localName !== 'Relationship' || !STORES.has(link.getAttribute('Type'))) continue;
      if (![null, 'Internal'].includes(link.getAttribute('TargetMode'))) fail('external custom XML stores');
      const target = link.getAttribute('Target');
      if (!target || /[\\?#:\s]/.test(target) || target.startsWith('//')) fail('invalid custom XML targets');
      const path = target.startsWith('/') ? [] : (location[1] || '').split('/').filter(Boolean);
      for (const raw of (target.startsWith('/') ? target.slice(1) : target).split('/')) {
        let segment; try { segment = decodeURIComponent(raw); } catch { fail('invalid custom XML targets'); }
        if (segment === '..') { if (!path.length) fail('custom XML targets outside the package'); path.pop(); }
        else if (segment !== '.') {
          if (!segment || /[\\/#?:\x00-\x1f]/.test(segment)) fail('invalid custom XML targets');
          path.push(segment);
        }
      }
      const resolved = path.join('/');
      if (!Object.hasOwn(parts, resolved)) fail('missing custom XML parts');
      targets.add(resolved);
    }
  }
  return [...targets].map(name => parseXml(parts[name]));
}

// A consumer may fall back to another store when the requested item ID is absent.
// An unresolved binding is editable only after proving that its supported XPath
// selects nothing in any package store. Active synchronization remains guarded.
export function unresolvedBindingReader(parts) {
  let stores;
  return binding => {
    const id = binding.getAttributeNS(W, 'storeItemID'), xpath = binding.getAttributeNS(W, 'xpath');
    if (!id || !/^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(id)) fail('invalid store identifiers');
    const mapping = parseXml(`<binding ${binding.getAttributeNS(W, 'prefixMappings') || ''}/>`).documentElement;
    if (mapping.localName !== 'binding' || mapping.children.length || mapping.textContent.trim() || [...mapping.attributes].some(a => a.namespaceURI !== XMLNS)) fail('invalid prefix mappings');
    if (!xpath?.startsWith('/')) fail('unsupported XPath expressions');
    const steps = xpath.slice(1).split('/').map(step => {
      const match = /^([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?(?:\[([1-9]\d*)\])?$/.exec(step);
      if (!match) fail('unsupported XPath expressions');
      const prefix = match[2] ? match[1] : null, name = match[2] || match[1];
      const uri = prefix ? mapping.lookupNamespaceURI(prefix) : null;
      if (prefix && !uri) fail('unresolved XPath prefixes');
      const index = match[3] ? Number(match[3]) : null;
      if (index !== null && !Number.isSafeInteger(index)) fail('unsupported XPath indices');
      return { name, uri, index };
    });
    stores ??= customXmlDocuments(parts);
    for (const store of stores) {
      let nodes = [store];
      for (const step of steps) nodes = nodes.flatMap(node => {
        const matches = [...node.children].filter(child => child.localName === step.name && child.namespaceURI === step.uri);
        return step.index === null ? matches : matches.slice(step.index - 1, step.index);
      });
      if (nodes.length) fail('active XML mappings');
    }
  };
}
