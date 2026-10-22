import { parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';
import { parseRefText } from './refs.js';
import { nativePivotItemValue, nativePivotFieldGroup } from './native-pivot-cache.js';
import { decodeXlsxString } from './xlsx-string.js';
import { modelConnectionId } from './data-model-bindings.js';

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const children = (node, name) => modelChildren(node, name, MAIN);
const child = (node, name) => children(node, name)[0];
const elements = node => Array.from(node?.childNodes || []).filter(n => n.nodeType === 1 && n.namespaceURI === MAIN);
const flag = (node, name, fallback = false) => {
  if (!node?.hasAttribute(name)) return fallback;
  const value = node.getAttribute(name).trim();
  if (!['0', '1', 'false', 'true'].includes(value)) throw new Error(`Invalid pivot ${name}`);
  return value === '1' || value === 'true';
};
function integer(node, name, fallback = null, min = 0) {
  if (!node?.hasAttribute(name)) return fallback;
  const value = node.getAttribute(name);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`Invalid pivot ${name}`);
  return Number(value);
}
function list(node, name) {
  const values = children(node, name), count = integer(node, 'count');
  if (count != null && count !== values.length) throw new Error('Inconsistent pivot collection count');
  return values;
}
function sortScope(field) {
  const scopes = children(field, 'autoSortScope');
  if (scopes.length > 1) throw new Error('Duplicate pivot automatic sorting scope');
  return scopes.length ? standaloneModelXml(scopes[0]) : null;
}

/** Decode the persisted layout, including compressed row/column item prefixes.
 * This describes the cached report. It does not claim to rebuild its members,
 * sorting, filters or drill state after source data changes.
 */
