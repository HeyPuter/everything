import { writeNativePivotRuleBindings } from './native-pivot-rule-bindings.js';
import { decodeXlsxString } from './xlsx-string.js';
import { parseModelXml, modelChildren, standaloneModelXml as serialize } from './data-model-metadata.js';
import { normalizeNativePivots } from './native-pivots.js';
import { xmlTag as tag } from './xlsx-export-styles.js';
import { externalLinkPathType } from './xlsx-external-workbooks.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const child = (node, name, ns = MAIN) => modelChildren(node, name, ns)[0];
const kids = (node, name, ns = MAIN) => modelChildren(node, name, ns);
const relId = node => node?.getAttributeNS(REL, 'id');
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const TYPES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
const CACHE_EXT = { x14: '{876F7934-8845-4945-9796-88D515C7AA90}', x15: '{841E416B-1EF1-43b6-AB56-02D37102CBD5}' };
const PIVOT_EXT = '{983426D0-5260-488c-9760-48F4B6AC55F4}';
function resolve(owner, target) {
  if (!target || /[?#]|^[a-z][\w+.-]*:|^\/\//i.test(target)) return null;
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (!p || p === '.') continue; if (p === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(p); }
  return parts.join('/');
}
const relPath = part => part.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');

/** Follow explicit workbook and worksheet references, including chart-only
 * pivots and their x14/x15 cache lists. Cache IDs are scoped to this package.
 */
export function readXlsxPivots(book, wb) {
  const xml = path => book.files?.[path]?.content ? new TextDecoder().decode(book.files[path].content) : '';
  const root = path => { const s = xml(path); return s ? parseModelXml(s) : null; };
  const related = (owner, id, type) => {
    const relationship = kids(root(relPath(owner)), 'Relationship', PACKAGE).find(r => r.getAttribute('Id') === id
      && r.getAttribute('Type') === `${REL}/${type}` && r.getAttribute('TargetMode') !== 'External');
    return relationship ? resolve(owner, relationship.getAttribute('Target')) : null;
  };
  const byType = (owner, type) => {
    const rel = kids(root(relPath(owner)), 'Relationship', PACKAGE).find(r => r.getAttribute('Type') === `${REL}/${type}` && r.getAttribute('TargetMode') !== 'External');
    return rel ? resolve(owner, rel.getAttribute('Target')) : null;
  };
  const workbookPath = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml';
  const workbook = root(workbookPath);
  if (!workbook) return null;
  const caches = [], tables = [], byId = new Map();
  const lists = [child(workbook, 'pivotCaches'), ...Array.from(workbook.getElementsByTagNameNS(X14, 'pivotCaches')), ...Array.from(workbook.getElementsByTagNameNS(X15, 'pivotCaches'))].filter(Boolean);
  for (const node of lists.flatMap(list => Array.from(list.childNodes).filter(n => n.nodeType === 1 && n.localName === 'pivotCache' && [MAIN, X14, X15].includes(n.namespaceURI)))) {
    const id = node.getAttribute('cacheId'), part = related(workbookPath, relId(node), 'pivotCacheDefinition');
    if (!/^\d+$/.test(id) || !part || byId.has(id)) throw new Error('Invalid native pivot cache reference');
    const definition = root(part);
    if (definition?.localName !== 'pivotCacheDefinition' || definition.namespaceURI !== MAIN) throw new Error('Missing native pivot cache definition');
    const recordsId = relId(definition), recordsPart = recordsId && related(part, recordsId, 'pivotCacheRecords');
    if (recordsId && (!recordsPart || !xml(recordsPart))) throw new Error('Missing native pivot cache records');
    const scope = node.parentNode.namespaceURI === X15 ? 'x15' : node.parentNode.namespaceURI === X14 ? 'x14' : 'main';
    const source = child(child(definition, 'cacheSource'), 'worksheetSource');
    let sourceWorkbook;
    if (source?.hasAttributeNS(REL, 'id')) {
      const links = kids(root(relPath(part)), 'Relationship', PACKAGE).filter(r => r.getAttribute('Id') === relId(source));
      if (!relId(source) || links.length !== 1 || !externalLinkPathType(links[0].getAttribute('Type'))
          || links[0].getAttribute('TargetMode') !== 'External' || !links[0].getAttribute('Target')?.trim()) throw new Error('Invalid external pivot worksheet source relationship');
      sourceWorkbook = links[0].getAttribute('Target');
    }
    const sourceSheetId = source && !relId(source) ? wb.sheetByName(source.getAttribute('sheet'))?.id || null : null;
    const cache = { key: part, xml: serialize(definition), records: recordsPart ? xml(recordsPart) : '', scope, sourceSheetId, sourceRef: source?.getAttribute('ref') || '',
      ...(sourceWorkbook == null ? {} : { sourceWorkbook }) };
    caches.push(cache); byId.set(id, cache);
  }
  if (!caches.length) return null;
  const add = (ownerPart, id, owner) => {
    const part = related(ownerPart, id, 'pivotTable'), definition = part && root(part);
    if (definition?.localName !== 'pivotTableDefinition' || definition.namespaceURI !== MAIN) throw new Error('Missing native PivotTable definition');
    const cache = byId.get(definition.getAttribute('cacheId'));
    const cachePart = byType(part, 'pivotCacheDefinition');
    if (!cache || cachePart !== cache.key) throw new Error('Inconsistent native PivotTable cache');
    tables.push({ name: definition.getAttribute('name'), cache: cache.key, owner, ref: child(definition, 'location')?.getAttribute('ref') || '', xml: serialize(definition) });
  };
  for (const sheet of kids(child(workbook, 'sheets'), 'sheet')) {
    const ownerPart = related(workbookPath, relId(sheet), 'worksheet'), owner = wb.sheetByName(sheet.getAttribute('name'));
    if (!ownerPart || !owner) continue;
    // Worksheet PivotTable relationships are implicit: no worksheet XML tag.
    for (const relation of kids(root(relPath(ownerPart)), 'Relationship', PACKAGE)) if (relation.getAttribute('Type') === `${REL}/pivotTable` && relation.getAttribute('TargetMode') !== 'External') add(ownerPart, relation.getAttribute('Id'), owner.id);
  }
  for (const reference of Array.from(workbook.getElementsByTagNameNS(X15, 'pivotTableReference'))) add(workbookPath, relId(reference), null);
  const styleRoot = root(byType(workbookPath, 'styles'));
  const dxfs = kids(child(styleRoot, 'dxfs'), 'dxf').map(serialize);
  const formats = Object.fromEntries(kids(child(styleRoot, 'numFmts'), 'numFmt').map(n => [n.getAttribute('numFmtId'), decodeXlsxString(n.getAttribute('formatCode'))]));
  // Built-in IDs need workbook-local codes too: the vendor's global SSF table
  // can be reset or changed by another read/write before a later pivot refresh.
  // Capture only referenced formats, using this read's effective code table.
  for (const item of [...caches, ...tables]) {
    const nodes = parseModelXml(item.xml).getElementsByTagNameNS(MAIN, '*');
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i].getAttribute('numFmtId');
      if (raw == null || !/^\+?\d+$/.test(raw.trim())) continue;
      const id = Number(raw), code = book.SSF?.[id];
      if (!Object.hasOwn(formats, id) && typeof code === 'string') formats[id] = code;
    }
  }
  const names = new Set(tables.flatMap(p => Array.from(parseModelXml(p.xml).getElementsByTagNameNS(MAIN, 'pivotTableStyleInfo'), n => n.getAttribute('name'))));
  const styles = kids(child(styleRoot, 'tableStyles'), 'tableStyle').filter(n => names.has(n.getAttribute('name'))).map(n => ({ name: n.getAttribute('name'), xml: serialize(n) }));
  const result = normalizeNativePivots({ version: 1, caches, tables, dxfs, formats, styles, connections: xml(byType(workbookPath, 'connections')) });
  if (!result) throw new Error('Native pivot storage exceeds limits');
  return result;
}

