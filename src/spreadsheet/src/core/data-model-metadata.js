import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readDataModelArchive } from './data-model-archive.js';

const ENGINE = 'http://schemas.microsoft.com/analysisservices/2003/engine';
const MAX_XML = 16 * 1024 * 1024;
// Malformed markup refuses the part. A U+FFFD in it is well-formed text (a font name another program mangled,
// say), which the parser only warns about: refusing it refused the whole file.
const parser = new DOMParser({ onError: (level, message) => { if (level !== 'warning' || !/replacement character/i.test(message)) throw new Error(message); } });
const serializer = new XMLSerializer();
export function standaloneModelXml(node) {
  if (!node) return '';
  const clone = node.cloneNode(true), seen = new Set();
  // Namespace bindings can appear in attribute values (for example xsi:type),
  // so the serializer cannot discover every inherited prefix from tag names.
  for (let owner = node; owner?.nodeType === 1; owner = owner.parentNode) {
    for (const attr of Array.from(owner.attributes)) if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/' && !seen.has(attr.name)) {
      seen.add(attr.name); clone.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    }
  }
  return serializer.serializeToString(clone);
}
// XML 1.0 section 4.3.3: UTF-16 byte order is determined by its BOM.
// Archive headers and binary string dictionaries have their own fixed formats.
export function decodeModelXml(bytes, maxBytes = MAX_XML) {
  // ZIP readers can return octet views created in another window/realm.
  // instanceof rejects those even though TextDecoder accepts their bytes.
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength > maxBytes) throw new Error('Data Model XML exceeds size limit');
  bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  return { xml: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
}
export function parseModelXml(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_XML) throw new Error('Data Model XML exceeds size limit');
  // DTDs are unnecessary for Analysis Services/OOXML metadata. Exclude them
  // before parsing, without confusing comments or DAX text in CDATA with markup.
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error('Data Model XML declarations are unsupported');
  let depth = 0, count = 0;
  for (const token of markup.matchAll(/<\/?[^!?\s<>/](?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
    if (token[0][1] === '/') depth--;
    else { if (++count > 100000) throw new Error('Data Model XML exceeds node limit'); if (!token[0].endsWith('/>')) depth++; }
    if (depth > 128) throw new Error('Data Model XML exceeds depth limit');
  }
  const doc = parser.parseFromString(xml, 'application/xml');
  if (!doc.documentElement || doc.doctype) throw new Error('Invalid Data Model XML');
  return doc.documentElement;
}
export const modelChildren = (node, name, ns = ENGINE) => Array.from(node?.childNodes || [])
  .filter(n => n.nodeType === 1 && n.localName === name && n.namespaceURI === ns);
const child = (node, name) => modelChildren(node, name)[0];
const value = (node, name) => child(node, name)?.textContent || '';
const annotations = node => modelChildren(child(node, 'Annotations'), 'Annotation').map(a => ({ name: value(a, 'Name'), value: value(a, 'Value') }));
const identity = node => ({ id: value(node, 'ID'), name: value(node, 'Name') });
const bool = (node, name, fallback = true) => child(node, name) ? ['true', '1'].includes(value(node, name).trim()) : fallback;

/** Declared comparison properties, not host-locale defaults. Empty properties
 * remain unspecified; resolving inheritance and Windows collation versions is
 * separate from reading them. MS-SSAS DataItem/Dimension/Database and MS-XLDM
 * 2.5.2.3.1, 2.6.4 use different namespaces and locale property names.
 */
export function modelComparisonProperties(node, { namespace = ENGINE, localeName = 'Language', database = false } = {}) {
  const comparison = {};
  const read = (name, ns = namespace) => {
    const nodes = modelChildren(node, name, ns);
    if (nodes.length > 1) throw new Error(`Duplicate Data Model comparison ${name}`);
    if (nodes[0] && Array.from(nodes[0].childNodes).some(n => n.nodeType === 1)) throw new Error(`Invalid Data Model comparison ${name}`);
    return nodes[0]?.textContent;
  };
  if (localeName) {
    const locale = read(localeName)?.trim();
    if (locale !== undefined) {
      if (locale && (!/^\+?\d+$/.test(locale) || !Number.isSafeInteger(Number(locale)) || Number(locale) > 4294967295)) throw new Error('Invalid Data Model comparison locale');
      comparison.locale = locale ? Number(locale) : null;
    }
  }
  const collation = read('Collation');
  if (collation !== undefined) comparison.collation = collation;
  if (database) {
    const version = read('DefaultCollationVersion', 'http://schemas.microsoft.com/analysisservices/2012/engine/400');
    if (version !== undefined) {
      if (!['Earliest', '80', '90', '100'].includes(version.trim())) throw new Error('Invalid Data Model comparison version');
      comparison.version = version.trim();
    }
  }
  return Object.keys(comparison).length ? { comparison } : {};
}

function dataItem(node) {
  if (modelChildren(node, 'NullProcessing').length > 1) throw new Error('Duplicate Data Model null processing');
  const sources = modelChildren(node, 'Source');
  if (sources.length > 1) throw new Error('Duplicate Data Model source binding');
  const source = sources[0]; let binding;
  if (source) {
    const type = (source.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') || '').trim(), parts = type.split(':');
    if (!type || parts.length > 2 || parts.some(p => !/^[A-Za-z_][\w.-]*$/.test(p))) throw new Error('Invalid Data Model source binding type');
    if (['TableID', 'ColumnID'].some(name => modelChildren(source, name).length > 1)) throw new Error('Duplicate Data Model source binding identity');
    binding = { type: parts.at(-1), namespace: source.lookupNamespaceURI(parts.length === 2 ? parts[0] : null) || '', tableId: value(source, 'TableID'), columnId: value(source, 'ColumnID') };
  }
  return { dataType: value(node, 'DataType'), nullProcessing: value(node, 'NullProcessing'), trimming: value(node, 'Trimming'), format: value(node, 'Format'), ...modelComparisonProperties(node, { localeName: null }), ...(binding ? { source: binding } : {}) };
}

/** Split MDX script commands without treating delimiters in identifiers,
 * strings or comments as statement boundaries. Keep the expression itself
 * intact: parsing a declaration does not claim to evaluate its DAX body.
 */
export function modelMeasureDeclarations(source) {
  if (typeof source !== 'string' || source.length > MAX_XML) throw new Error('Model script exceeds size limit');
  const tokens = [], statements = [];
  let start = 0, pos = 0, depth = 0;
  while (pos < source.length) {
    if (tokens.length > 100000 || statements.length > 10000) throw new Error('Model script exceeds token limit');
    const begin = pos, c = source[pos];
    if (/\s/.test(c)) { pos++; continue; }
    if (source.startsWith('--', pos) || source.startsWith('//', pos)) { const end = source.indexOf('\n', pos); pos = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', pos)) { const end = source.indexOf('*/', pos + 2); if (end < 0) throw new Error('Unterminated model script comment'); pos = end + 2; continue; }
    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c; let text = '', ended = false; pos++;
      while (pos < source.length) {
        const x = source[pos++];
        if (x !== close) { text += x; continue; }
        if (source[pos] === close) { text += close; pos++; continue; }
        ended = true; break;
      }
      if (!ended) throw new Error('Unterminated model script identifier or string');
      tokens.push({ kind: c, text, begin, end: pos }); continue;
    }
    if (c === '(' || c === '{') depth++;
    if (c === ')' || c === '}') depth--;
    if (depth < 0 || depth > 128) throw new Error('Invalid model script nesting');
    if (c === ';' && !depth) { statements.push({ tokens: tokens.splice(0), source: source.slice(start, pos), end: pos }); start = ++pos; continue; }
    if (/[\p{L}_]/u.test(c)) {
      const match = /^[\p{L}\p{N}_]+/u.exec(source.slice(pos))[0]; pos += match.length;
      tokens.push({ kind: 'word', text: match, begin, end: pos });
    } else { pos++; tokens.push({ kind: c, text: c, begin, end: pos }); }
  }
  if (depth) throw new Error('Invalid model script nesting');
  statements.push({ tokens, source: source.slice(start), end: source.length });
  const measures = [], other = [];
  for (const statement of statements) {
    const t = statement.tokens;
    if (!t.length) continue;
    if (t[0]?.kind !== 'word' || t[0].text.toUpperCase() !== 'CREATE' || t[1]?.kind !== 'word' || t[1].text.toUpperCase() !== 'MEASURE') {
      other.push(statement.source.trim()); continue;
    }
    let i = 2, cube = null;
    const identifier = token => token && ['word', "'", '['].includes(token.kind);
    if (identifier(t[i]) && t[i + 1]?.kind === '.') { cube = t[i].text; i += 2; }
    const table = t[i++], name = t[i++], equal = t[i++];
    if (!identifier(table) || name?.kind !== '[' || equal?.kind !== '=' || !t[i]) throw new Error('Invalid CREATE MEASURE declaration');
    measures.push({ ...(cube ? { cube } : {}), table: table.text, name: name.text, expression: source.slice(equal.end, statement.end).trim() });
  }
  return { measures, other };
}

/** Inspect the schema/commands actually stored in the model. Parent identifiers
 * and XML namespaces distinguish objects with otherwise identical captions.
 * Original object XML is retained for properties not interpreted yet.
 */
export function readDataModelMetadata(input) {
  const archive = readDataModelArchive(input), objects = [], tables = [], scripts = [];
  let xmlBytes = 0;
  for (const file of archive.files) {
    if (!/\.(?:db|cub|dim|det|prt|scr)\.xml$/i.test(file.path)) continue;
    xmlBytes += file.size;
    if (file.size > MAX_XML || xmlBytes > MAX_XML * 4) throw new Error('Data Model metadata exceeds size limit');
    const bytes = file.read();
    const root = parseModelXml(decodeModelXml(bytes).xml);
    if (root.localName !== 'Load' || root.namespaceURI !== ENGINE) throw new Error('Unsupported Data Model metadata encoding');
    const parent = child(root, 'ParentObject'), definition = child(root, 'ObjectDefinition');
    const node = Array.from(definition?.childNodes || []).find(n => n.nodeType === 1 && n.namespaceURI === ENGINE);
    if (!node) throw new Error('Missing Data Model object definition');
    const scope = { database: value(parent, 'DatabaseID'), cube: value(parent, 'CubeID'), measureGroup: value(parent, 'MeasureGroupID') };
    const object = { type: node.localName, ...identity(node), parent: scope, path: file.path, xml: standaloneModelXml(node) };
    if (['Database', 'Dimension', 'Cube'].includes(node.localName)) Object.assign(object, modelComparisonProperties(node, { database: node.localName === 'Database' }));
    objects.push(object);
    if (node.localName === 'Dimension') {
      tables.push({ ...identity(node), ...(object.comparison ? { comparison: object.comparison } : {}), database: scope.database, path: file.path, dataFiles: value(node, 'DataFileList').split(';').filter(Boolean), columns: modelChildren(child(node, 'Attributes'), 'Attribute').map(a => ({
        ...identity(a), type: value(a, 'Type'), visible: bool(a, 'AttributeHierarchyVisible'), usage: value(a, 'Usage'),
        keys: modelChildren(child(a, 'KeyColumns'), 'KeyColumn').map(dataItem),
        annotations: annotations(a),
      })), annotations: annotations(node) });
    }
    if (node.localName === 'MdxScript') {
      const commands = modelChildren(child(node, 'Commands'), 'Command').map(command => {
        const text = value(command, 'Text');
        return { text, annotations: annotations(command), ...modelMeasureDeclarations(text) };
      });
      scripts.push({ ...identity(node), ...scope, commands });
    }
  }
  if (!objects.length) throw new Error('Unsupported Data Model schema storage');
  return { storageVersion: archive.version, objects, tables, scripts };
}