export function readNativePivotLayout(pivot, cache) {
  const root = parseModelXml(pivot.xml), source = parseModelXml(cache.xml);
  if (root.namespaceURI !== MAIN || root.localName !== 'pivotTableDefinition'
    || source.namespaceURI !== MAIN || source.localName !== 'pivotCacheDefinition') throw new Error('Invalid native pivot definition');
  const location = child(root, 'location'), range = parseRefText(pivot.ref || location?.getAttribute('ref') || '');
  if (!range || !['cell', 'range'].includes(range.kind)) throw new Error('Invalid pivot location');
  const cacheFields = list(child(source, 'cacheFields'), 'cacheField').map((field, index) => {
    const shared = child(field, 'sharedItems'), items = elements(shared).map(node => ({ ...nativePivotItemValue(node),
      ...(node.hasAttribute('c') ? { caption: decodeXlsxString(node.getAttribute('c')) } : {}) })), count = integer(shared, 'count');
    if (count != null && count !== items.length) throw new Error('Inconsistent pivot shared item count');
    // A field grouped by month (say): the report's items are its groups, as in the cache's records.
    const group = nativePivotFieldGroup(field, index, items);
    return { name: decodeXlsxString(field.getAttribute('name')),
      ...(field.hasAttribute('caption') ? { caption: decodeXlsxString(field.getAttribute('caption')) } : {}),
      hierarchy: integer(field, 'hierarchy', 0), level: integer(field, 'level', 0), items: group ? group.items : items };
  });
  const fields = list(child(root, 'pivotFields'), 'pivotField').map(field => ({ axis: field.getAttribute('axis'),
    caption: field.hasAttribute('name') ? decodeXlsxString(field.getAttribute('name')) : null,
    subtotalCaption: field.hasAttribute('subtotalCaption') ? decodeXlsxString(field.getAttribute('subtotalCaption')) : null,
    numFmtId: integer(field, 'numFmtId'),
    fillDownLabels: flag(field.getElementsByTagNameNS(X14, 'pivotField')[0], 'fillDownLabels'),
    multipleItemSelectionAllowed: flag(field, 'multipleItemSelectionAllowed'), autoShow: flag(field, 'autoShow'),
    compact: flag(field, 'compact', true), outline: flag(field, 'outline', true),
    subtotalTop: flag(field, 'subtotalTop', true), defaultSubtotal: flag(field, 'defaultSubtotal', true),
    insertBlankRow: flag(field, 'insertBlankRow'), showAll: flag(field, 'showAll', true),
    sortType: field.getAttribute('sortType') || 'manual', autoSort: !!child(field, 'autoSortScope'),
    sortScope: sortScope(field),
    subtotals: [['sum', 'sumSubtotal'], ['countA', 'countASubtotal'], ['avg', 'avgSubtotal'], ['max', 'maxSubtotal'],
      ['min', 'minSubtotal'], ['product', 'productSubtotal'], ['count', 'countSubtotal'], ['stdDev', 'stdDevSubtotal'],
      ['stdDevP', 'stdDevPSubtotal'], ['var', 'varSubtotal'], ['varP', 'varPSubtotal']].filter(([, attr]) => flag(field, attr)).map(([name]) => name),
    items: list(child(field, 'items'), 'item').map(item => ({
      ...(item.hasAttribute('n') ? { caption: decodeXlsxString(item.getAttribute('n')) } : {}), type: item.getAttribute('t') || 'data', index: integer(item, 'x'),
      hidden: flag(item, 'h'), details: flag(item, 'sd', true), drillAcross: flag(item, 'e', true),
      ...(item.hasAttribute('s') ? { selected: flag(item, 's') } : {}) })) }));
  if (fields.length !== cacheFields.length) throw new Error('Inconsistent pivot field count');
  const measures = list(child(root, 'dataFields'), 'dataField').map(field => {
    const index = integer(field, 'fld');
    if (index == null || !cacheFields[index]) throw new Error('Invalid pivot data field');
    return { field: index, numFmtId: integer(field, 'numFmtId'), caption: field.hasAttribute('name') ? decodeXlsxString(field.getAttribute('name')) : null, subtotal: field.getAttribute('subtotal') || 'sum',
      showDataAs: field.getAttribute('showDataAs') || 'normal', baseField: integer(field, 'baseField', -1, -1), baseItem: integer(field, 'baseItem') };
  });
  const hierarchies = list(child(source, 'cacheHierarchies'), 'cacheHierarchy').map(h => ({
    name: h.getAttribute('uniqueName'), table: h.getAttribute('dimensionUniqueName'), measureGroup: h.getAttribute('measureGroup'),
    attribute: flag(h, 'attribute'), measure: flag(h, 'measure'),
    ...(h.hasAttribute('defaultMemberUniqueName') ? { defaultMember: h.getAttribute('defaultMemberUniqueName') } : {}),
    ...(h.hasAttribute('allUniqueName') ? { allMember: h.getAttribute('allUniqueName') } : {}),
    ...(child(h, 'fieldsUsage') ? { fieldsUsage: list(child(h, 'fieldsUsage'), 'fieldUsage').map(n => integer(n, 'x', null, -1)) } : {}),
    ...(child(h, 'groupLevels') ? { grouped: true } : {}),
  }));
  const olapHierarchies = list(child(root, 'pivotHierarchies'), 'pivotHierarchy').map(h => ({
    includeNewItems: flag(h, 'includeNewItemsInFilter'),
    hasMemberFilters: children(h, 'members').length > 0,
  }));
  const axis = name => {
    const indexes = list(child(root, `${name}Fields`), 'field').map(n => {
      const index = integer(n, 'x', null, -2);
      if (index !== -2 && (index == null || !fields[index])) throw new Error('Invalid pivot axis field');
      return index;
    });
    let previous = [];
    const items = list(child(root, `${name}Items`), 'i').map(item => {
      const repeat = integer(item, 'r', 0), type = item.getAttribute('t') || 'data', measure = integer(item, 'i', 0);
      if (repeat > previous.length || repeat > indexes.length) throw new Error('Invalid repeated pivot prefix');
      const values = [...previous.slice(0, repeat), ...children(item, 'x').map(x => integer(x, 'v', 0))];
      // A grand-total marker has a dummy x, even on a fieldless axis.
      if (values.length > Math.max(1, indexes.length)) throw new Error('Too many pivot axis items');
      previous = values;
      const members = type === 'grand' || type === 'blank' ? [] : values.flatMap((value, position) => {
        const field = indexes[position];
        if (field == null || field === -2) return [];
        const item = fields[field].items[value];
        if (!item) throw new Error('Invalid pivot field item index');
        if (item.type !== 'data') return [{ field, type: 'subtotal', aggregation: item.type }];
        const shared = cacheFields[field].items[item.index];
        if (!shared || item.index == null) throw new Error('Invalid pivot shared item index');
        return [{ field, item: value, index: item.index, ...shared }];
      });
      return { type, measure, members };
    });
    return { fields: indexes, items: items.length || indexes.length ? items : [{ type: 'data', measure: 0, members: [] }] };
  };
  const cacheSource = child(source, 'cacheSource');
  const pageFields = list(child(root, 'pageFields'), 'pageField').map(page => {
    const field = integer(page, 'fld'), item = integer(page, 'item');
    if (field == null || !fields[field]) throw new Error('Invalid pivot page field');
    return { field, item };
  });
  return { name: pivot.name, owner: pivot.owner, range, firstHeaderRow: integer(location, 'firstHeaderRow', 0),
    showHeaders: flag(root, 'showHeaders', true), rowGrandTotals: flag(root, 'rowGrandTotals', true), colGrandTotals: flag(root, 'colGrandTotals', true),
    showEmptyRow: flag(root, 'showEmptyRow'), showEmptyCol: flag(root, 'showEmptyCol'),
    visualTotals: flag(root, 'visualTotals', true),
    firstDataRow: integer(location, 'firstDataRow', 0),
    firstDataCol: integer(location, 'firstDataCol', 0), sourceType: cacheSource?.getAttribute('type'),
    indent: integer(root, 'indent', 1), mergeItem: flag(root, 'mergeItem'),
    // MS-OI29500 2.1.787(o): Office preserves on true and discards on false,
    // reversing the original standard's description of this attribute.
    preserveFormatting: flag(root, 'preserveFormatting', true),
    grandTotalCaption: root.hasAttribute('grandTotalCaption') ? decodeXlsxString(root.getAttribute('grandTotalCaption')) : null,
    rowHeaderCaption: root.hasAttribute('rowHeaderCaption') ? decodeXlsxString(root.getAttribute('rowHeaderCaption')) : null,
    hasCalculatedItems: children(child(source, 'calculatedItems'), 'calculatedItem').length > 0,
    subtotalHiddenItems: flag(root, 'subtotalHiddenItems'),
    pageFields, hasAdvancedFilters: children(child(root, 'filters'), 'filter').length > 0,
    showMissing: flag(root, 'showMissing', true), missingCaption: decodeXlsxString(root.getAttribute('missingCaption')) || '',
    showError: flag(root, 'showError'), errorCaption: decodeXlsxString(root.getAttribute('errorCaption')) || '',
    // CT_CacheSource defaults an omitted connectionId to zero; an explicitly
    // empty attribute is invalid and must not acquire that default.
    connectionId: cacheSource?.getAttribute('connectionId') ?? '0', fields, cacheFields, measures, hierarchies,
    ...(olapHierarchies.length ? { olapHierarchies } : {}), rows: axis('row'), columns: axis('col') };
}

