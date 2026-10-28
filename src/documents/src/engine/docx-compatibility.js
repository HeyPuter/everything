import { UnsupportedDocumentError } from './errors.js';
export const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
export const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const understood = new Set([WPG, WPS, 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://schemas.openxmlformats.org/drawingml/2006/main', 'http://schemas.openxmlformats.org/drawingml/2006/picture']);
const fail = why => { throw new UnsupportedDocumentError(`alternate content with ${why}`); };
// Part 3: select the first Choice whose namespace requirements are understood.
// An unsupported feature within that branch is an error, not a reason to try a
// different branch. Retain the complete original container when saving.
export function alternateBranch(node) {
  let selected, fallback, choices = 0;
  for (const branch of node.children) {
    if (branch.namespaceURI !== MC) fail('unknown branches');
    if (branch.localName === 'Choice' && !fallback) {
      choices++;
      const required = branch.getAttribute('Requires')?.trim().split(/\s+/);
      if (!required?.length || required.some(p => !p || !branch.lookupNamespaceURI(p))) fail('missing or unbound Requires prefixes');
      if (!selected && required.every(p => understood.has(branch.lookupNamespaceURI(p)))) selected = branch;
    } else if (branch.localName === 'Fallback' && !fallback) fallback = branch;
    else fail('invalid branch ordering');
  }
  if (!choices) fail('no Choice');
  if (!selected && !fallback) fail('no supported branch');
  return selected || fallback;
}
function checkCompatibilityAttributes(node) {
  for (const prefix of (node.getAttributeNS(MC, 'MustUnderstand') || '').trim().split(/\s+/).filter(Boolean)) if (!understood.has(node.lookupNamespaceURI(prefix))) fail('unknown MustUnderstand namespace');
  if (node.hasAttributeNS(MC, 'ProcessContent')) fail('unsupported ProcessContent rules');
}
export function activeDescendants(node) {
  const result = [];
  checkCompatibilityAttributes(node);
  // A single valid drawing can contain more path nodes than JavaScript permits
  // function arguments. Walk in document order without spreading descendants
  // into push(), or borrowing the call stack for nested compatibility branches.
  const stack = [node.children[Symbol.iterator]()];
  while (stack.length) {
    const next = stack.at(-1).next();
    if (next.done) { stack.pop(); continue; }
    let child = next.value;
    if (child.namespaceURI === MC && child.localName === 'AlternateContent') {
      checkCompatibilityAttributes(child);
      child = alternateBranch(child);
    } else result.push(child);
    checkCompatibilityAttributes(child);
    if (child.firstElementChild) stack.push(child.children[Symbol.iterator]());
  }
  return result;
}
// Prefixes used in attribute VALUES (Requires/Ignorable) are invisible to the
// XML serializer. Carry in-scope namespace declarations on detached fragments.
// Reading a document serializes every paragraph this way, so the walks below index the
// attribute maps and follow siblings rather than copying live collections into arrays.
export function serializeFragment(node) {
  return serializeCopy(node.cloneNode(true), inScopeDeclarations(node));
}
// The namespace declarations on `node` and its ancestors, the nearest of each prefix first.
function inScopeDeclarations(node) {
  const declarations = [], bound = new Set();
  for (let at = node; at?.nodeType === 1; at = at.parentElement) {
    const attributes = at.attributes;
    for (let i = 0; i < attributes.length; i++) {
      const a = attributes[i];
      if (a.namespaceURI === XMLNS && !bound.has(a.name)) { bound.add(a.name); declarations.push([a.name, a.value]); }
    }
  }
  return declarations;
}
function serializeCopy(copy, declarations) {
  for (const [name, value] of declarations) copy.setAttributeNS(XMLNS, name, value);
  // Detached shells have no ancestors. Bind namespaced attributes explicitly so
  // DOM serializers cannot invent a prefix and reuse it on an unbound sibling.
  // Each element and its descendants in document order; a declaration added here is
  // appended to the element's attributes, so the count read first covers its own.
  for (let element = copy; element;) {
    const attributes = element.attributes;
    for (let i = 0, count = attributes.length; i < count; i++) {
      const a = attributes[i];
      if (a.prefix && a.namespaceURI && a.namespaceURI !== XMLNS && a.prefix !== 'xml' && element.lookupNamespaceURI(a.prefix) !== a.namespaceURI) element.setAttributeNS(XMLNS, `xmlns:${a.prefix}`, a.namespaceURI);
    }
    let next = element.firstElementChild;
    while (!next && element !== copy) { next = element.nextElementSibling; if (!next) element = element.parentElement; }
    element = next;
  }
  return new XMLSerializer().serializeToString(copy);
}

export function bindUsedNamespaces(node) {
  // Hoist unambiguous local prefixes too. Some DOM serializers otherwise reuse
  // a sibling's declaration when the same URI also has a different root prefix.
  // Never hoist a prefix that is rebound to a different URI in another scope.
  const prefixes = new Map();
  for (const element of [node, ...node.getElementsByTagName('*')]) for (const n of [element, ...element.attributes]) {
    if (!n.prefix || !n.namespaceURI || n.namespaceURI === XMLNS || n.prefix === 'xml') continue;
    if (!prefixes.has(n.prefix)) prefixes.set(n.prefix, new Set());
    prefixes.get(n.prefix).add(n.namespaceURI);
  }
  for (const [prefix, uris] of prefixes) if (uris.size === 1 && !node.lookupNamespaceURI(prefix)) node.setAttributeNS(XMLNS, `xmlns:${prefix}`, [...uris][0]);
}