/** Rebase style/cache/relationship IDs into the new package while preserving
 * the native definitions, records, hierarchy settings and cached reports.
 * Refresh is a separate operation; exporting an edited source does not invent
 * a refreshed pivot cache or replace the pivot with worksheet formulas.
 */
export function writeXlsxPivots(wb, workbook, { get, set, contentType, styles, pivotRulePriorities }) {
  const pivots = normalizeNativePivots(wb.nativePivots);
  if (!pivots) {
    if (wb.nativePivots) throw new Error('Invalid native pivot storage');
    return workbook;
  }
  const emptyRels = HEADER + `<Relationships xmlns="${PACKAGE}"></Relationships>`;
  const addRel = (owner, kind, target, external = false) => {
    const path = relPath(owner), current = get(path) || emptyRels, doc = parseModelXml(current);
    const used = new Set(kids(doc, 'Relationship', PACKAGE).map(n => n.getAttribute('Id')));
    let id = 'puterPivot1', next = 2; while (used.has(id)) id = `puterPivot${next++}`;
    const node = doc.ownerDocument.createElementNS(PACKAGE, 'Relationship');
    node.setAttribute('Id', id); node.setAttribute('Type', `${REL}/${kind}`); node.setAttribute('Target', target);
    if (external) node.setAttribute('TargetMode', 'External');
    doc.appendChild(node); set(path, HEADER + serialize(doc)); return id;
  };
  const numberFormats = new Map(), differentialFormats = new Map(), pivotStyles = new Map();
  const numberFormat = id => {
    if (!/^\d+$/.test(id)) throw new Error('Invalid pivot number format');
    // Explicit/effective codes are workbook-local, even when their source ID
    // lies in Excel's built-in range. Reuse the destination's code allocation.
    if (Number(id) < 164 && !Object.hasOwn(pivots.formats, id)) return Number(id);
    if (!numberFormats.has(id)) {
      if (typeof pivots.formats[id] !== 'string') throw new Error('Missing pivot number format');
      numberFormats.set(id, styles.numberFormatCode(pivots.formats[id]));
    }
    return numberFormats.get(id);
  };
  const dxf = id => {
    if (!differentialFormats.has(id)) {
      if (!/^\d+$/.test(id) || !pivots.dxfs[Number(id)]) throw new Error('Missing pivot differential style');
      const node = parseModelXml(pivots.dxfs[Number(id)]);
      for (const format of Array.from(node.getElementsByTagNameNS(MAIN, 'numFmt'))) {
        if (format.hasAttribute('numFmtId')) format.setAttribute('numFmtId', String(format.hasAttribute('formatCode') ? styles.numberFormatCode(decodeXlsxString(format.getAttribute('formatCode'))) : numberFormat(format.getAttribute('numFmtId'))));
      }
      differentialFormats.set(id, styles.differentialXml(serialize(node)));
    }
    return differentialFormats.get(id);
  };
  const rebase = (xml, rootName) => {
    const node = parseModelXml(xml);
    if (node.localName !== rootName || node.namespaceURI !== MAIN) throw new Error('Invalid native pivot part');
    const all = [node, ...Array.from(node.getElementsByTagName('*'))];
    for (const element of all) {
      if (element.hasAttribute('numFmtId')) element.setAttribute('numFmtId', String(numberFormat(element.getAttribute('numFmtId'))));
      if (element.hasAttribute('dxfId')) element.setAttribute('dxfId', String(dxf(element.getAttribute('dxfId'))));
    }
    return node;
  };
  for (const style of pivots.styles) {
    const node = rebase(style.xml, 'tableStyle'), name = styles.pivotStyle(serialize(node));
    pivotStyles.set(style.name, name);
  }
  const cacheRefs = { main: [], x14: [], x15: [] }, cacheIds = new Map();
  for (const [id, cache] of pivots.caches.entries()) {
    const path = `/xl/pivotCache/pivotCacheDefinition${id + 1}.xml`, node = rebase(cache.xml, 'pivotCacheDefinition');
    node.removeAttributeNS(REL, 'id');
    const source = child(child(node, 'cacheSource'), 'worksheetSource'), sourceSheet = cache.sourceSheetId && wb.sheet(cache.sourceSheetId);
    if (cache.sourceWorkbook != null) {
      if (!source) throw new Error('Missing external pivot worksheet source');
      source.setAttributeNS(REL, 'r:id', addRel(path, 'externalLinkPath', cache.sourceWorkbook, true));
    } else if (source?.hasAttributeNS(REL, 'id')) throw new Error('Missing external pivot workbook target');
    if (source && sourceSheet) source.setAttribute('sheet', sourceSheet.name);
    if (source && cache.sourceRef) source.setAttribute('ref', cache.sourceRef);
    if (cache.records) {
      const records = `/xl/pivotCache/pivotCacheRecords${id + 1}.xml`;
      set(records, cache.records); contentType(records, `${TYPES}pivotCacheRecords+xml`);
      node.setAttributeNS(REL, 'r:id', addRel(path, 'pivotCacheRecords', records));
    }
    set(path, HEADER + serialize(node)); contentType(path, `${TYPES}pivotCacheDefinition+xml`);
    const relationship = addRel('/xl/workbook.xml', 'pivotCacheDefinition', path);
    cacheRefs[cache.scope].push(tag('pivotCache', { cacheId: id, 'r:id': relationship }));
    cacheIds.set(cache.key, { id, path });
  }
  const standalone = [];
  for (const [index, pivot] of pivots.tables.entries()) {
    const owner = pivot.owner == null ? null : wb.sheet(pivot.owner);
    if (pivot.owner != null && !owner) continue;
    const cache = cacheIds.get(pivot.cache), path = `/xl/pivotTables/pivotTable${index + 1}.xml`;
    const node = rebase(pivot.xml, 'pivotTableDefinition'); node.setAttribute('cacheId', String(cache.id)); node.setAttribute('name', pivot.name);
    writeNativePivotRuleBindings(node, pivot, pivotRulePriorities?.get(pivot.owner));
    const location = child(node, 'location');
    if (location && pivot.ref) location.setAttribute('ref', pivot.ref);
    for (const style of Array.from(node.getElementsByTagNameNS(MAIN, 'pivotTableStyleInfo'))) {
      const name = pivotStyles.get(style.getAttribute('name')); if (name) style.setAttribute('name', name);
    }
    set(path, HEADER + serialize(node)); contentType(path, `${TYPES}pivotTable+xml`);
    addRel(path, 'pivotCacheDefinition', cache.path);
    if (!owner) standalone.push(tag('x15:pivotTableReference', { 'r:id': addRel('/xl/workbook.xml', 'pivotTable', path) }));
    else addRel(`/xl/worksheets/sheet${wb.sheets.indexOf(owner) + 1}.xml`, 'pivotTable', path);
  }
  if (cacheRefs.main.length) workbook = workbook.replace(/<(?:smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/, m => tag('pivotCaches', {}, cacheRefs.main.join('')) + m);
  const extensions = [];
  for (const scope of ['x14', 'x15']) if (cacheRefs[scope].length) extensions.push(tag('ext', { uri: CACHE_EXT[scope] },
    tag(`${scope}:pivotCaches`, { [`xmlns:${scope}`]: scope === 'x14' ? X14 : X15 }, cacheRefs[scope].join(''))));
  if (standalone.length) extensions.push(tag('ext', { uri: PIVOT_EXT }, tag('x15:pivotTableReferences', { 'xmlns:x15': X15 }, standalone.join(''))));
  if (extensions.length) workbook = workbook.includes('</extLst>') ? workbook.replace('</extLst>', extensions.join('') + '</extLst>') : workbook.replace('</workbook>', `<extLst>${extensions.join('')}</extLst></workbook>`);
  if (pivots.connections && !wb.dataModel) {
    set('/xl/connections.xml', pivots.connections); contentType('/xl/connections.xml', `${TYPES}connections+xml`);
    addRel('/xl/workbook.xml', 'connections', '/xl/connections.xml');
  }
  return workbook;
}