/** Enumerate the existing value cells without allocating a dense cross product.
 * Filters refer to typed shared values, not the visible worksheet captions.
 */
export function* nativePivotValueContexts(layout, { maxCells = 1048576 } = {}) {
  const rows = layout.rows, columns = layout.columns, onRows = rows.fields.includes(-2), onColumns = columns.fields.includes(-2);
  if (!Number.isSafeInteger(maxCells) || maxCells < 0 || rows.items.length * columns.items.length > maxCells) throw new Error('Pivot context limit exceeded');
  if (onRows && onColumns || layout.measures.length > 1 && !onRows && !onColumns) throw new Error('Ambiguous pivot measure axis');
  if (!layout.measures.length) return;
  if (layout.range.r1 + layout.firstDataRow + rows.items.length - 1 > layout.range.r2
    || layout.range.c1 + layout.firstDataCol + columns.items.length - 1 > layout.range.c2) throw new Error('Pivot items exceed report location');
  for (const [r, row] of rows.items.entries()) for (const [c, column] of columns.items.entries()) {
    if (row.type === 'blank' || column.type === 'blank') continue;
    const measure = layout.measures[onRows ? row.measure : onColumns ? column.measure : 0];
    if (!measure) throw new Error('Invalid pivot measure index');
    yield { r: layout.range.r1 + layout.firstDataRow + r, c: layout.range.c1 + layout.firstDataCol + c,
      rowType: row.type, columnType: column.type, measure,
      members: [...row.members, ...column.members] };
  }
}

/** Bracket-quoted MDX names are identities; a dot or ] within a name is data. */
export function pivotUniqueName(text) {
  if (typeof text !== 'string') throw new Error('Invalid pivot unique name');
  const parts = []; let at = 0;
  while (at < text.length) {
    if (text[at++] !== '[') throw new Error('Unsupported pivot unique name');
    let name = '', ended = false;
    while (at < text.length) {
      const c = text[at++];
      if (c !== ']') { name += c; continue; }
      if (text[at] === ']') { name += ']'; at++; continue; }
      ended = true; break;
    }
    if (!ended || !name) throw new Error('Invalid pivot unique name');
    parts.push(name);
    if (at < text.length && (text[at++] !== '.' || at === text.length)) throw new Error('Invalid pivot unique name');
  }
  if (!parts.length) throw new Error('Invalid pivot unique name');
  return parts;
}

/** Bind a persisted value-cell context to explicitly declared model identities.
 * Consumers must still implement model collation, filter/relationship semantics,
 * show-values-as calculations and layout regeneration before claiming refresh.
 */
