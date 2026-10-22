import { readNativePivotSlicerBinding, readSlicerHideNoData } from './native-pivot-slicer-state.js';
import { worksheetMetadataXml } from './xlsx-worksheet-metadata.js';
import { readXlsxPivots } from './xlsx-pivots.js';
import { resolveNativePivotSlicers } from './native-pivot-slicer.js';
import { decodeXlsxString } from './xlsx-string.js';
import { readSlicerDrawing } from './slicer-drawing.js';
import { readSlicerStyles } from './slicer-styles.js';
import { decodeModelXml, parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SLICER_REL = 'http://schemas.microsoft.com/office/2007/relationships';
const kids = (node, name, ns = MAIN) => modelChildren(node, name, ns);
const fail = message => { throw new Error(`Invalid native slicer: ${message}`); };
const one = (nodes, name) => { if (nodes.length !== 1) fail(`missing or ambiguous ${name}`); return nodes[0]; };
const key = name => name.toUpperCase();
const name = (node, attr) => {
  const value = decodeXlsxString(node.getAttribute(attr));
  if (!value || value.length > 65534 || [...value].length > 32767) fail(attr);
  return value;
};
const uint = (node, attr, fallback, max = 4294967295, min = 0) => {
  if (!node.hasAttribute(attr) && fallback !== undefined) return fallback;
  const value = node.getAttribute(attr)?.trim();
  if (!/^\+?\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(attr);
  return Number(value);
};
const bool = (node, attr, fallback) => {
  if (!node.hasAttribute(attr)) return fallback;
  const value = node.getAttribute(attr).trim();
  if (!['true', 'false', '1', '0'].includes(value)) fail(attr);
  return value === 'true' || value === '1';
};
const choice = (node, attr, values, fallback) => {
  if (!node.hasAttribute(attr)) return fallback;
  const value = node.getAttribute(attr);
  if (!values.includes(value)) fail(attr);
  return value;
};
const extensions = (root, localName, namespaces) => kids(root, 'extLst').flatMap(list => kids(list, 'ext'))
  .flatMap(ext => namespaces.flatMap(ns => kids(ext, localName, ns)));
function resolve(owner, target) {
  if (!target || /[\\?#\u0000-\u0020]|^[a-z][\w+.-]*:|^\/\//i.test(target)) fail('relationship target');
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) fail('relationship target'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

/** Read the package's declared slicer caches and worksheet views. Table-column
 * IDs are identities, not offsets (MS-XLSX 2.6.97). This metadata service does
 * not yet render a control, change filters, or serialize slicers into a new
 * workbook. Pivot caches remain explicitly distinguished from table bindings.
 * With `unsupported`, a PivotTable slicer whose binding cannot be resolved is told to it and left
 * unbound rather than refusing the package.
 */
export function readXlsxSlicers(book, { unsupported = null } = {}) {
  const roots = new Map(); let total = 0, worksheetBytes = 0;
  const root = (part, optional = false, worksheet = false) => {
    if (roots.has(part)) return roots.get(part);
    const bytes = book.files?.[part]?.content;
    if (!bytes) { if (optional) return null; fail(`missing part ${part}`); }
    if (worksheet && (worksheetBytes += bytes.length) > 512 * 1048576) fail('worksheet size limit');
    let xml = decodeModelXml(bytes, worksheet ? 256 * 1048576 : 16 * 1048576).xml;
    if (worksheet) xml = worksheetMetadataXml(xml, ['tableParts', 'drawing', 'extLst']);
    if ((total += worksheet ? xml.length : bytes.length) > 64 * 1048576) fail('metadata size limit');
    const node = parseModelXml(xml); roots.set(part, node); return node;
  };
  const related = (owner, id, type) => {
    if (!id) fail('relationship identifier');
    const relPath = owner.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');
    const relationships = root(relPath);
    if (relationships.namespaceURI !== PACKAGE || relationships.localName !== 'Relationships') fail('relationships root');
    const rel = one(kids(relationships, 'Relationship', PACKAGE).filter(n => n.getAttribute('Id') === id), 'relationship');
    if (rel.getAttribute('Type') !== type || rel.hasAttribute('TargetMode') && rel.getAttribute('TargetMode') !== 'Internal') fail('relationship type or mode');
    return resolve(owner, rel.getAttribute('Target'));
  };
  const checked = (part, localName, ns) => {
    const node = root(part, false, localName === 'worksheet');
    if (node.localName !== localName || node.namespaceURI !== ns) fail(`${localName} root`);
    return node;
  };
  const workbookPart = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml';
  const workbook = root(workbookPart, true);
  if (!workbook) return null;
  if (workbook.localName !== 'workbook' || workbook.namespaceURI !== MAIN) fail('workbook root');
  const cacheRefs = extensions(workbook, 'slicerCaches', [X14, X15]).flatMap(n => kids(n, 'slicerCache', X14));
  const caches = [], byName = new Map();
  for (const ref of cacheRefs) {
    const part = related(workbookPart, ref.getAttributeNS(REL, 'id'), `${SLICER_REL}/slicerCache`);
    const node = checked(part, 'slicerCacheDefinition', X14), cacheName = name(node, 'name');
    if (byName.has(key(cacheName))) fail('duplicate cache name');
    const bindings = kids(node, 'extLst', X14).flatMap(list => kids(list, 'ext')).flatMap(ext => kids(ext, 'tableSlicerCache', X15));
    if (bindings.length > 1) fail('duplicate table binding');
    const binding = bindings[0];
    const cache = { name: cacheName, part, sourceName: name(node, 'sourceName'), xml: standaloneModelXml(node), kind: binding ? 'table' : 'pivot', hideItemsWithNoData: readSlicerHideNoData(node) };
    if (binding) {
      cache.tableId = uint(binding, 'tableId'); cache.columnId = uint(binding, 'column');
      cache.sortOrder = choice(binding, 'sortOrder', ['ascending', 'descending'], 'ascending');
      cache.customListSort = bool(binding, 'customListSort', true);
      cache.crossFilter = choice(binding, 'crossFilter', ['showItemsWithDataAtTop', 'showItemsWithNoData', 'none'], 'showItemsWithDataAtTop');
    } else Object.assign(cache, readNativePivotSlicerBinding(node));
    caches.push(cache); byName.set(key(cacheName), cache);
  }
  const tables = new Map(), views = [], viewNames = new Set();
  for (const sheet of kids(one(kids(workbook, 'sheets'), 'sheets'), 'sheet')) {
    const owner = name(sheet, 'name');
    // Only worksheets own table slicers; chartsheets can coexist in the book.
    const relPath = workbookPart.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');
    const ref = one(kids(root(relPath), 'Relationship', PACKAGE).filter(n => n.getAttribute('Id') === sheet.getAttributeNS(REL, 'id')), 'sheet relationship');
    if (ref.getAttribute('Type') !== `${REL}/worksheet`) continue;
    const sheetPart = related(workbookPart, sheet.getAttributeNS(REL, 'id'), `${REL}/worksheet`), worksheet = checked(sheetPart, 'worksheet', MAIN);
    for (const tableRef of kids(worksheet, 'tableParts').flatMap(n => kids(n, 'tablePart'))) {
      const part = related(sheetPart, tableRef.getAttributeNS(REL, 'id'), `${REL}/table`), node = checked(part, 'table', MAIN), id = uint(node, 'id');
      if (tables.has(id)) fail('duplicate table id');
      const columns = kids(one(kids(node, 'tableColumns'), 'tableColumns'), 'tableColumn').map((c, index) => ({ id: uint(c, 'id'), name: name(c, 'name'), index }));
      if (new Set(columns.map(c => c.id)).size !== columns.length) fail('duplicate table column id');
      tables.set(id, { part, sheet: owner, name: name(node, 'name'), columns });
    }
    for (const list of extensions(worksheet, 'slicerList', [X14])) {
      const ref = one(kids(list, 'slicer', X14), 'slicer part reference');
      const part = related(sheetPart, ref.getAttributeNS(REL, 'id'), `${SLICER_REL}/slicer`), slicers = checked(part, 'slicers', X14);
      for (const node of kids(slicers, 'slicer', X14)) {
        const viewName = name(node, 'name'), cacheName = name(node, 'cache'), cache = byName.get(key(cacheName));
        if (viewNames.has(key(viewName))) fail('duplicate slicer name');
        if (!cache) fail('missing slicer cache');
        if (cache.kind === 'table' && node.hasAttribute('level')) fail('table slicer OLAP level');
        if (node.hasAttribute('caption') && !node.getAttribute('caption')) fail('caption');
        views.push({ name: viewName, cache: cache.name, owner, part, xml: standaloneModelXml(node),
          caption: decodeXlsxString(node.getAttribute('caption')), style: decodeXlsxString(node.getAttribute('style')),
          startItem: uint(node, 'startItem', 0), columnCount: uint(node, 'columnCount', 1, 20000, 1), rowHeight: uint(node, 'rowHeight'),
          showCaption: bool(node, 'showCaption', true), lockedPosition: bool(node, 'lockedPosition', false) });
        viewNames.add(key(viewName));
      }
    }
    const owned = views.filter(view => view.owner === owner);
    for (const view of owned) view.drawing = null;
    if (owned.length) for (const ref of kids(worksheet, 'drawing')) {
      const part = related(sheetPart, ref.getAttributeNS(REL, 'id'), `${REL}/drawing`);
      for (const drawing of readSlicerDrawing(root(part))) {
        const view = one(owned.filter(view => key(view.name) === key(drawing.name)), 'drawing slicer view');
        if (view.drawing) fail('duplicate slicer drawing');
        view.drawing = { ...drawing, part };
      }
    }
  }
  for (const cache of caches) if (cache.kind === 'table') {
    const table = tables.get(cache.tableId);
    if (!table) fail('missing source table');
    const column = one(table.columns.filter(c => c.id === cache.columnId), 'source table column');
    cache.table = { part: table.part, sheet: table.sheet, name: table.name, column: { ...column } };
  }
  const tabular = caches.filter(cache => cache.kind === 'pivot' && cache.pivotCacheId != null);
  if (tabular.length) {
    const sheets = kids(one(kids(workbook, 'sheets'), 'sheets'), 'sheet').map(sheet => ({
      id: String(uint(sheet, 'sheetId')), tabId: uint(sheet, 'sheetId'), name: name(sheet, 'name'),
    }));
    const pivots = readXlsxPivots(book, { sheetByName: value => value == null ? null : sheets.find(sheet => key(sheet.name) === key(decodeXlsxString(value))) });
    for (const [cache, pivot] of resolveNativePivotSlicers(tabular, pivots, sheets, { unsupported })) cache.pivot = pivot;
  }
  if (!caches.length && !views.length) return null;
  const relationships = root(workbookPart.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels'));
  const styleRefs = kids(relationships, 'Relationship', PACKAGE).filter(n => n.getAttribute('Type') === `${REL}/styles`);
  if (styleRefs.length > 1) fail('ambiguous styles relationship');
  const styleRoot = styleRefs.length ? root(related(workbookPart, styleRefs[0].getAttribute('Id'), `${REL}/styles`)) : null;
  const styles = readSlicerStyles(styleRoot, views.map(view => view.style));
  return { caches, views, ...styles };
}
