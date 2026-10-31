// A small non-validating XML reader for GPX and KML. It builds the DOM subset @tmcw/togeojson reads (elements,
// text, CDATA, attributes, namespaces, getElementsByTagName[NS], textContent), never expands DTD entities, and caps
// input size, depth and node count. Whitespace-only text is dropped.
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const DOCUMENT = 9;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

class NodeList extends Array {
  item(index) { return this[index] ?? null; }
}
const EMPTY = Object.freeze(new NodeList());

class XmlNode {
  constructor(type, parent) { this.nodeType = type; this.parentNode = parent; }
  normalize() {}
}

class XmlText extends XmlNode {
  constructor(type, parent, data) { super(type, parent); this.data = data; }
  get nodeName() { return this.nodeType === CDATA ? '#cdata-section' : '#text'; }
  get nodeValue() { return this.data; }
  get textContent() { return this.data; }
  get childNodes() { return EMPTY; }
}

function collect(root, test) {
  const out = new NodeList();
  const stack = [];
  for (let i = root.childNodes.length - 1; i >= 0; i--) stack.push(root.childNodes[i]);
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType !== ELEMENT) continue;
    if (test(node)) out.push(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

class XmlParent extends XmlNode {
  constructor(type, parent) { super(type, parent); this.childNodes = new NodeList(); }
  get children() { return this.childNodes.filter((node) => node.nodeType === ELEMENT); }
  get textContent() {
    let text = '';
    const stack = [this];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === TEXT || node.nodeType === CDATA) { text += node.data; continue; }
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return text;
  }
  getElementsByTagName(name) { return collect(this, (node) => name === '*' || node.tagName === name); }
  getElementsByTagNameNS(ns, local) {
    return collect(this, (node) => (ns === '*' || node.namespaceURI === (ns || null)) && (local === '*' || node.localName === local));
  }
}

class XmlElement extends XmlParent {
  constructor(parent, tagName, attributes, namespaceURI) {
    super(ELEMENT, parent);
    const colon = tagName.indexOf(':');
    this.tagName = tagName;
    this.localName = colon === -1 ? tagName : tagName.slice(colon + 1);
    this.prefix = colon === -1 ? null : tagName.slice(0, colon);
    this.namespaceURI = namespaceURI;
    this.attributes = attributes;
  }
  get nodeName() { return this.tagName; }
  getAttribute(name) { return this.attributes.find((attribute) => attribute.name === name)?.value ?? null; }
  hasAttribute(name) { return this.attributes.some((attribute) => attribute.name === name); }
}

class XmlDocument extends XmlParent {
  constructor() { super(DOCUMENT, null); }
  get nodeName() { return '#document'; }
  get documentElement() { return this.childNodes.find((node) => node.nodeType === ELEMENT) ?? null; }
}

const NAMED = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;
function codePoint(value, fallback) {
  return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : fallback;
}
/** Decodes the five XML entities and character references; anything else stays as written. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, dec, hex, name) => (name ? NAMED[name] : codePoint(dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16), match)));
}

const INVALID_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
/** Escapes text for element content and quoted attributes, dropping characters XML 1.0 cannot carry. */
export function escapeXml(value) {
  return String(value ?? '').replace(INVALID_CHARS, '').replace(/[&<>"']/g, (char) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[char]};`);
}

const NAME = /[^\s/>=]+/y;
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;
const invalid = () => new IoError('invalid_xml');

function skipDeclaration(text, start) {
  let depth = 0;
  let quote = 0;
  for (let i = start + 2; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (quote) { if (char === quote) quote = 0; continue; }
    if (char === 34 || char === 39) quote = char;
    else if (char === 91) depth += 1;
    else if (char === 93) depth -= 1;
    else if (char === 62 && depth <= 0) return i + 1;
  }
  throw invalid();
}

/** Parses an XML string into a read-only document; throws `IoError('invalid_xml')` on malformed input. */
export function parseXml(text, { maxNodes = IO_LIMITS.xmlNodes, maxDepth = IO_LIMITS.xmlDepth, maxLength = IO_LIMITS.kmlBytes } = {}) {
  if (typeof text !== 'string' || !text.length || text.length > maxLength) throw invalid();
  const doc = new XmlDocument();
  let parent = doc;
  let depth = 0;
  let nodes = 0;
  const base = Object.create(null);
  base.xml = XML_NS;
  const scopes = [base];
  const add = (node) => {
    if ((nodes += 1) > maxNodes) throw invalid();
    parent.childNodes.push(node);
  };
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const end = lt === -1 ? text.length : lt;
    if (end > i) {
      const raw = text.slice(i, end);
      if (/\S/.test(raw)) {
        if (parent === doc) throw invalid();
        add(new XmlText(TEXT, parent, decodeEntities(raw)));
      }
    }
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close === -1) throw invalid();
      i = close + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close === -1 || parent === doc) throw invalid();
      add(new XmlText(CDATA, parent, text.slice(lt + 9, close)));
      i = close + 3;
    } else if (text.charCodeAt(lt + 1) === 63) {
      const close = text.indexOf('?>', lt + 2);
      if (close === -1) throw invalid();
      i = close + 2;
    } else if (text.charCodeAt(lt + 1) === 33) {
      // DOCTYPE and other declarations are skipped whole; their entities are never defined.
      i = skipDeclaration(text, lt);
    } else if (text.charCodeAt(lt + 1) === 47) {
      const close = text.indexOf('>', lt + 2);
      if (close === -1 || parent === doc || parent.tagName !== text.slice(lt + 2, close).trim()) throw invalid();
      parent = parent.parentNode;
      scopes.pop();
      depth -= 1;
      i = close + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const name = NAME.exec(text)?.[0];
      if (!name || NAME.lastIndex !== lt + 1 + name.length) throw invalid();
      let at = NAME.lastIndex;
      const attributes = [];
      let scope = scopes.at(-1);
      for (;;) {
        ATTRIBUTE.lastIndex = at;
        const match = ATTRIBUTE.exec(text);
        if (!match) break;
        const value = decodeEntities(match[2] ?? match[3]);
        if (attributes.length >= 256 || attributes.some((attribute) => attribute.name === match[1])) throw invalid();
        attributes.push({ name: match[1], value });
        if (match[1] === 'xmlns' || match[1].startsWith('xmlns:')) {
          if (scope === scopes.at(-1)) scope = Object.create(scope);
          scope[match[1] === 'xmlns' ? '' : match[1].slice(6)] = value || null;
        }
        at = ATTRIBUTE.lastIndex;
      }
      TAG_END.lastIndex = at;
      const close = TAG_END.exec(text);
      if (!close) throw invalid();
      if (parent === doc && doc.documentElement) throw invalid();
      const colon = name.indexOf(':');
      const prefix = colon === -1 ? '' : name.slice(0, colon);
      const element = new XmlElement(parent, name, attributes, scope[prefix] ?? null);
      add(element);
      i = TAG_END.lastIndex;
      if (!close[1]) {
        if ((depth += 1) > maxDepth) throw invalid();
        parent = element;
        scopes.push(scope);
      }
    }
  }
  if (parent !== doc || !doc.documentElement) throw invalid();
  return doc;
}