export function nativePivotModelContext(layout, context, schema) {
  const key = value => String(value).normalize('NFC').toUpperCase();
  const unique = (items, label) => { if (items.length !== 1) throw new Error(`Missing or ambiguous pivot ${label}`); return items[0]; };
  const connectionId = modelConnectionId(layout.connectionId);
  if (connectionId === null) throw new Error('Invalid pivot connection ID');
  const connection = unique(schema.bindings.connections.filter(c => modelConnectionId(c.id) === connectionId), 'connection');
  if (layout.sourceType !== 'external' || !connection.model) throw new Error('Pivot source is not the workbook Data Model');
  const hierarchy = layout.hierarchies[layout.cacheFields[context.measure.field].hierarchy];
  if (!hierarchy?.measure || !hierarchy.measureGroup) throw new Error('Missing pivot measure hierarchy');
  const parts = pivotUniqueName(hierarchy.name);
  if (parts.length !== 2 || key(parts[0]) !== 'MEASURES') throw new Error('Unsupported pivot measure identity');
  const table = unique(schema.tables.filter(t => key(t.id) === key(hierarchy.measureGroup)), 'measure table');
  const declarations = schema.scripts.flatMap(s => s.commands.flatMap(c => c.measures));
  const measure = unique(declarations.filter(m => key(m.name) === key(parts[1]) && [key(table.id), key(table.name)].includes(key(m.table))), 'measure declaration');
  const filters = context.members.filter(m => ['string', 'number', 'boolean', 'blank', 'date', 'error'].includes(m.type)).map(member => {
    const field = layout.cacheFields[member.field], hierarchy = layout.hierarchies[field.hierarchy];
    if (!hierarchy?.attribute || hierarchy.measure) throw new Error('Unsupported pivot member hierarchy');
    const parts = pivotUniqueName(hierarchy.name), dimension = pivotUniqueName(hierarchy.table);
    if (parts.length !== 2 || dimension.length !== 1 || key(parts[0]) !== key(dimension[0])) throw new Error('Unsupported pivot attribute identity');
    const table = unique(schema.tables.filter(t => key(t.id) === key(parts[0]) || key(t.name) === key(parts[0])), 'member table');
    const column = unique(table.columns.filter(c => key(c.id) === key(parts[1]) || key(c.name) === key(parts[1])), 'member column');
    return { table: table.id, column: column.name, type: member.type, value: member.value };
  });
  return { table: table.id, measure: measure.name, expression: measure.expression, filters, rowType: context.rowType,
    columnType: context.columnType, subtotal: context.measure.subtotal, showDataAs: context.measure.showDataAs };
}

/**
 * GETPIVOTDATA over a saved report: the value cell of the measure named `dataField` (its caption, "Sum of Trips",
 * or its source field's name, "Trips") whose row and column items are the `pairs` given, [field name, item] each,
 * every other row and column field at its total, as Excel reads them. The field names say which axis an item is
 * looked for on, so a city that is both a row and a column item is found where it was asked for. { r, c }, or null
 * when the report has no such cell.
 */
export function nativePivotDataCell(layout, dataField, pairs) {
  const key = v => String(v ?? '').trim().toLowerCase();
  const name = key(dataField);
  const names = i => [layout.cacheFields[i]?.name, layout.fields[i]?.caption].filter(n => n != null).map(key);
  const wanted = [];
  for (const [field, item] of pairs) {
    const index = layout.cacheFields.findIndex((_, i) => names(i).includes(key(field)));
    if (index < 0 || wanted.some(w => w.index === index)) return null;
    wanted.push({ index, item });
  }
  const serial = iso => Date.parse(`${iso}${/Z|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'}`) / 86400000 + 25569;
  const matches = (member, item) => {
    if (member.value == null) return item == null || key(item) === '' || key(item) === '(blank)';
    if (typeof item === 'number') {
      const value = member.type === 'date' ? serial(member.value) : member.value;
      return typeof value === 'number' && Number(value.toPrecision(15)) === Number(item.toPrecision(15));
    }
    return key(member.caption ?? member.value) === key(item) || key(member.value) === key(item);
  };
  const measureNamed = m => !!m && (key(m.caption) === name || names(m.field).includes(name));
  const pick = (axis, onMeasures) => {
    const own = wanted.filter(w => axis.fields.includes(w.index));
    const index = axis.items.findIndex(item => {
      if (item.type === 'blank' || item.members.some(m => m.type === 'subtotal')) return false;
      if (onMeasures && !measureNamed(layout.measures[item.measure])) return false;
      return item.members.length === own.length && own.every(w => item.members.some(m => m.field === w.index && matches(m, w.item)));
    });
    return { index, used: own.length };
  };
  const onRows = layout.rows.fields.includes(-2), onColumns = layout.columns.fields.includes(-2);
  if (!onRows && !onColumns && !measureNamed(layout.measures[0])) return null;
  const row = pick(layout.rows, onRows), column = pick(layout.columns, onColumns);
  // An item of a field on neither axis (a report filter) is not a cell of the report.
  if (row.index < 0 || column.index < 0 || row.used + column.used !== wanted.length) return null;
  return { r: layout.range.r1 + layout.firstDataRow + row.index, c: layout.range.c1 + layout.firstDataCol + column.index };
}
