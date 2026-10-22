import { readExternalVisibility, writeExternalVisibility } from './xlsx-external-visibility.js';
import { normalizeExternalWorkbooks } from './external-workbooks.js';
import { parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';
import { decodeXlsxString, encodeXlsxAttribute } from './xlsx-string.js';
import { parseRefText } from './refs.js';
import { cellName } from './cell.js';
import { xmlTag, xmlText } from './xlsx-export-styles.js';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const kids = (node, name, ns = MAIN) => modelChildren(node, name, ns);
const fail = reason => { throw new Error(`Invalid XLSX external workbook: ${reason}`); };
const one = (node, name, required = false) => { const a = kids(node, name); if (a.length > 1 || required && !a.length) fail(name); return a[0]; };
const relPath = part => part.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');
/**
 * Whether a relationship type names an external workbook's location. Besides the standard one, Excel writes
 * the location of a workbook it has no path for (one copied from before it was saved, or the template a
 * workbook came from) as xlPathMissing, and one in its startup or library folder as xlStartup, xlLibrary
 * or xlAlternateStartup [MS-XLSX 2.1.4]; a file holding one of these did not open at all. Each reads as a
 * location, and is written back as the standard one.
 */
export const externalLinkPathType = type => type === `${REL}/externalLinkPath`
  || /^http:\/\/schemas\.microsoft\.com\/office\/2006\/relationships\/xlExternalLinkPath\/(?:xlPathMissing|xlStartup|xlLibrary|xlAlternateStartup)$/.test(type || '');
const uint = v => { if (!/^\d+$/.test(v || '') || !Number.isSafeInteger(Number(v))) fail('index'); return Number(v); };
function resolve(owner, target) {
  if (!target || /[?#]|^[a-z][\w+.-]*:|^\/\//i.test(target)) fail('internal part target');
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (!p || p === '.') continue; if (p === '..') { if (!parts.length) fail('part traversal'); parts.pop(); } else parts.push(p); }
  return parts.join('/');
}
export function readXlsxExternalWorkbooks(book) {
  let totalBytes = 0, totalCells = 0;
  const parsed = new Map();
  const read = part => {
    if (parsed.has(part)) return parsed.get(part);
    const data = book.files?.[part]?.content; if (!data) return null;
    if (data.length > 16 * 1024 * 1024 || (totalBytes += data.length) > 64 * 1024 * 1024) fail('part size');
    const root = parseModelXml(new TextDecoder().decode(data));
    parsed.set(part, root);
    return root;
  };
  const owner = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml';
  // An .xlsb's parts are binary records, its links among them: there is no XML to read them from.
  if (!/\.xml$/i.test(owner)) return null;
  const workbook = read(owner); if (!workbook) return null;
  const refs = kids(one(workbook, 'externalReferences'), 'externalReference'); if (!refs.length) return null;
  if (refs.length > 1024) fail('link count');
  const relationship = (part, id, type, external = false) => {
    const matches = kids(read(relPath(part)), 'Relationship', PKG).filter(r => r.getAttribute('Id') === id);
    const r = matches[0];
    if (!id || matches.length !== 1 || (type === 'externalLinkPath' ? !externalLinkPathType(r.getAttribute('Type')) : r.getAttribute('Type') !== `${REL}/${type}`)
      || (r.getAttribute('TargetMode') === 'External') !== external || !r.getAttribute('Target')?.trim()) fail('relationship');
    return r.getAttribute('Target');
  };
  const extraRelationships = (part, primary) => {
    const ids = new Set();
    return kids(read(relPath(part)), 'Relationship', PKG).flatMap(r => {
      const id = r.getAttribute('Id');
      if (!id || ids.has(id) || r.getAttribute('TargetMode') !== 'External') fail('relationship');
      ids.add(id);
      return id === primary ? [] : [{ id, type: r.getAttribute('Type'), target: r.getAttribute('Target') }];
    });
  };
  const books = refs.map(ref => {
    const part = resolve(owner, relationship(owner, ref.getAttributeNS(REL, 'id'), 'externalLink'));
    const root = read(part); if (root?.namespaceURI !== MAIN || root.localName !== 'externalLink') fail('missing externalLink');
    const kinds = ['externalBook','ddeLink','oleLink'].flatMap(name => kids(root,name));
    if (kinds.length !== 1) fail('link kind');
    if (kinds[0].localName === 'ddeLink') {
      if (kids(read(relPath(part)), 'Relationship', PKG).length) fail('DDE relationships');
      return { kind: 'dde', xml: standaloneModelXml(root), sheets: [], names: [] };
    }
    if (kinds[0].localName === 'oleLink') return { kind: 'ole', xml: standaloneModelXml(root),
      target: relationship(part, kinds[0].getAttributeNS(REL, 'id'), 'oleObject', true),
      relationships: extraRelationships(part, kinds[0].getAttributeNS(REL, 'id')), sheets: [], names: [] };
    const source = one(root, 'externalBook', true);
    const target = relationship(part, source.getAttributeNS(REL, 'id'), 'externalLinkPath', true);
    const sheets = kids(one(source, 'sheetNames'), 'sheetName').map(n => ({ name: decodeXlsxString(n.getAttribute('val')), cells: null }));
    const seen = new Set();
    for (const data of kids(one(source, 'sheetDataSet'), 'sheetData')) {
      const index = uint(data.getAttribute('sheetId'));
      if (!sheets[index] || seen.has(index)) fail('sheet cache index'); seen.add(index);
      const refresh = data.getAttribute('refreshError');
      if (refresh && !['0', '1', 'true', 'false'].includes(refresh)) fail('refreshError');
      const sheet = sheets[index]; sheet.cells = {}; if (['1', 'true'].includes(refresh)) sheet.refreshError = true;
      const rows = new Set();
      for (const row of kids(data, 'row')) {
        const r = uint(row.getAttribute('r')); if (!r || r > 1048576 || rows.has(r)) fail('row'); rows.add(r);
        for (const cell of kids(row, 'cell')) {
          if (++totalCells > 1048576) fail('cell count');
          const ref = parseRefText(cell.getAttribute('r') || '');
          if (!ref || ref.kind !== 'cell' || ref.r1 !== r - 1) fail('cell reference');
          const key = `${ref.r1},${ref.c1}`; if (Object.hasOwn(sheet.cells, key)) fail('duplicate cell');
          const node = one(cell, 'v'), raw = node?.textContent, type = cell.getAttribute('t') || 'n';
          if (!['n', 'b', 'str', 'e'].includes(type)) fail('unsupported cell type');
          let value = null;
          if (node) {
            if (type === 'n') { if (!raw?.trim() || !Number.isFinite(Number(raw))) fail('numeric value'); value = Number(raw); }
            else if (type === 'b') { if (!['0', '1', 'true', 'false'].includes(raw)) fail('boolean value'); value = ['1', 'true'].includes(raw); }
            else if (type === 'str') value = decodeXlsxString(raw);
            else if (type === 'e') value = { error: raw };
            else fail('unsupported cell type');
          }
          sheet.cells[key] = value;
        }
      }
    }
    readExternalVisibility(root, target, sheets);
    const names = kids(one(source, 'definedNames'), 'definedName').map(n => ({ name: decodeXlsxString(n.getAttribute('name')),
      ref: decodeXlsxString(n.getAttribute('refersTo') || ''), ...(n.hasAttribute('sheetId') ? { sheet: uint(n.getAttribute('sheetId')) } : {}) }));
    return { target, sheets, names, relationships: extraRelationships(part, source.getAttributeNS(REL, 'id')), xml: standaloneModelXml(root) };
  });
  return normalizeExternalWorkbooks({ version: 1, books });
}

export function writeXlsxExternalWorkbooks(value, workbook, { get, set, contentType }) {
  const data = normalizeExternalWorkbooks(value); if (!data?.books.length) return workbook;
  const root = parseModelXml(workbook), doc = root.ownerDocument;
  if (kids(root, 'externalReferences').length) fail('duplicate external references');
  const refs = doc.createElementNS(MAIN, 'externalReferences');
  let rels = get('/xl/_rels/workbook.xml.rels'), next = 1;
  const used = new Set(kids(parseModelXml(rels), 'Relationship', PKG).map(r => r.getAttribute('Id')));
  const writeRelationships = (part, book, source, type) => {
    const extra = book.relationships || [], ids = new Set(extra.map(r => r.id));
    let id = source.getAttributeNS(REL,'id') || 'rId1', n = 1;
    while (ids.has(id)) id = `rIdWorkbook${n++}`;
    source.setAttributeNS(REL,'r:id',id);
    const all = [...extra, { id, type: `${REL}/${type}`, target: book.target }];
    set(relPath(part), `<Relationships xmlns="${PKG}">${all.map(r => xmlTag('Relationship', {
      Id: r.id, Type: r.type, Target: r.target, TargetMode: 'External',
    })).join('')}</Relationships>`);
  };
  for (const [index, book] of data.books.entries()) {
    let id; do { id = `rIdExternal${next++}`; } while (used.has(id)); used.add(id);
    const part = `/xl/externalLinks/externalLink${index + 1}.xml`;
    const reference = doc.createElementNS(MAIN, 'externalReference'); reference.setAttributeNS(REL, 'r:id', id); refs.appendChild(reference);
    rels = rels.replace('</Relationships>', `${xmlTag('Relationship', { Id: id, Type: `${REL}/externalLink`, Target: `externalLinks/externalLink${index + 1}.xml` })}</Relationships>`);
    if (book.kind) {
      const base = parseModelXml(book.xml);
      if (base?.namespaceURI !== MAIN || base.localName !== 'externalLink') fail('link XML');
      if (['externalBook','ddeLink','oleLink'].flatMap(name => kids(base,name)).length !== 1) fail('link kind');
      const source = one(base, book.kind === 'dde' ? 'ddeLink' : 'oleLink', true);
      if (book.kind === 'ole') {
        writeRelationships(part,book,source,'oleObject');
      }
      set(part, standaloneModelXml(base));
      contentType(part, 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml');
      continue;
    }
    const sheetNames = xmlTag('sheetNames', {}, book.sheets.map(s => xmlTag('sheetName', { val: encodeXlsxAttribute(s.name) })).join(''));
    const names = book.names.length ? xmlTag('definedNames', {}, book.names.map(n => xmlTag('definedName', { name: encodeXlsxAttribute(n.name), refersTo: encodeXlsxAttribute(n.ref), sheetId: n.sheet })).join('')) : '';
    const datasets = book.sheets.flatMap((s, i) => {
      if (s.cells == null) return [];
      const rows = new Map();
      for (const [key, v] of Object.entries(s.cells)) {
        const [r, c] = key.split(',').map(Number); if (!rows.has(r)) rows.set(r, []);
        const type = v == null || typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 'str' : 'e';
        const text = typeof v === 'string' ? encodeXlsxAttribute(v) : typeof v === 'boolean' ? Number(v) : v?.error ?? v;
        rows.get(r).push({ c, xml: xmlTag('cell', { r: cellName(r, c), t: type }, v == null ? '' : xmlTag('v', {}, xmlText(text))) });
      }
      return [xmlTag('sheetData', { sheetId: i, refreshError: s.refreshError ? 1 : null }, [...rows].sort((a,b) => a[0]-b[0]).map(([r, cells]) => xmlTag('row', { r: r + 1 }, cells.sort((a,b)=>a.c-b.c).map(c=>c.xml).join(''))).join(''))];
    }).join('');
    const base = book.xml ? parseModelXml(book.xml) : parseModelXml(`<externalLink xmlns="${MAIN}" xmlns:r="${REL}"><externalBook r:id="rId1"/></externalLink>`);
    if (base?.namespaceURI !== MAIN || base.localName !== 'externalLink'
      || ['externalBook','ddeLink','oleLink'].flatMap(name => kids(base,name)).length !== 1) fail('link XML');
    const source = one(base, 'externalBook', true);
    writeRelationships(part,book,source,'externalLinkPath');
    for (const name of ['sheetNames', 'definedNames', 'sheetDataSet']) for (const n of kids(source, name)) source.removeChild(n);
    const fragment = parseModelXml(`<externalBook xmlns="${MAIN}">${sheetNames}${names}${datasets ? xmlTag('sheetDataSet', {}, datasets) : ''}</externalBook>`);
    const insertion = source.firstChild;
    for (const child of Array.from(fragment.childNodes)) source.insertBefore(base.ownerDocument.importNode(child, true), insertion);
    writeExternalVisibility(base, book);
    set(part, standaloneModelXml(base));
    contentType(part, 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml');
  }
  const following = new Set(['definedNames','calcPr','oleSize','customWorkbookViews','pivotCaches','smartTagPr','smartTagTypes','webPublishing','fileRecoveryPr','webPublishObjects','extLst']);
  const before = Array.from(root.childNodes).find(n => n.nodeType === 1 && following.has(n.localName));
  root.insertBefore(refs, before || null); set('/xl/_rels/workbook.xml.rels', rels);
  return standaloneModelXml(root);
}
